# Changelog

All notable changes to PIPER are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pre-1.0, breaking changes may land in any `0.x` minor bump but will be flagged here.

## [0.4.1] — 2026-06-02

### Fixed — Sudo elevation

- Docker actions (`docker.ps`, `docker.logs`, `docker.inspect`,
  `docker.compose_ps`, `docker.compose_up`) now honor `ctx.elevation`, so a
  reactive sudo proposal on a "permission denied … Docker daemon socket"
  failure actually re-runs the command with `sudo` instead of erroring
  "approved sudo but resolved command lacks sudo".
- The Executor no longer proposes sudo for an action whose `buildCommand`
  ignores elevation: the reactive path skips the prompt (returning the original
  failure) and the proactive path refuses with a clear message, so an
  un-elevatable action never shows the confusing re-validation error.

## [0.4.0] — 2026-06-02

### Added — TUI / answer presentation

- Answers render as clean markdown-flavoured prose — bold cyan headings,
  `•` bullets, inline `**bold**` / `` `code` `` and dimmed `[ev-N]` citations —
  instead of colour-cycling per-paragraph bars that read as an alternating-row
  table. Parsing lives in a pure, unit-tested `report-markdown` module.
- The synthesizer renders metrics (disk per filesystem, memory, per-container
  resources, before/after values, …) as compact ASCII tables instead of prose,
  so aligned numbers are scannable at a glance. The verifier exempts table rows
  from the citation requirement; the `[ev-N]` citation sits in the row.
- Status bar collapsed to a single row: mascot, model name in light grey beside
  it, an inverse `HUMAN`/`YOLO` chip, then cost · tokens · credit.

### Added — Sudo elevation

- Gated `sudo` for any tier, read included: every elevated command requires
  explicit human approval before it runs. Silent privilege escalation is not
  possible.
- `defaultElevation: 'sudo'` on catalog actions: actions that almost always
  need root declare it once; the Executor resolves and gates it automatically.
- Session-only, environment-scoped `approve-remember`: one approval covers all
  subsequent identical `(environment, action)` sudo invocations in the same
  process. Never persisted to PGlite. A new session re-prompts.
- Path denylist extended to all path-valued args under any name: a string arg
  whose value starts with `/` or `~/` is checked against the denylist before
  the elevation prompt is shown, closing the `sudo cat <denied-path>` hole.
- Reactive sudo: a non-elevated permission-denied failure (`permission denied`,
  `must be root`, `operation not permitted`, etc.) triggers an elevation
  proposal to the TUI. The LLM does not decide — the gate offers, the human
  approves.
- `sudo -n` (non-interactive) first. On a password-required failure, an
  **interactive `ssh -tt` passthrough** (opt-in, per command): the user types
  the password on their own terminal via inherited stdio; the password never
  enters PIPER's buffers, evidence table, audit log, or model context.
- TUI sudo approval panel: distinct styling with SUDO badge, verbatim command
  shown, approve-once / approve-remember / reject choices.
- Double-confirm for `mutate+sudo`: two confirmation messages before an
  elevated mutation executes. Configurable via `sudo_double_confirm_mutate`
  (default `true`).
- `approve-remember` is disabled for `destructive+sudo`: elevated destructive
  actions prompt every time, consistent with the non-elevated destructive rule.

### Security — Sudo elevation

- Every sudo is gated and re-validated: after `buildCommand()` runs, the
  Executor checks the resolved argv actually carries `sudo` before spawning.
  A bug or tampering that drops the elevation between approval and execution is
  refused (`execution-failed`), not silently run as non-elevated.
- Password material never enters PIPER: `sudo -n` carries no password; the TTY
  passthrough uses inherited stdio, so no password transits PIPER's buffers,
  pre-LLM scrubber, audit log, or model messages.
- `destructive+sudo` is never remembered: `approve-remember` on a destructive
  action is silently downgraded to `approve-once`.
