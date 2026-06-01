# ADR-003 — Watch mode: deterministic loop, LLM only on anomaly

- **Status**: accepted (M3a)
- **Date**: 2026-06-01
- **Audience**: contributors, security reviewers
- **Supersedes**: nothing
- **Superseded by**: nothing

## Context

Continuous monitoring needs a loop: run a set of checks, on a cadence, and
react when something looks wrong. The naive way to add this to an LLM tool is
to wake the model on every tick and ask "is everything fine?". That design has
two fatal problems for PIPER:

1. **Recurring cost.** An LLM call per check per tick, running unattended for
   hours or days, is unbounded spend. A single watch with five checks at 30s
   intervals is ~14 000 model calls a day.
2. **Nondeterminism.** The same `df -h` output could be judged "fine" on one
   tick and "concerning" on the next, because the model is sampling. A monitor
   you cannot trust to be consistent is worse than no monitor.

PIPER's Prime Directive — the LLM proposes, deterministic code validates, the
human approves anything that mutates — must extend to **unattended** operation.
A watch loop running while nobody is looking is exactly the place where an
ungated, LLM-driven decision would do the most damage.

## Decision

Watch mode keeps the LLM out of the hot path entirely. The loop is
deterministic; the model is invoked only when a check has already, by
deterministic evaluation, failed.

1. **Checks are compiled once, evaluated in-process.** Each check pairs a
   read-tier catalog action with an expectation drawn from a **closed DSL** of
   seven kinds — `exit_zero`, `all_running`, `max_percent`, `min_count`,
   `regex_match`, `regex_absent`, `json_path_eq` (see
   `src/monitor/types.ts`). The DSL is evaluated by plain TypeScript in
   `src/monitor/expectations.ts`. **Zero LLM calls per tick.** The compilation
   step — turning a plain-English request into a plan — happens once, either by
   the LLM (the `/watch` compiler) or by a human writing the file by hand.

2. **Watch plans are skill-like markdown files.** A plan is a `.md` file with
   YAML frontmatter (`name`, `description`, `environment`, `checks`) and a
   markdown body that serves as the runbook. The frontmatter is parsed with
   `Bun.YAML.parse` and validated by Zod (`watchFrontmatterSchema`). The plan
   loader (`src/monitor/plan-loader.ts`) then validates every check against the
   live catalog: the referenced action must exist, must be **read-tier**, and
   the check's `args` must satisfy that action's `argsSchema`. A plan that
   names a `mutate` or `destructive` action, or an unknown action, is rejected
   at load time. User plans live in `~/.piper/watches/*.md`; three stock plans
   ship in source (`docker-basics`, `k8s-basics`, `disk-and-memory`).

3. **The LLM is invoked only on a confirmed anomaly.** A failing check does not
   immediately call the model. The anomaly policy (`src/monitor/anomaly-policy.ts`)
   **debounces** — it requires two consecutive failures before firing — and
   **cools down** — once fired for a check, it suppresses re-firing for 15
   minutes. Only when the policy fires does the diagnoser
   (`src/monitor/diagnose.ts`) run, and it is **budget-guarded**: if the
   estimated cost would breach the session budget, diagnosis is skipped, not
   forced. The diagnosis itself goes through the normal agent runner, so any
   remediation it proposes flows through the **existing M2 approval gate** —
   propose → dry-run → human approval → execute → verify → rollback. The watch
   loop never mutates anything on its own.

4. **Desktop notifications are a catalog action.** Notifying the user on
   anomaly means spawning `osascript` (macOS) or `notify-send` (Linux). All
   process spawning in PIPER goes through the Executor, so the notification is
   a read-tier catalog action (`notify.desktop`), not an inline `spawn`. This
   keeps the single-side-effect-module discipline intact and means the
   notification is audited like any other command.

