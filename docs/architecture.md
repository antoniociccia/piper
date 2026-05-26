# PIPER Architecture

This document explains how PIPER is built — what each module does, how they
connect, and why the design draws certain hard lines. It is the technical
counterpart to the [README](../README.md) (which focuses on what PIPER does
for the user) and the [ADRs](decisions/) (which capture individual decisions).

---

## Prime directive: deterministic safety, then LLM

PIPER's core thesis is that you cannot prompt-engineer "no hallucinations" out
of an LLM. Instead, make being wrong **safe by construction**. The LLM lives
inside a deterministic cage:

1. The LLM never executes anything directly.
2. Every proposed action is a typed object from a fixed catalog, validated
   against a Zod schema.
3. A single Executor is the only code path that runs external commands; it
   logs the verbatim command, scrubs secrets, and refuses anything not in the
   catalog.
4. Read-only by default. Mutations (M2+) go through propose → dry-run → human
   approval → execute → verify → rollback-on-failure.

If the LLM hallucinates, the gate blocks it before it touches infrastructure.
That is the safety property — not a smarter prompt.

---

## High-level diagram

```
                ┌──────────────────────────────────────────────┐
                │                  User TUI (Ink)              │
                │   prompt input  •  report stream  •  approval│
                └──────────────────────┬───────────────────────┘
                                       │ AgentEvent stream
                                       ▼
   ┌───────────────────────────────────────────────────────────────┐
   │                       AgentRunner                              │
   │   plan ─► gather ─► synthesize ─► verify ─► (propose ─► OK)   │
   │           │            │                                       │
   │     tool_calls    grounded report (cited [ev-N])               │
   └───────────┬────────────────────────┬──────────────────────────┘
               │ ModelClient            │ Executor (the only exec surface)
               ▼                        ▼
       ┌───────────────┐        ┌──────────────────────────────────┐
       │  LLM provider │        │  catalog lookup • Zod validate    │
       │  (OAI-compat) │        │  args secret-refuse • path deny   │
       └───────────────┘        │  tier check • audit • scrub I/O   │
                                └──────────────┬───────────────────┘
                                               │
                                               ▼
                          ┌──────────────────────────────────────┐
                          │  kubectl • docker • ssh • nc • tail  │
                          │  ps • df • systemctl • ...           │
                          └──────────────────────────────────────┘
                                               │
                                               ▼
                                ┌────────────────────────────┐
                                │  PGlite (audit_log,         │
                                │  evidence, chat_messages,   │
                                │  sessions, rag_documents)   │
                                └────────────────────────────┘
```

The Executor is the bottleneck; everything outside it is "safe" because
nothing else can exec. The LLM emits only `tool_calls` against the catalog —
it cannot produce free-form shell, and it never sees raw process spawning
APIs.

---

## Modules

| Path                                  | Responsibility                                          |
|---------------------------------------|---------------------------------------------------------|
| `src/index.tsx`                       | Boot, first-run wizard, embedding-backend picker, Ink mount |
| `src/tui/App.tsx`                     | Ink root component, dispatcher loop, approval bridge   |
| `src/agent/runner.ts`                 | Agent state machine (`plan → gather → synthesize → verify`) |
| `src/agent/prompts.ts`                | Planner, synthesizer, and proposer system prompts      |
| `src/agent/verify.ts`                 | Deterministic citation verifier (every `[ev-N]` is real)|
| `src/agent/compactor.ts`              | Token-aware history compaction                         |
| `src/actions/catalog.ts`              | Action registry (lookup by name)                       |
| `src/actions/builtin/*.ts`            | Read-tier diagnostic actions (uptime, logs.tail, etc.) |
| `src/exec/executor.ts`                | The ONE place commands run; audit + scrub + refuse logic |
| `src/exec/ssh.ts`                     | SSH allowlist + `ssh -o BatchMode=yes` wrapper         |
| `src/security/paths.ts`               | Non-disablable path denylist                           |
| `src/security/scrub.ts`               | Two-pass secret scrubber (write-time + pre-LLM)        |
| `src/memory/db.ts`                    | PGlite + pgvector setup                                |
| `src/memory/chat-history.ts`          | Multi-turn conversation persistence                    |
| `src/memory/sessions.ts`              | Session metadata (title, `last_active_at`)             |
| `src/rag/wasm-embedding-client.ts`    | In-process WASM embedder (transformers.js)             |
| `src/rag/embedding-client.ts`         | Generic OpenAI-compatible embedder                     |
| `src/rag/ingest.ts`                   | Chunk + embed + `UPSERT` runbooks                      |
| `src/rag/retrieve.ts`                 | Cosine-similarity top-K query                          |
| `src/rag/ensure-schema.ts`            | Auto-recreate pgvector dim on model switch             |
| `src/models/client.ts`                | OpenAI-compatible HTTP client; only place API keys live |
| `src/models/cost.ts`                  | Per-session budget guard                               |
| `src/config/credentials.ts`           | `~/.piper/credentials.json` read                       |
| `src/config/persist.ts`               | `~/.piper/credentials.json` write (mode `0600`)        |

