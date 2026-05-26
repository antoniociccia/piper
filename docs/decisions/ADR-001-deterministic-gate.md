# ADR-001 — The deterministic gate is the product

- **Status**: accepted
- **Date**: 2026-05-25
- **Audience**: contributors, security reviewers
- **Supersedes**: nothing
- **Superseded by**: nothing

## Context

PIPER puts an LLM in front of real infrastructure. The LLM:

- is non-deterministic (a single token of difference can change output),
- can be manipulated by prompt-injection (a hostile log line can change behaviour),
- is opaque (no compile-time guarantees about what it will say next).

A naive design would let the LLM emit shell, JSON, or function calls and execute
them directly. That is the design pattern used by "agent frameworks" that
promise autonomy. It is also the design pattern that has produced every
high-profile LLM-agent incident in 2024–2026.

We refuse to ship that pattern.

## Decision

**The LLM never executes anything directly.** It selects from a fixed catalog
of typed actions. A deterministic gate validates each invocation before any
process spawns. The gate is the product.

Concretely, four interlocking constraints:

1. **Catalog allowlist.** The LLM can only invoke actions registered in
   `src/actions/builtin/`. Each action has a stable name (`logs.tail`,
   `system.uptime`), a Zod schema for its arguments, and a deterministic
   `buildCommand(args, ctx) → readonly string[]` that returns an argv vector
   (never a shell-joined string). New capabilities require code review of the
   catalog entry; the LLM cannot invent one.

2. **Single Executor.** All process spawning happens in
   `src/exec/executor.ts`. Nowhere else in `src/` is allowed to call `Bun.spawn`
   or shell out. CI enforces this with a code scan. The Executor:
   - Looks up the action by name; refuses if not in the catalog.
   - Validates args against the action's Zod schema; refuses on mismatch.
   - Runs `detectSecrets` on `JSON.stringify(args)`; if any recognisable secret
     pattern matches, the action is **refused, not redacted** (rationale below).
   - Checks `args.path` (if string) against the path denylist.
   - Checks `args.environment` (if string) against the registry; refuses
     unknown names.
   - Checks `action.tier` against `allowedTiers` (default `['read']` in M1).
   - Logs the verbatim (scrubbed) command to `audit_log`.
   - Spawns the process via `Bun.spawn` with a timeout.
   - Scrubs stdout/stderr, writes to `evidence`, returns the result.

3. **Two-pass scrub.** Every external output passes through
   `src/security/scrub.ts:scrubText` twice:
   - **Write-time scrub** before persistence to PGlite (`audit_log`, `evidence`).
     If our DB leaks, secrets aren't in it.
   - **Pre-LLM scrub** in `ModelClient.complete()` before any HTTP call leaves
     the host. If a write-time scrub missed a pattern, this catches it.

   The scrubber covers 13 pattern families (PEM, JWT, AWS, OpenAI/Anthropic/
   OpenRouter/GitHub/Slack tokens, `Authorization` headers, DB connection
   strings, kv-secret heuristics, env-var heuristics). User-supplied patterns
   can extend but cannot remove.

4. **Three permission tiers.** Actions are tagged `read | mutate | destructive`.
   M1 ships `read` only. `mutate` and `destructive` are refused at the gate
   today. When they land (M2), `mutate` will require explicit per-call approval
   OR a remembered allowlist rule re-matched against the *resolved* command at
   execution time. `destructive` will always require a fresh confirmation — no
   remembered rule, no exception.

## Why refuse rather than redact on `secret-in-args`

Two reasons:

1. **Semantic preservation.** A `logs.tail --grep <SECRET>` redacted to
   `--grep [REDACTED:kv-secret]` would silently run a different command
   than the LLM intended. The LLM's plan becomes incoherent. Refusing is
   the only behaviour where the gate stays predictable.

2. **Exfiltration prevention.** Without args-refuse, an LLM (or a
   prompt-injected LLM) could launder a secret it saw in an action's stdout
   by embedding it in the args of a subsequent action (e.g. `network.port_check
   <SECRET> 443`). The Executor's stdout scrubber wouldn't see it — the secret
   is in the `nc` command line itself, sent to a remote host PIPER's operator
   may not own.

## Consequences

### Pros

- The LLM has a bounded blast radius: it cannot exfiltrate, can't mutate
  without approval, can't read denied paths, can't free-form exec.
- Audit trail is complete and trustworthy. Every action and every refusal is
  in PGlite with a reason.
- Adding a capability is a code review of one Action entry — not a prompt tweak.
- Security review can focus on a small surface: `executor.ts`, `scrub.ts`,
  `paths.ts`, and the catalog itself. ~600 lines total.

### Cons

- The LLM's autonomy is limited by what's in the catalog. If you want PIPER
  to do something genuinely new, you write the action — not the prompt.
- Some natural LLM behaviour (e.g. "let me check that subdirectory") requires
  follow-up proposals + approval, which is more friction than autonomous exec.
- Every new action requires tests and a doc entry. Small overhead per capability.

## Alternatives considered

### A. Free-form shell, validated post-hoc

The LLM emits shell, a static analyser validates it before exec. **Rejected**:
no post-hoc analyser is strong enough on adversarial input. The set of "safe
shell" is not regular.

### B. Sandboxed exec (containers, gVisor)

Let the LLM exec anything, but inside a jail. **Rejected for M1**: containers
don't solve exfiltration (the LLM controls the request body, network egress is
the point), and they add operational complexity to a CLI tool.

### C. Higher-level agent frameworks (LangChain agents, AutoGen, CrewAI)

The framework wraps tool calling. **Rejected**: these frameworks hide what
gets executed behind abstractions. The deterministic gate must be auditable in
~600 lines, not buried in a dependency.

## Verification

The gate's behaviour is enforced by tests in `tests/gate/` and `tests/unit/security/`:

- Unknown action → refused.
- Action whose args fail the Zod schema → refused.
- Action whose args contain a recognised secret → refused (not redacted).
- Action whose `args.path` is in the denylist → refused.
- Action whose `args.environment` isn't in the registry → refused.
- Action whose `action.tier` isn't in `allowedTiers` → refused.
- Long-running action exceeding `timeoutMs` → killed with reason `timeout`.
- Every refusal AND every successful exec writes one row to `audit_log`
  with a typed `kind` and a `refused_reason`.

318 tests as of `0.1.0`. Adding a new gate failure mode goes hand in hand with
adding a test for it.