5. **Webhook payloads are metadata-only.** Watch can POST to a webhook on
   anomaly (`src/notify/webhook.ts`). The payload carries only metadata — plan
   name, check name, expectation kind, timestamp — never the raw command output
   that triggered the anomaly. Raw evidence never leaves the machine through a
   webhook. The endpoint must be `https`; non-https schemes are refused at send
   time.

## Why the DSL is closed (and not a script)

The single most important property of watch mode is that a check cannot do
anything the catalog does not already permit. A check is `(read action, args) +
(expectation kind, params)`. Both halves are validated: the action against the
catalog, the expectation against the discriminated-union schema. There is no
escape hatch into arbitrary code. This is the same safety property as the main
gate (ADR-001), extended to unattended operation.

## Consequences

### Positive

- **Predictable cost.** The steady-state cost of a running watch is zero — no
  model calls until something is already, deterministically, wrong. Spend is
  bounded by the anomaly rate, the debounce, the cooldown, and the budget guard.
- **Auditable checks.** A watch plan is a reviewable text file. Anyone can read
  exactly what is being checked and what counts as healthy, without inspecting
  prompt behaviour.
- **Daemon-ready.** The scheduler (`src/monitor/scheduler.ts`) is TUI-agnostic:
  all I/O goes through injected deps, every event is persisted before it is
  yielded, and the loop stops cleanly on an `AbortSignal`. The same loop drives
  the TUI `/watch` panel and the `piper check` one-shot CLI.
- **The gate is unchanged.** Every check runs through the same Executor, the
  same catalog, the same scrubber. More monitoring surface does not mean more
  places to hallucinate into infrastructure.

### Negative

- **DSL expressiveness is limited by design.** The seven expectation kinds
  cover liveness, thresholds, counts, and presence/absence of patterns. They do
  **not** support joins or aggregations across checks ("alarm if check A fails
  *and* check B passes"), nor stateful conditions across ticks beyond the
  debounce counter. Cross-check correlation is left to the LLM diagnosis step,
  not the deterministic loop.
- **New expectation kinds need code changes.** Adding an eighth kind means
  editing the schema in `src/monitor/types.ts`, the evaluator in
  `src/monitor/expectations.ts`, and the tests — not editing a plan file. This
  is the intended trade-off: the closed DSL is what keeps checks safe and
  cheap.

## Alternatives rejected

### A. LLM per tick

Wake the model on every check and ask it to judge the output. **Rejected** —
unbounded recurring cost and per-tick nondeterminism. A monitor must be cheap
and consistent; an LLM in the hot loop is neither.

### B. External cron + shell scripts

Drop the loop entirely; let the user wire `piper check` (or raw CLI) into cron
and write their own alerting. **Rejected as the *primary* path** — it loses the
gate (scripts run arbitrary commands), loses grounding (no evidence-cited
diagnosis), and loses the audit trail. (`piper check` is still offered as a
one-shot mode *for* cron/CI, but it runs the same gated, catalog-bound checks —
it is not an escape hatch.)

### C. Turing-complete check scripts

Let a plan embed a small scripting language (or JS) to express arbitrary check
logic. **Rejected** — arbitrary code in a check defeats the catalog allowlist.
The entire safety argument of PIPER is that the LLM cannot invent a command;
allowing a plan to carry executable logic re-opens exactly that hole, just with
a different author. The closed DSL is the deliberate constraint.

## Verification

Watch-mode safety is enforced by tests under `tests/gate/` and
`tests/unit/monitor/`:

- A plan naming a `mutate` or `destructive` action → rejected at load.
- A plan whose check `args` fail the action's `argsSchema` → rejected at load.
- Prototype-pollution attempts in plan frontmatter → rejected; check args are
  deep-frozen.
- The anomaly policy fires only after `debounceFailures` consecutive failures
  and suppresses within `cooldownMs`.
- Stock plans validate against the real catalog (every referenced action exists
  and is read-tier).
- Desktop notification text is sanitised against AppleScript injection.
- Webhook payloads are scrubbed and metadata-only.
