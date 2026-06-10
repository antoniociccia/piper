<div align="center">

<img src="docs/assets/piper-logo.png" alt="PIPER" width="320"/>

# PIPER

**DevOps at the speed of thought.**

A terminal-first, LLM-driven DevOps copilot that is *safe by construction* —
the LLM proposes, deterministic code validates, the human approves anything that mutates.

[![CI](https://github.com/antoniociccia/piper/actions/workflows/ci.yml/badge.svg)](https://github.com/antoniociccia/piper/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.3-black?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-386%20passing-brightgreen)](#tests)
[![Status](https://img.shields.io/badge/status-M1.5%20%E2%80%94%20diagnostics%20%2B%20RAG-success)]()

[**Why**](#why-this-exists) ·
[**Quick start**](#quick-start) ·
[**The gate**](#the-deterministic-gate) ·
[**Catalog**](#action-catalog) ·
[**Knowledge base**](#knowledge-base--rag) ·
[**Security**](#security)

</div>

---

> [!IMPORTANT]
> **The LLM never executes anything. It only picks an action from a fixed
> catalog.** PIPER then validates the choice and runs the command **on your
> own machine** through a single audited executor. The LLM is a planner, not a
> shell. This is the entire product.

## Demo

<div align="center">

<img src="docs/assets/demo.gif" alt="PIPER restarting a broken compose stack — proposes the real mutation, hits the docker permission boundary, asks for sudo with the verbatim command, executes after approval, verifies every service came back" width="900"/>

</div>

*"Restart the stack."* PIPER proposes the real `docker compose restart`, hits
the host's permission boundary, asks for sudo showing the exact command that
will run elevated, shows the pre-state snapshot, and only executes after
approval — then verifies every service came back up. Even the follow-up
read-only check gets its own gate: an approval for one command never carries
over to a different one. The LLM proposes; the deterministic gate validates;
the human stays in the loop.

---

## In one sentence

PIPER drives the tools you already trust (`ssh`, `kubectl`, `docker`, `gh`,
`aws`, `gcloud`, `journalctl`, ...) from a conversational terminal UI — but
every command runs **locally**, picked from a **typed action catalog**,
validated by a path denylist + secret scrubber, and (for anything that
mutates) gated behind an explicit human approval. The LLM can hallucinate
freely; it cannot reach your infrastructure unless a real human says yes.

```
›  uptime, memory and disk on staging — tail nginx logs if anything looks off

PIPER planning…  (3 actions chosen from the catalog)
  1. system.uptime
  2. system.memory
  3. system.disk_usage
   ✓ system.uptime         (520ms, ran locally)
   ✓ system.memory         (340ms, ran locally)
   ✓ system.disk_usage     (410ms, ran locally)

▌ Y(◉ ◉)Y
▌ Staging has been up for 14 days with a 0.43 load average [ev-1]. Memory
▌ has plenty of headroom — 12 GB free out of 16 GB total [ev-2] — and the
▌ root volume sits at 38% [ev-3]. Nothing worth flagging on the resource
▌ side, no need to dig into the nginx logs right now.
```

Every `[ev-N]` is a link back to the exact command output that produced the
claim. PIPER cannot make claims without evidence — the verifier rejects
ungrounded synthesis and retries.

---

## Catalog actions, not LLM-generated shell

This is the heart of the product. Read it twice.

|                       | What most LLM CLIs do                                  | What PIPER does                                                  |
|-----------------------|--------------------------------------------------------|------------------------------------------------------------------|
| **Who composes the command** | The LLM writes a shell string (`tail -f …`, `kubectl get …`) | The LLM picks an **action name + typed args** from a closed catalog |
| **Who runs it**       | An execution layer that runs whatever the LLM wrote   | **PIPER's local executor** runs a fixed command template bound to that action |
| **What if the LLM hallucinates** | A bogus command might run on your infrastructure       | The catalog has no entry for a bogus action → the executor refuses |
| **What you can audit** | Prompts + arbitrary shell history                     | A typed list of actions in source — `src/actions/builtin/` — plus the verbatim local exec in `audit_log` |
| **Where the command runs** | Sometimes a remote sandbox, sometimes your machine    | **Always your machine.** Local subprocess, optionally SSH'ing into an allowlisted host you registered |

Concretely: when the LLM wants to check disk space, it does **not** emit
`"df -h /"`. It emits a typed tool call —

```json
{ "name": "system.disk_usage", "args": { "host": "staging", "path": "/" } }
```

— and PIPER's executor (only `src/exec/executor.ts` runs anything) translates
that into `df -h /` and spawns a local subprocess. The shell string is built
**in PIPER's source code**, not by the LLM. The args are validated by Zod
before the spawn. Secrets are stripped on the way out, before going to the
audit log and before going back to the LLM.

The LLM can ask for `system.disk_usage`. It cannot ask for
`system.evil_undocumented_thing`. That's the safety property.

---

## Why this exists

We built PIPER for two people, both real:

1. **The lone developer with no DevOps support.** You shipped an app, you need to
   keep it running, and there's no one to call when the staging container won't
   come up at 11pm. Today your fallback is pasting logs into ChatGPT and hoping.
2. **The DevOps engineer doing the same diagnostic dance fifty times a day.** Tail
   the logs on that node. Check why the deploy is stuck. Verify the cron. You
   don't need a tutor — you need an editor for infrastructure with audit trail
   and rollback wired in.

Both meet on the same contract: **PIPER never silently mutates anything, and you
can always see exactly what it is about to do.**

### Non-goals

- **Not** an autonomous agent. PIPER does not act on `mutate` / `destructive`
  actions without approval, and never will.
- **Not** a chat product. The TUI is a working surface, not a conversation.
- **Not** a Kubernetes admin panel, not a CI replacement, not a monitoring tool.
  PIPER drives the CLIs you already trust and adds the safety + grounding layer.
- **Not** a black box. Every action, prompt, approval rule and audit log entry
  is readable in source.

---

## Status

| Milestone | What | State |
|---|---|---|
| **M0** | Spike — Bun `--compile` + Ink + PGlite WASM | ✅ shipped |
| **M1** | Read-only diagnostics: SSH, logs, health, container/pod status, **deterministic gate** | ✅ shipped |
| **M1.5** | RAG/memory layer, 3 embedding backends, sessions + resume, auto-compaction, interactive `/model` & `/memory`, HUMAN/YOLO modes, 40+ read actions | ✅ shipped |
| **M2** | Mutations behind HITL — docker deploy gated by snapshot → dry-run → approve → verify → rollback | ✅ shipped |
| **M3a** | **Watch mode** — `/watch` compiles plain-English requests into deterministic, read-only checks; anomalies trigger automatic grounded diagnosis and (gated) remediation proposals | ✅ shipped |
| **M3b/c** | Kubernetes gated deploy, repo suggestions | ⏳ |
| **M4** | On-prem / regulated — local-model-only path, encrypted audit, runbook ingestion at install | ⏳ |

Mutations land in M2 behind the full approval gate; the read-only diagnostic
flow and the new **watch loop** are diagnostic by construction.

---

## Quick start

### Option A — pre-built binary (recommended)

```bash
curl -fsSL https://antoniociccia.github.io/piper/install | sh
```

The script is [40 lines you can read first](docs/install): it detects your
OS/arch and downloads the matching binary from the latest release. No sudo,
no package manager. Or do it by hand — grab the binary for your platform from
the [latest release](https://github.com/antoniociccia/piper/releases/latest) —
no Bun, no `node_modules`, single ~76 MB file.

```bash
# macOS (Apple Silicon)
curl -fsSLO https://github.com/antoniociccia/piper/releases/latest/download/piper-darwin-arm64
# Strip Gatekeeper's quarantine xattr (the binary isn't notarised yet).
xattr -d com.apple.quarantine piper-darwin-arm64 2>/dev/null || true
chmod +x piper-darwin-arm64 && mv piper-darwin-arm64 /usr/local/bin/piper
piper

# Linux x64
curl -fsSLO https://github.com/antoniociccia/piper/releases/latest/download/piper-linux-x64
chmod +x piper-linux-x64 && sudo mv piper-linux-x64 /usr/local/bin/piper
piper
```

A `.sha256` is published alongside each binary — verify the download before
running.

> [!NOTE]
> **macOS — PIPER is a terminal CLI, not a Mac app.** Run `piper` from a
> shell; do **not** double-click the downloaded binary in Finder. The binary
> isn't notarised by Apple yet, so double-clicking shows "is damaged and
> can't be opened". From the terminal it runs normally. Notarisation is
> tracked on the roadmap.

### Option B — from source

Need [Bun](https://bun.sh) ≥ 1.3 (one-line install: `curl -fsSL https://bun.sh/install | bash`).

```bash
git clone https://github.com/antoniociccia/piper
cd piper
bun install
bun dev
```

On first launch PIPER detects that `~/.piper/credentials.json` doesn't exist and
runs an interactive wizard:

1. **Backend** — probes for any local LLM server running (Ollama `:11434`,
   LM Studio `:1234`, llama.cpp `:8080`, vLLM `:8000`), or asks for an
   OpenRouter API key.
2. **Model** — pick a tier (Featherweight ~$0.10/M, Economy ~$0.44/M, Balanced
   ~$3/M, Premium $30+/M) or a local model from the listed catalog.
3. **Embedding backend** — `wasm` (default, in-process, offline after first run),
   `http` (local OpenAI-compatible endpoint), `openrouter` (cloud, paid), or
   `none` (disable RAG).
4. **Budget** — per-session USD cap (default $0.50; hard stop, not a warning).
5. **SSH environment** — optionally add a first host PIPER will be able to reach.

The wizard writes `~/.piper/credentials.json` with mode `0600`. From there:

```
›  check uptime and disk usage on staging
```

To resume a previous session at startup:

```bash
bun dev -- --resume      # opens a picker over recent sessions
```

### Build a single binary

```bash
bun run build      # ./dist/piper, ~76 MB
./dist/piper       # runs without Bun, without node_modules
```

The binary embeds PostgreSQL WASM (~13 MB) and Yoga layout. The embedding
model is **not** bundled — it lazy-fetches on first RAG use (~120 MB, one
time) and caches at `~/.piper/cache/models/`.

---

## The deterministic gate

You cannot get "no hallucination" from an LLM. **Don't try.** Instead, make
being wrong *safe*. PIPER's LLM lives inside a deterministic cage:

```
       ┌────────────┐  proposes actions      ┌────────────────┐
       │    LLM     │ ─────tool_calls──────► │  Action catalog│
       │ (any model)│                        │  (read|mutate| │
       │            │                        │   destructive) │
       └────────────┘                        └───────┬────────┘
              ▲                                      │ validate
              │ scrubbed                             │ args (Zod)
              │ messages                             ▼
              │                              ┌────────────────┐
              │                              │   Executor     │
              │                              │   (the ONLY    │
              │                              │   side-effect  │
              │                              │   surface)     │
              │                              └───────┬────────┘
              │                                      │
              │           scrub stdout/stderr        │ spawns kubectl /
              └──────────────────────────────────────┤ docker / ssh /
                                                     │ nc / gh / ...
                                                     ▼
                                           ┌──────────────────┐
                                           │ PGlite + pgvector│
                                           │ audit_log,       │
                                           │ evidence,        │
                                           │ knowledge        │
                                           └──────────────────┘
```

**Three permission tiers** with no overrides:

| Tier            | Examples                          | Approval                                 |
|-----------------|-----------------------------------|------------------------------------------|
| `read`          | `uptime`, `docker.ps`, `kubectl get` | None. Executes directly. Safe by definition. |
| `mutate`        | (M2) `docker deploy`, env update  | Per-env approval prompt; **remembered**     |
| `destructive`   | (M2) `delete`, `drop`, `prune`, force-push | **Fresh prompt every time. Never remembered. Ever.** |

Five overlapping defenses, applied at every layer:

- **Architectural** — SSH keys never leave the OS `ssh` binary; API keys never
  enter `messages[].content`. Single-module discipline + CI rule.
- **Path denylist** — `~/.ssh/id_*`, `~/.aws/credentials`, `~/.kube/config`,
  `~/.gnupg/`, `~/.docker/config.json`, `~/.netrc`, `~/.piper/`, `.env*`.
  Non-disablable. User config can *extend* the list, never weaken it.
- **Two-pass scrubbing** — write-time (every Executor output → audit log) and
  pre-LLM (every message body → HTTP call). Defense in depth.
- **Args refuse** — if the LLM tries to embed a recognisable secret (`AKIA…`,
  `sk-or-…`, JWTs, PEM blocks, `Bearer …`) in an action's args, the Executor
  **refuses the action** — it does not redact. Redaction would mutate semantics.
- **Provider-level privacy** — OpenRouter requests set
  `body.provider.data_collection = 'deny'`. Local mode routes inference through
  Ollama / llama.cpp / LM Studio / vLLM — network egress for inference is zero.

**Sudo elevation** — PIPER can propose running a command with `sudo` for
commands that need root (either because the planner knows in advance, or
reactively after a permission-denied failure). Every elevation — read-tier
included — is shown to you and requires explicit approval. The path denylist
still blocks sensitive files (`~/.ssh/id_rsa`, `~/.aws/credentials`, etc.)
under sudo, before the approval prompt is shown. If the host requires a sudo
password, you type it on your own terminal via an interactive `ssh -tt`
session; PIPER's buffers, audit log, and model messages never see it.

Full design rationale in [`docs/architecture.md`](docs/architecture.md) and
[`docs/decisions/ADR-001-deterministic-gate.md`](docs/decisions/ADR-001-deterministic-gate.md).

---

## Action catalog

40+ read-tier actions across the major DevOps surfaces. Every action is a
typed object registered in `src/actions/builtin/`, validated by Zod, executed
only through `src/exec/executor.ts`. **Free-form shell from the LLM is not
representable in the type system.**

<details>
<summary><b>Click to expand the full catalog</b></summary>

| Category      | Action                       | What it does                                                  |
|---------------|------------------------------|---------------------------------------------------------------|
| **System**    | `system.uptime`              | `uptime` (load average + time up)                             |
|               | `system.os_info`             | `uname -a` + `/etc/os-release`                                |
|               | `system.memory`              | `free -h`                                                     |
|               | `system.disk_usage`          | `df -h [path?]`                                               |
|               | `system.process_list`        | `ps -eo pid,user,pcpu,pmem,args -ww`                          |
|               | `system.list_dir`            | `ls -la <path>` (deny-list enforced)                          |
|               | `system.file_stat`           | `stat <path>`                                                 |
|               | `system.cpu_info`            | `lscpu` / `/proc/cpuinfo`                                     |
|               | `system.dmesg`               | Kernel ring buffer tail                                       |
|               | `system.package_list`        | Installed packages (`dpkg -l` / `rpm -qa`)                    |
|               | `system.cron_list`           | User + system crontabs                                        |
|               | `system.systemctl_list`      | `systemctl list-units --type=service`                         |
|               | `system.iptables_list`       | `iptables -L -n -v`                                           |
| **Network**   | `network.connections`        | `ss -tunap`                                                   |
|               | `network.port_check`         | `nc -zv` (open / refused / timeout / closed)                  |
|               | `network.ping`               | `ping -c N -W T`                                              |
|               | `network.dns_lookup`         | `dig` / `host` lookup                                         |
|               | `ssh.connect`                | Probe SSH reachability against an allowlisted host            |
| **Logs**      | `logs.tail`                  | `tail -n N <path>` with optional grep                         |
| **Services**  | `service.status`             | `systemctl status <unit>`                                     |
|               | `service.journal`            | `journalctl -u <unit> -n N`                                   |
| **Docker**    | `docker.ps`                  | Container list (JSON)                                         |
|               | `docker.logs`                | Container log tail                                            |
|               | `docker.inspect`             | Container inspect (summarised)                                |
|               | `docker.compose_ps`          | `docker compose ps` for a project                             |
| **Kubernetes**| `kubernetes.get`             | `kubectl get <kind>` (pods, deploys, services…)               |
|               | `kubernetes.logs`            | `kubectl logs <pod>` (with `-c`, `--previous`, tail-N)        |
|               | `kubernetes.describe`        | `kubectl describe <kind>/<name>`                              |
|               | `kubernetes.top_pod`         | `kubectl top pod`                                             |
|               | `kubernetes.events`          | `kubectl get events --sort-by=.lastTimestamp`                 |
|               | `kubernetes.context_current` | `kubectl config current-context`                              |
| **Git**       | `git.status`                 | `git status --porcelain=v1`                                   |
|               | `git.log`                    | `git log -n N --oneline --decorate`                           |
| **GitHub**    | `github.pr_list`             | `gh pr list`                                                  |
|               | `github.pr_view`             | `gh pr view <number>`                                         |
|               | `github.run_list`            | `gh run list` (Actions)                                       |
|               | `github.run_view`            | `gh run view <id>` (logs, conclusion)                         |
|               | `github.issue_list`          | `gh issue list`                                               |
| **AWS**       | `aws.s3_ls`                  | `aws s3 ls`                                                   |
|               | `aws.ec2_describe`           | `aws ec2 describe-instances`                                  |
|               | `aws.cloudwatch_tail`        | `aws logs tail` (CloudWatch)                                  |
|               | `aws.rds_describe`           | `aws rds describe-db-instances`                               |
| **GCP**       | `gcp.compute_list`           | `gcloud compute instances list`                               |
|               | `gcp.logging_read`           | `gcloud logging read`                                         |
| **Azure**     | `azure.vm_list`              | `az vm list`                                                  |
| **Database**  | `postgres.pg_isready`        | `pg_isready` against host:port                                |
| **Memory**    | `memory.search`              | In-process semantic search over the local knowledge base      |

</details>

---

## Knowledge base / RAG

PIPER ships a `memory.search` action. It is *not* a shell action — it's
in-process semantic search over a local PGlite + pgvector store of:

- **`runbook`** — markdown under `docs/runbooks/`
- **`adr`** — architecture decision records under `docs/decisions/`
- **`session-summary`** — produced by `/session-report`
- **`solved-case`** — distilled incident notes (annex format, opt-in)
- **`note`** — free-form knowledge you add yourself

The planner is instructed to call `memory.search` **first** when the user's
prompt looks like a known incident pattern, a deploy procedure, or references
a host that has prior session notes. The agent stays grounded in *your*
runbooks instead of the model's training data.

### Three embedding backends

| Backend      | Model                              | Dim  | Cost | Notes                                                              |
|--------------|------------------------------------|------|------|--------------------------------------------------------------------|
| `wasm` (default) | `Xenova/multilingual-e5-small` | 384  | free | In-process via `@huggingface/transformers`. 94 languages. ~120 MB downloaded once, then fully offline. Cached at `~/.piper/cache/models/`. |
| `http`       | OpenAI-compatible local endpoint   | varies | free | Ollama (`nomic-embed-text`, 768-dim), LM Studio, llama.cpp, vLLM.  |
| `openrouter` | Cloud paid embedding model         | varies | paid | Only offered if an API key is configured.                          |
| `none`       | —                                  | —    | —    | Disables RAG. `memory.search` returns empty.                       |

The schema auto-recreates if the dimension mismatches — switching e.g. from
Ollama 768-dim to WASM 384-dim drops the old vectors and rebuilds from
source. Zero manual migration.

---

## Watch mode

`/watch` compiles a plain-English request into **deterministic, read-only
checks**, runs them on a cadence with **zero LLM cost per tick**, and — only
when a check actually fails — fires an **automatic grounded diagnosis** and a
**gated remediation proposal**. The LLM is never in the monitoring hot loop.

```
/watch docker-basics                  # start a bundled stock plan
/watch keep an eye on staging         # compile a custom plan from plain English
piper check docker-basics staging     # one-shot mode for cron/CI (exit 0/1/2/3)
```

A watch plan is a skill-like markdown file (`~/.piper/watches/*.md`): YAML
frontmatter listing the checks plus a prose runbook the LLM reads only on
anomaly. Each check pairs a **read-tier catalog action** with an expectation
from a **closed DSL** of seven kinds (`exit_zero`, `all_running`,
`max_percent`, `min_count`, `regex_match`, `regex_absent`, `json_path_eq`),
evaluated in-process. Plans that name a `mutate`/`destructive` action, or whose
args don't satisfy the action's schema, are rejected at load.

When a check fails twice in a row (debounce), PIPER fires once and stays quiet
for 15 minutes (cooldown). On fire it notifies you (TUI bell, desktop
notification via the audited `notify.desktop` action, and an optional
`https`-only webhook with a **metadata-only, scrubbed** payload), then runs a
budget-guarded diagnosis through the normal agent runner. Any fix it proposes
goes through the **M2 approval gate** — the watch loop never mutates anything on
its own.

Three stock plans ship in source: **`docker-basics`**, **`k8s-basics`**,
**`disk-and-memory`**. `piper check <plan> [env]` runs every check once and
exits with a meaningful code (0 all-passed, 1 expectation failed, 2 check error,
3 plan not found) — drop it into cron or CI. Full design rationale in
[`docs/decisions/ADR-003-watch-mode.md`](docs/decisions/ADR-003-watch-mode.md).

---

## TUI modes & commands

Toggle modes with **Shift+Tab**:

- **HUMAN** (default) — PIPER asks for approval per planned step. Verbatim
  command is shown before any run.
- **YOLO** — read-tier actions execute without per-step approval. `mutate`
  and `destructive` actions **still always ask, every time**, by design.

<details>
<summary><b>Slash commands</b></summary>

```
/model               interactive model picker (Local / OpenRouter tabs, paging, filter)
/watch [plan|text]   list watch plans, start one, or compile a new plan from plain English
/memory              knowledge-base viewer (Overview + Sources, delete with d)
/mem, /rag           aliases for /memory
/resume              pick a recent session and reload its history into scrollback
/env add <name> <user@host[:port]> [--key <path>] [--desc "..."] [--tag a,b]
/env list
/env remove <name>
/session-report      summarise the current session into the knowledge base
/debug               toggle verbose agent events (costs, synth status, RAG hits, LLM trace)
/help                show context-sensitive help
/save [file.md]      export the last report to a file
/quit                exit PIPER (Ctrl+C also works)
```

</details>

<details>
<summary><b>Keyboard</b></summary>

| Keys           | Effect                                                            |
|----------------|-------------------------------------------------------------------|
| `Enter`        | Send                                                              |
| `Shift+Enter`  | New line (multi-line input)                                       |
| `Shift+Tab`    | Toggle HUMAN ↔ YOLO                                               |
| `Ctrl+O`       | Collapse reasoning — hide agent-event lines from future turns     |
| `?`            | Context-sensitive help                                            |
| `Esc`          | Clear current input                                               |
| `Ctrl+C`       | Quit                                                              |

</details>

---

## Status bar

The bottom strip of the TUI shows everything at a glance:

```
Y(◉ ◉)Y  diagnosing staging      $0.0123 | google/gemini-pro-1.5 | OR $4.32 left | 12.4k/128k (10%) ███▒▒▒▒▒▒▒  HUMAN
```

- **Alien mascot** — color-cycles while PIPER thinks; idle when waiting on you.
- **Session title** — auto-generated from the first user prompt by a tiny LLM call.
- **Cost** — running session cost in USD, real provider pricing.
- **Model id** — the model currently driving the planner (`/model` to switch).
- **OpenRouter remaining credit** — live-fetched every 60s on paid backends.
- **Token meter** — `N/limit (%)` against the model's `maxContextTokens`
  (minus 4k reserved for output), measured with real `gpt-tokenizer` cl100k_base.
- **Mode badge** — HUMAN (green) or YOLO (red).

---

## Sessions, lifecycle, output

- **Persistent by default.** PGlite stores sessions at `~/.piper/data/pglite/`.
  Override with `PIPER_DATA_DIR=/path`. Force in-memory (ephemeral) with
  `PIPER_EPHEMERAL=1`.
- **Auto-titled.** Small LLM call on the first user prompt names the session.
- **Auto-saved reports.** Every `done` writes the final answer to
  `~/.piper/data/reports/{sessionId}/run-{ts}.md`.
- **Resume.** `bun dev -- --resume` at startup, or `/resume` mid-session.
- **Auto-compaction.** When the planner's context exceeds 70% of the model's
  `maxContextTokens`, older turns are rolled into a single summary message.
- **Grounded synthesis.** Every claim cites `[ev-N]`. A run passes the verifier
  if ≥75% of substantive lines are cited; ungrounded answers retry.
- **`<Static>` scrollback persistence.** History stays in the terminal's native
  scrollback — append-only, no redraw, no flicker, no loss when you scroll up.

---

## Stack

| Concern              | Choice                                                                  |
|----------------------|-------------------------------------------------------------------------|
| Runtime              | **Bun** ≥ 1.3 (single-binary via `bun build --compile`; `Bun.YAML` for watch plans) |
| Language             | **TypeScript** strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, no `any`) |
| Terminal UI          | **Ink** (React for the terminal)                                        |
| Persistence          | **PGlite** (PostgreSQL in WASM — single embedded DB)                   |
| Vectors              | **pgvector** inside the same PGlite DB (HNSW index)                    |
| Embeddings (default) | `@huggingface/transformers` + `Xenova/multilingual-e5-small` (WASM)     |
| Tokenizer            | `gpt-tokenizer` (cl100k_base)                                          |
| Schema validation    | **Zod**                                                                 |
| Model API            | **OpenAI-compatible** `/v1/chat/completions`                            |

Why these choices: see [`docs/decisions/`](docs/decisions/).

---

## Configuration

<details>
<summary><b><code>~/.piper/credentials.json</code> (created by the wizard, mode 0600)</b></summary>

```json
{
  "openrouter_api_key": "sk-or-v1-...",
  "default_provider": "openrouter",
  "default_model": "deepseek/deepseek-v4-pro",
  "embedding_backend": "wasm",
  "max_session_cost_usd": 0.50,
  "max_followup_iterations": 1,
  "compaction_keep_recent": 6,
  "compaction_trigger_pct": 0.70,
  "environments": {
    "prod-web": {
      "host": "192.0.2.10",
      "ssh_user": "deploy",
      "port": 22,
      "identity_file": "/Users/me/.ssh/id_ed25519",
      "description": "production web tier",
      "tags": ["prod", "web"]
    }
  }
}
```

</details>

<details>
<summary><b>Environment variables (override the file — useful in CI)</b></summary>

| Variable                     | Purpose                                                                |
|------------------------------|------------------------------------------------------------------------|
| `PIPER_PROVIDER`             | `openrouter \| ollama \| lmstudio \| llamacpp \| vllm \| custom`        |
| `PIPER_BASE_URL`             | Endpoint override                                                      |
| `PIPER_API_KEY` / `OPENROUTER_API_KEY` | API key                                                       |
| `PIPER_MODEL`                | Model id                                                               |
| `PIPER_EMBEDDING_BACKEND`    | `wasm \| http \| openrouter \| none`                                    |
| `PIPER_MAX_SESSION_COST_USD` | Hard budget cap                                                        |
| `PIPER_DATA_DIR`             | Persistent storage (default: `~/.piper/data/pglite/`)                  |
| `PIPER_EPHEMERAL`            | Set to `1` for in-memory storage (loses sessions at exit)              |

If an env var doesn't look like a valid API key (e.g. a leftover `test`
value), PIPER ignores it with a warning and falls back to the file.

</details>

---

## Tests

```bash
bun test                       # 386 unit + gate tests (no Docker, no network)
bun run e2e                    # Docker sshd fixture, E2E tests, teardown
bun run typecheck              # tsc --noEmit, strict
```

Coverage focuses on the security-critical layers: catalog gate, path denylist,
secret scrubber, audit log persistence, verifier, embedding-dim migration.

CI runs `license-checker` and **rejects any GPL transitive dependency**.

---

## Security

PIPER is built around a deterministic safety gate. Vulnerability disclosure
process: see [`SECURITY.md`](SECURITY.md). Coordinated disclosure, 90-day
default. Particular care for:

- Prompt-injection that smuggles a command into the gate
- Any code path that runs shell outside the `Executor`
- Any code path that logs or sends unredacted secrets
- Any code path that lets a remembered rule auto-approve a `destructive` action
- Any code path that bypasses the SSH host allowlist

The full architecture + threat model is at
[`docs/architecture.md`](docs/architecture.md).

---

## License & contributing

**Apache-2.0.** See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE) — the NOTICE
file discloses the Apache-2.0 transitive deps and the LGPL transitive
disclosure for `@img/sharp-libvips` (pulled in by the embedding pipeline).

Contributions welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the flow.
**Two-eyes rule** on anything touching `src/exec/`, `src/security/`, or
`src/actions/` — the maintainer reviews these personally.

---

<div align="center">

<sub>Built with the conviction that <b>making being wrong safe</b> beats trying to make the LLM never wrong.</sub>

</div>