### Single-side-effect modules

Each kind of external effect has exactly one designated module. CI rejects
references to those effects from anywhere else:

- **Process exec** → `src/exec/executor.ts` (the only caller of `Bun.spawn`).
- **SSH** → `src/exec/ssh.ts` (the OS `ssh` binary holds the key, not PIPER).
- **LLM calls** → `src/models/client.ts` (the only place the API key header
  is set).
- **Secret scrubbing** → `src/security/scrub.ts` (called before any log
  write AND before any LLM message body).

If you need a new effect class, add a new dedicated module — never inline.

---

## Agent state machine

The runner is a plain async generator (see
[ADR-002](decisions/ADR-002-no-langgraph-yet.md) for why LangGraph is deferred
to M2). It yields a typed `AgentEvent` stream that the TUI consumes.

```
                ┌──────┐
        user ──►│ plan │  LLM call #1 — choose tool_calls from catalog
                └───┬──┘
                    │
                    ▼
                ┌────────┐
                │ gather │  Executor runs each tool call (read tier only)
                └───┬────┘  output → scrubbed → evidence table
                    │
                    ▼
              ┌───────────┐
              │synthesize │  LLM call #2 — write grounded markdown
              └─────┬─────┘  every claim cites [ev-N]
                    │
                    ▼
                ┌────────┐
                │ verify │  deterministic: every [ev-N] resolves
                └───┬────┘  to a real evidence row
                    │
                    ▼
              ┌───────────┐
              │  propose  │  LLM call #3 — suggest follow-up actions
              └─────┬─────┘  user accepts (y/1,3/q)  → loop back to gather
                    │
                    ▼
                  done
```

### Phase contracts

- **plan** — Input: user prompt + session history + RAG hits. Output: a list
  of `tool_call` invocations. The LLM may only emit names from the catalog;
  invalid names are dropped before exec.
- **gather** — Input: tool calls from plan. Output: `evidence[]` rows
  (id, action name, args, stdout, stderr, exit code, timing). Every output
  is scrubbed before persistence.
- **synthesize** — Input: prompt + evidence rows. Output: a streamed
  markdown report. The system prompt forces every assertion to cite
  `[ev-N]` matching an evidence row.
- **verify** — Deterministic, no LLM. Walks the report's `[ev-N]` references
  and checks each one resolves to a row that was actually gathered. If any
  citation is unresolved, the report is rejected and synthesis retries once.
- **propose** — Input: report + evidence + open questions. Output: 0–N
  follow-up `tool_call` invocations. The TUI surfaces them in a magenta
  panel; the user can accept all, accept some, decline, or stop.

The loop terminates when (a) the user declines proposals or (b) the planner
emits zero follow-ups two turns in a row.

---

## Permission model (three tiers)

Every action in the catalog is tagged with one of three tiers:

| Tier          | Prompt              | Remember? | Status in M1                |
|---------------|---------------------|-----------|-----------------------------|
| `read`        | none                | n/a       | active (17 actions)         |
| `mutate`      | verbatim + dry-run  | yes (per environment)  | refused at the gate today (M2) |
| `destructive` | fresh, every time   | **never** | refused at the gate today (M2) |

Mechanics:

- **`read`** — no prompt. Executed directly. This is the diagnostic flow.
- **`mutate`** — approval prompt with the verbatim command + dry-run diff.
  Choices: approve once, approve & remember for this environment, reject.
  Remembered rules are scoped per environment (e.g. auto-approve on
  `staging`, keep asking on `prod`) and are re-matched against the
  **resolved, final** command inside the Executor — so the LLM cannot
  get a benign command approved and then change its arguments.