- Environment-scoped sudo keys: a remembered `staging` sudo does not fire on
  `prod` (re-matched on the resolved `(environment, actionName)` inside the
  Executor).

---

## [0.3.0] — 2026-06-01

### Added — Watch mode (M3a)

- `/watch` TUI command: list, start, and compile watch plans.
- Watch plans as skill-like markdown files (`~/.piper/watches/*.md`): YAML
  frontmatter checks + prose runbook fed to the LLM only on anomaly.
- Closed expectation DSL (7 kinds: `exit_zero`, `all_running`, `max_percent`,
  `min_count`, `regex_match`, `regex_absent`, `json_path_eq`), evaluated
  in-process — **zero LLM cost per tick**.
- Read-tier-only gate validation for watch plans: a plan naming a `mutate` or
  `destructive` action, an unknown action, or args that fail the action's
  `argsSchema` is rejected at load.
- Bundled stock plans: `docker-basics`, `k8s-basics`, `disk-and-memory`.
- NL → plan compiler with validation retry (cost-tracked).
- Anomaly policy: per-check debounce (2 consecutive failures) and cooldown
  (15 min).
- Automatic anomaly diagnosis through the agent runner (budget-guarded);
  remediation proposals go through the M2 approval flow. The watch loop never
  mutates on its own.
- `notify.desktop` catalog action (macOS / Linux desktop notifications via the
  audited Executor).
- Webhook notifications with metadata-only, scrubbed payloads (`https`-only,
  enforced at send time).
- `piper check <plan> [env]` one-shot CLI mode with meaningful exit codes
  (0 all-passed, 1 expectation failed, 2 check error, 3 plan not found) — for
  cron / CI.
- PGlite migration v3: `watch_runs`, `watch_check_results`, `watch_anomalies`
  tables.

### Changed — Watch mode (M3a)

- Bun engine requirement raised to `>= 1.3.0` (uses `Bun.YAML` to parse plan
  frontmatter).

### Security — Watch mode (M3a)

- AppleScript injection prevention in desktop notifications (layered
  sanitisation of plan/check names).
- Watch-plan prototype-pollution gate tests; check args are deep-frozen.
- All user-influenced text columns in the watch store are scrubbed before
  persistence.

### Fixed

- WASM embedder: model assets are cached on disk (`~/.piper/cache/models`)
  and download **once**, not on every boot. First-boot downloads now show a
  per-file progress bar (percentage + MB) instead of a frozen filename.

## [0.2.0] — 2026-05-29

### Added — TUI / UX

- Status bar moved to the bottom of the screen with: alien mascot `Y(◉ ◉)Y`
  color-cycling green / cyan / magenta / yellow while PIPER thinks, session
  title, running session cost (USD), current model id, OpenRouter remaining
  credit (live-fetched every 60s), token meter `N/limit (%)` with progress
  bar driven by the real `gpt-tokenizer` count, and a HUMAN/YOLO mode badge.
- **HUMAN / YOLO modes**, toggle with `Shift+Tab`. HUMAN asks for approval
  per planned step; YOLO auto-approves read-tier only. `mutate` and
  `destructive` tiers still always prompt, every time — the destructive gate
  is unaffected by mode.
- **`Ctrl+O`** collapses reasoning: hides agent-event lines (plan/gather/
  verify noise) from future turns, leaves user prompts and final answers
  visible.
- **`<Static>` scrollback persistence** (`src/tui/Chat.tsx`): full
  conversation history stays in the terminal's native scrollback, like
  Claude Code. Final answers stream line-by-line, append-only — no redraw.
- Final answer is **conversational chat-style** prose, not a "Findings /
  Gaps / Next steps" report. Inline `[ev-N]` citations preserved.