- **`destructive`** — `delete`, `drop`, `prune`, `down`, force-push, and
  anything else without a sane rollback. Always a fresh prompt. Never
  rememberable. "Don't ask again" does not apply to this tier. Ever.

M1 ships `read` only. The runner refuses `mutate` and `destructive` at the
gate today. M2 introduces the approval flow.

---

## Memory model

PIPER's persistent state lives in a single embedded Postgres (PGlite). The
tables:

| Table             | Purpose                                                         |
|-------------------|-----------------------------------------------------------------|
| `evidence`        | Per-turn action outputs, scrubbed, cited as `[ev-N]`            |
| `audit_log`       | Immutable record of every exec + every refusal, forensic        |
| `chat_messages`   | Multi-turn conversation history (prompts + reports), per session |
| `sessions`        | Session metadata (id, title, `last_active_at`)                  |
| `rag_documents`   | Stable knowledge (runbooks, ADRs, solved cases), pgvector HNSW  |

Two cross-cutting mechanisms operate on top:

- **Rolling summary**: token-aware compaction kicks in when the planner's
  context would exceed 70% of the model's max tokens. Older turns are
  collapsed into a short summary; recent turns stay verbatim.
- **Solved cases (annex)**: a session can be promoted into `rag_documents`
  via `/annex` or a sentinel proposal, so future sessions retrieve it like
  any other runbook.

### RAG discipline: stable knowledge only

RAG ingests runbooks, ADRs, session summaries, and solved cases. It
**never** ingests live state — logs, process listings, container status.
Live data is fetched fresh per turn via read actions. Reasoning over
vectorised, stale operational data is the failure mode RAG is most prone
to in a DevOps context; we sidestep it by construction.

Supported `kind` values in `rag_documents`: `runbook`, `adr`,
`session-summary`, `solved-case`, `note`.

---

## Embedding pipeline (the three backends)

PIPER supports four embedding backends, picked at first run:

| Backend         | Source                                  | Dim  | Where it runs       |
|-----------------|-----------------------------------------|------|---------------------|
| `wasm` (default)| transformers.js, multilingual-e5-small  | 384  | In-process, no net  |
| `http`          | Any OpenAI-compatible local endpoint    | varies | Local (Ollama / LM Studio / llama.cpp / vLLM) |
| `openrouter`    | OpenRouter-hosted embedding model       | varies | Cloud (paid)        |
| `none`          | RAG disabled                            | —    | —                   |

When the user switches from a 768-dim embedder to a 384-dim one (or vice
versa), `ensure-schema.ts` detects the dimension mismatch on next boot,
drops the old `rag_documents` index, recreates it at the new dimension,
and re-ingests bundled runbooks. No manual migration.

---

## Security layers

Six overlapping defenses. No single one is sufficient; together a leakage
requires multiple to fail in the same place.

### 1. Architectural — secrets PIPER handles never enter the LLM

The credentials PIPER itself owns are consumed by subsystems **outside the
LLM context** by construction:

- **SSH private key**: PIPER never reads the key file. The OS `ssh`
  binary reads it (from disk or `ssh-agent`) and uses it for the
  handshake. PIPER's process sees only stdout/stderr of the remote
  command.
- **Provider API keys**: loaded from `~/.piper/credentials.json` into
  memory and used exclusively as the `Authorization: Bearer ...` HTTP
  header. They are never placed in a `messages[].content` field.

### 2. Path denylist — non-disablable

`src/security/paths.ts` exports a hard-coded list of paths no read action
may touch:

- `~/.ssh/id_*`, `~/.ssh/*.pem`, `~/.ssh/known_hosts`
- `~/.aws/credentials`, `~/.aws/config`
- `~/.kube/config`
- `~/.gnupg/`
- `~/.docker/config.json`
- `~/.netrc`
- `~/.piper/` (PIPER's own config)
- `.env`, `.env.*`
- `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa` anywhere

User config can **add** patterns; it cannot remove or weaken core entries.
Enforced at config load — concatenation, never substitution.

### 3. Two-pass output scrub

Every external output passes through `scrubText` twice:

- **Write-time scrub** before persistence to `audit_log` / `evidence`.
  If our DB leaks, secrets aren't in it.
- **Pre-LLM scrub** inside `ModelClient` before any HTTP call leaves the
  host. If the write-time scrub missed a pattern, this catches it.

The scrubber covers ~13 pattern families: PEM private keys, JWTs, AWS keys,
OpenAI / Anthropic / OpenRouter / GitHub / Slack token formats,
`Authorization` headers (Bearer + Basic), DB connection strings with
embedded credentials, kv-secret heuristics (`password=`, `token:`), env-var
heuristics (`*_KEY=`, `*_TOKEN=`). Redactions render as
`[REDACTED:<kind>]` so the LLM and the user see *that* something was
removed and of what type.

### 4. Args refuse — detect-and-reject, never launder

If a proposed action's args contain a recognisable secret pattern, the
Executor **refuses** the call rather than redacting it. Rationale:
redacting args mutates the action's semantics (`--grep <SECRET>` becomes
`--grep [REDACTED]`, a different command); the only safe behaviour is to
stop and flag. This also closes the exfiltration channel where an LLM tries
to encode a secret seen in one action's output as an argument to a later
action.

### 5. Provider data_collection=deny

Every OpenRouter request sets `body.provider.data_collection = 'deny'` —
routing through providers that contractually do not retain prompts.

### 6. Local mode

For high-privacy workloads, configure a local provider (Ollama, LM Studio,
llama.cpp, vLLM) plus the WASM embedder. Network egress for inference is
zero. The scrubber remains active (DB hygiene), but the "data left my
machine" risk is structurally absent.

---

## Stack rationale

| Choice                          | Why                                                                 |
|---------------------------------|---------------------------------------------------------------------|
| **Bun**                         | `bun build --compile` ships a single binary; native TS; `Bun.$` for the shell; fast startup for a CLI launched constantly. |
| **TypeScript strict**           | No `any`. Discriminated unions + Zod at the gate make catalog invariants checkable at the type system. |
| **Ink**                         | React for the terminal — the same approach as Claude Code; reactive TUI without reinventing layout. |
| **PGlite**                      | Real Postgres embedded in-process; one DB holds checkpointer state, audit log, evidence, and the pgvector RAG store. Single-writer limit is irrelevant for a single-user CLI. |
| **pgvector inside PGlite**      | Stable-knowledge RAG without a second database. HNSW index ships with the bundle. |
| **Zod**                         | Schema validation at the gate boundary, with TypeScript inference. |
| **OpenAI-compatible HTTP API**  | One client interface; every provider plugs in via base URL + key. Local-first is an O(1) configuration flip, not a code change. |
| **transformers.js (WASM)**      | Default embedding backend works offline with zero install effort and zero network egress. |
| **LangGraph deferred to M2**    | The diagnostic flow is linear; LangGraph's value (`interrupt`, durable resume) only materialises with mutations. See [ADR-002](decisions/ADR-002-no-langgraph-yet.md). |

---

## What PIPER explicitly does NOT do

- **Not an autonomous agent.** Always human-in-the-loop for mutations. PIPER
  does not act on `mutate` / `destructive` actions without approval, and
  never will.
- **Not a chat product.** The TUI is a working surface, not a conversation.
  Reports are short, dense, and cite their evidence.
- **Not a black box.** The catalog, gate, audit log, and scrub patterns are
  all readable in source — adding a capability is "add an Action + tests +
  docs", not "patch the prompt".
- **Not free-form shell.** The LLM cannot invent a command. Every external
  side effect goes through a catalog action whose Zod-validated args build
  an argv vector, not a shell string.
- **Not a Kubernetes admin panel, not a CI replacement, not a monitoring
  tool.** PIPER drives the tools you already trust (`kubectl`, `docker`,
  `helm`, `ssh`, `git`) and adds the safety + grounding layer on top.

---

## Where to learn more

- [ADR-001: The deterministic gate is the product](decisions/ADR-001-deterministic-gate.md)
- [ADR-002: Plain async-generator runner, not LangGraph (yet)](decisions/ADR-002-no-langgraph-yet.md)
- [runbooks/](runbooks/) — operational guides ingested into RAG at boot
- [README.md](../README.md) — what PIPER does for the user
- [CONTRIBUTING.md](../CONTRIBUTING.md) — how to contribute
- [SECURITY.md](../SECURITY.md) — vulnerability disclosure