- **Soft verifier**: report passes if ≥75% of substantive lines are cited
  (was 100%); conclusion-style lines ("Non c'è …", "Nothing to flag", "If
  you want …") are exempted.
- **Best-of retry**: if a synthesis retry produces a worse answer than the
  original, surface the original.
- **Final-only default**: `maxFollowupIterations=0`. One prompt = one
  answer; ask a follow-up if you want more (no auto-iteration loop).

### Added — knowledge base / RAG

- In-process semantic memory layer over PGlite + pgvector, supporting
  knowledge kinds: `runbook`, `adr`, `session-summary`, `solved-case`,
  `note`.
- **Three embedding backends**, user-selectable on first run via interactive
  picker (and re-prompted if missing from credentials):
  - `wasm` (default, recommended): `@huggingface/transformers` running
    `Xenova/multilingual-e5-small` (384-dim, 94 languages, ~120 MB
    downloaded once then fully offline). Implementation:
    `src/rag/wasm-embedding-client.ts`. Lazy-loaded; cached at
    `~/.piper/cache/models/` so the compiled binary stays lean.
  - `http`: OpenAI-compatible local endpoint (Ollama `nomic-embed-text`
    768-dim, LM Studio, llama.cpp, vLLM).
  - `openrouter`: paid cloud embeddings — only offered if an API key is
    present, never auto-selected.
  - `none`: disables RAG entirely; `memory.search` returns empty.
- Choice persisted as `embedding_backend` in `~/.piper/credentials.json`;
  `PIPER_EMBEDDING_BACKEND` env var overrides.
- **Schema auto-migration on dimension mismatch**: switching e.g. from
  Ollama 768-dim to WASM 384-dim drops the vector table and rebuilds from
  source.
- **`memory.search` catalog action**: in-process (no shell, no SSH) action
  the planner calls to semantically search the knowledge base. The planner
  system prompt directs the agent to call it first for known incident
  patterns, deploy procedures, or hosts with prior session notes.

### Added — sessions and lifecycle

- **PGlite persistent storage by default** at `~/.piper/data/pglite/`
  (previously in-memory; sessions were lost on exit). Override with
  `PIPER_DATA_DIR`; force ephemeral with `PIPER_EPHEMERAL=1`.
- **Auto-generated session titles** via a small LLM call on the first user
  prompt; visible in the status bar and `/resume` picker.
- **Auto-saved reports**: every `done` writes the final answer to
  `~/.piper/data/reports/{sessionId}/run-{ts}.md`.
- **Resume**: `bun dev -- --resume` flag at startup (before the banner)
  opens the picker, and `/resume` does the same mid-session.
- **Token-aware auto-compaction**: triggers when the planner's context
  exceeds 70% of the model's `maxContextTokens` minus a 4k output reserve,
  measured with the real `gpt-tokenizer` cl100k_base encoder. Pending-
  message fallback at 12+ regular messages. Older turns roll into one
  summary message; the N most recent stay verbatim.

### Added — catalog

The read-tier catalog grew from 17 to 30+ actions. New entries:

- **git**: `git.status`, `git.log`.
- **Docker**: `docker.compose_ps`.
- **Network**: `network.dns_lookup`.
- **Kubernetes**: `kubernetes.get`, `kubernetes.logs`, `kubernetes.describe`,
  `kubernetes.top_pod`, `kubernetes.events`, `kubernetes.context_current`.
- **GitHub** (`gh` CLI): `github.pr_list`, `github.pr_view`,
  `github.run_list`, `github.run_view`, `github.issue_list`.
- **AWS**: `aws.s3_ls`, `aws.ec2_describe`, `aws.cloudwatch_tail`,
  `aws.rds_describe`.
- **GCP**: `gcp.compute_list`, `gcp.logging_read`.
- **Azure**: `azure.vm_list`.
- **System extras**: `system.cpu_info`, `system.cron_list`,
  `system.systemctl_list`, `system.iptables_list`, `system.dmesg`,
  `system.package_list`.
- **Database**: `postgres.pg_isready`.
- **Memory**: `memory.search` (in-process).

### Added — interactive pickers

- **`/model`** — interactive mid-session model picker
  (`src/tui/ModelPicker.tsx`) with two tabs:
  - **Local**: auto-detected Ollama / LM Studio / llama.cpp / vLLM servers
    and their available models.
  - **OpenRouter**: full filtered catalog from `/api/v1/models` — paid only,
    tool-calling only, moderated providers only, with PgUp/PgDn paging and
    inline text filter.
  - Selection persists to `~/.piper/credentials.json` for next run.
- **`/memory`** (aliases `/mem`, `/rag`) — knowledge-base viewer
  (`src/tui/MemoryViewer.tsx`) with two tabs:
  - **Overview**: counts per kind (runbook / adr / session-summary /
    solved-case / note).
  - **Sources**: per-file list; press `d` to delete a source.
- **`/resume`** — picker over recent sessions showing title, age, and
  message count; selecting reloads chat history into the scrollback.

### Changed — defaults and behaviour

- PIPER data is now persistent by default (`~/.piper/data/pglite/`). The
  previous in-memory default silently lost sessions; it remains available
  via `PIPER_EPHEMERAL=1`.
- Follow-up iteration loop disabled by default (`maxFollowupIterations=0`).
- Verifier strictness softened to 75% citation coverage on substantive
  lines, with conclusion-line exemption.

### Fixed

- **Cost meter showed `$0.0000`** even on real OpenRouter calls. The pricing
  lookup was using `client.id` (which carries the provider prefix) instead
  of `client.modelId` (the bare model id used in OpenRouter's pricing
  table). Now correctly resolves and accumulates per-call cost.

### Open-source hardening

- `LICENSE` finalised as Apache-2.0.
- `NOTICE` file added: Apache-2.0 transitive disclosures plus the LGPL
  transitive disclosure for `@img/sharp-libvips` (pulled in by the
  embedding pipeline).
- `license-checker` wired into CI; GPL transitive deps are rejected.
- Test suite: **388 unit + gate tests passing** (was 318 in the previous
  changelog entry).

## [0.1.0] — 2026-05-25

First public M1 release. Read-only diagnostics, conversational TUI, deterministic
gate.

### Added — security gate

- Catalog + Executor: every external command goes through one audited surface;
  the LLM cannot emit free-form shell.
- `HARD_PATH_DENYLIST` (12 patterns): blocks reads of SSH private keys,
  AWS/GCP/kube credentials, GnuPG, `.netrc`, `~/.piper/`,
  `.env*`, bare `id_rsa`/`id_ed25519`/etc.
- Secret scrubber with 13 pattern families: PEM private keys, JWT, AWS/OpenAI/
  Anthropic/OpenRouter/GitHub/Slack tokens, `Authorization` headers, DB connection
  strings, kv-secret heuristics, env-var heuristics. Two-pass: write-time
  (audit log + evidence) AND pre-LLM (model client).
- Args secret-refuse: the Executor rejects a proposed action whose args contain
  a recognisable secret (defends against laundering through tool calls).
- Three-tier permission model (`read | mutate | destructive`). M1 ships `read`
  only; `mutate` and `destructive` are explicitly refused by default.
- One-module-per-credential discipline: SSH keys live only in `src/exec/ssh.ts`;
  provider API keys live only in `src/models/client.ts`.

### Added — agent pipeline

- Plain async generator runner (`src/agent/runner.ts`): `plan → gather →
  synthesize → verify → propose → approve → loop` with explicit AgentEvent stream.
- Plan node: LLM-driven, emits structured tool calls validated against the
  catalog schema.
- Gather node: parallel `Promise.all` execution via the Executor; per-step
  failures don't abort the run.
- Synthesize node: streamed markdown report with inline `[ev-N]` citations.
- Verify node: deterministic — every substantive line in `## Findings` must
  cite a real evidence id; section-aware (`## Gaps`, `## Next steps` exempt).
- Propose node: separate LLM call with tools wired (fixes role confusion seen
  on smaller models that otherwise emit preambles instead of reports).
- Inline JSON fallback: parses follow-up proposals from a trailing ```json
  code block when a model doesn't reliably use `tool_calls`.
- Conversation history persisted to PGlite; planner sees the last 6 turns
  verbatim → multi-turn continuity ("ora controlla la memoria").
- Follow-up proposal loop with explicit human approval per iteration, max 2
  iterations by default, configurable per session.

### Added — TUI (Ink)

- Streaming live report in the chat history.
- Multi-turn entries scroll naturally (no fixed "last report" slot).
- Bordered input panel — clear visual identity for where you type.
- Slash commands: `/env add|list|remove`, `/help`, `/save`, `/quit`.
- Proposals panel: numbered list with `y / n / 1,3 / q` shortcuts.

### Added — first-run experience

- Interactive wizard auto-runs if `~/.piper/credentials.json` is missing AND no
  env vars provide the minimum config.
- Detects local LLM providers (Ollama, LM Studio, llama.cpp, vLLM) by probing
  standard ports.
- OpenRouter tier picker (Featherweight / Economy / Balanced / Premium) with
  current per-million-token pricing inline.
- Writes the credentials file with mode `0600`, dir mode `0700`.
- API-key shape validator: silently ignores garbage env vars (e.g. leftover
  `PIPER_API_KEY=ciao` from a test session).

### Added — builtin read actions

`ssh.connect`, `system.uptime`, `system.os_info`, `system.memory`,
`system.disk_usage`, `system.process_list`, `system.list_dir`,
`system.file_stat`, `network.connections`, `network.port_check`, `network.ping`,
`logs.tail`, `service.status`, `service.journal`, `docker.ps`, `docker.logs`,
`docker.inspect` — 17 actions total. Each with a Zod-validated argsSchema, argv
construction (no shell concatenation), and a result parser.

### Added — environments registry

- PGlite-backed registry: `name`, `host`, `ssh_user`, optional `port`,
  `identity_file`, `description`, `tags`.
- LLM-facing description (`describeForLLM`) → planner sees only registered
  environments.
- SSH allowlist by construction: an action with an `environment` arg can only
  resolve to a registered entry; unknown names are refused with
  `environment-not-found`.

### Added — cost layer

- Unified OpenAI-compatible `ModelClient` over OpenRouter, Ollama, LM Studio,
  llama.cpp, vLLM, and custom endpoints.
- `provider.data_collection: 'deny'` enforced on every OpenRouter request.
- Pre-call cost estimation (per-million-token table) with visibility threshold.
- Per-session budget guard with hard-stop `BudgetExceededError`.
- Local-tier models record zero cost; usage tokens still tracked.

### Added — testing

- 318 unit + gate tests, 0 fail (Vitest-style under Bun).
- 10 E2E tests via `bun run e2e` against an Alpine sshd Docker fixture with
  pinned host keys and generated test keypair.
- Two-pass typecheck (`tsc --noEmit`, strict + `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`).

### Added — distribution

- Single-binary build via `bun build --compile` (~76 MB Mach-O arm64 / Linux ELF).
- PostgreSQL WASM (~13 MB) and Yoga layout engine embedded.
- Boot in ~150 ms cold from the compiled binary.

### Known limitations (M1)

- No mutations (M2). Catalog refuses `mutate` and `destructive` by default.
- No RAG / pgvector yet (M4). Runbooks are not retrievable; the planner relies
  on the per-turn evidence + recent conversation.
- No history compaction yet. Long sessions push older turns out of the 6-turn
  planner window — they remain in PGlite, just not in the next prompt.
- Custom OpenAI-compatible endpoint flow is partial in the wizard; edit
  `~/.piper/credentials.json` by hand for now.

[0.1.0]: https://github.com/<your-org>/piper/releases/tag/v0.1.0
