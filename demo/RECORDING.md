# Demo recording cookbook

Step-by-step for recording the PIPER demo GIF that lives in the README.

`scripts/record-demo.sh` automates the boring parts (env setup, asciinema
flags, GIF conversion). This document covers the **one-time setup**, what to
**type during the take**, and how to **troubleshoot** common issues.

---

## 0. One-time setup

### Tools

```bash
brew install asciinema agg          # macOS
# Linux: see https://docs.asciinema.org/manual/cli/installation/
#        and https://github.com/asciinema/agg#installation
```

A clean shell helps — hide a noisy prompt, no autosuggest popups. The
recorder pins the window to 140×44 regardless of your terminal size.

### Pre-warm PIPER (do this BEFORE starting the recording)

The first run downloads the WASM embedder (~120 MB) and ingests the
runbooks into pgvector. Neither belongs on camera.

```bash
# 1. Start the demo host. Idempotent.
bash demo/setup.sh
docker compose -f demo/docker-compose.yml up -d

# 2. First-time embedder download + RAG ingest, against the demo's
#    isolated data dir so your real ~/.piper/data stays clean.
PIPER_DATA_DIR=./demo/.piper-demo-data PIPER_EMBEDDING_BACKEND=wasm bun dev
# Wait for the boot bubble to finish ("Indexing knowledge base…").
# Then /quit. The embedder is now cached at ~/.piper/cache/models/.
```

Verify the demo host is up and reachable:

```bash
ssh -i demo/keys/piper-demo -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile=/dev/null \
    deploy@localhost -p 2222 'whoami && uname -a'
```

Should print `deploy` and the container's `uname`.

---

## 1. Recording

```bash
bash scripts/record-demo.sh
```

The script:

1. Wipes any previous demo session so the take starts clean.
2. Pins the window to 140×44 cols, format asciicast-v2 (agg-compatible).
3. Records into `docs/assets/demo.cast`.
4. Converts to `docs/assets/demo.gif` via `agg`.

### Prompts to type (in order, don't improvise)

Type each one, wait for PIPER to finish, then the next.

**Current take — Smart Analyze + log drill (v0.5.x):**

| # | Prompt                                                                 | What it shows                                                         |
|---|------------------------------------------------------------------------|-----------------------------------------------------------------------|
| 1 | `/env add demo deploy@localhost:2222 --key demo/keys/piper-demo`       | Adding an SSH environment                                             |
| 2 | `analyze demo and show me the logs of every container`                 | The whole v0.5.x flow, see breakdown below                            |
| 3 | `/quit`                                                                | Clean exit                                                            |

Breakdown of what happens during prompt #2 (all on camera):

1. The **deterministic discovery plan** appears — the same 12 read steps every
   run (specs, top processes, open ports, compose/k8s/systemd discovery).
   Approve with `y`.
2. The docker probes hit `permission denied … Docker daemon socket` → the
   **sudo panel** appears. Press `r` (remember for this session) so the
   remaining docker probes don't re-prompt mid-sweep.
3. The **grounded baseline report** streams: host specs in an ASCII table,
   the `orderly` compose project discovered at `/opt/orderly` with
   worker + redis **exited** — every claim cited `[ev-N]`.
4. The **follow-up proposal** appears: `docker.compose_logs(/opt/orderly)` —
   PIPER chained the drill from its own discovery (it found WHERE the stack
   lives, now it asks permission to tail its logs). Press `y`.
5. The report **extends itself** with the log findings: redis was OOM-killed
   → the worker refused to start without cache → web is serving in degraded
   mode. Three anomalies, causally connected, each cited from the logs.

The money shot: *"one sentence → a reproducible baseline → PIPER proposes its
own next step → you approve → the report deepens. The LLM never ran anything
on its own."*

> Dry-run first: step 4 is LLM-driven (the proposer). Verify your model
> actually chains `docker.compose_logs` before recording. `kubectl` is absent
> on the demo host, so that step fails visibly — that's intentional (graceful
> degradation on camera).

<details>
<summary>Previous take — read-only diagnosis (M1/M2, kept for reference)</summary>

| # | Prompt                                                                 | What it shows                                                         |
|---|------------------------------------------------------------------------|-----------------------------------------------------------------------|
| 1 | `/env add demo deploy@localhost:2222 --key demo/keys/piper-demo`       | Adding an SSH environment                                             |
| 2 | `analyze demo`                                                         | Broad audit; planner picks 5–7 read actions; ~25 s                    |
| 3 | `the config declares a worker, but is it actually running?`            | Conversational follow-up, drills into the worker mystery; ~15 s       |
| 4 | `what fix would you propose? don't execute anything, I just want to understand` | Read-only safety contract — PIPER proposes, refuses to apply; ~15 s |
| 5 | `summarize in a table: host specs, anomalies found, things to handle`  | Shows structured output + citations; ~15 s                            |
| 6 | `/memory` then Esc                                                     | Knowledge base viewer — proves the RAG is real                        |
| 7 | `/quit`                                                                | Clean exit                                                            |

</details>

> **Note:** since the reactive-sudo demo update, `analyze demo` will hit the
> docker permission boundary on the `docker.*` read actions and propose sudo
> for those too. That's by design (v0.4.0 gates *every* sudo, reads included) —
> just be ready for the extra panel if you use the old prompt list.

---

## 2. Post-record

```bash
# Replay locally before committing
asciinema play docs/assets/demo.cast

# Preview the GIF
open docs/assets/demo.gif
```

If a section drags or a typo bothers you, **just re-run the script**. Editing
the cast by hand is fragile and looks dishonest in playback.

Commit `docs/assets/demo.cast` + `docs/assets/demo.gif` together — the cast
is the source of truth; the GIF can always be re-derived from it.

---

## 3. Troubleshooting

| Symptom                                  | Likely cause                                                    | Fix                                                                          |
|------------------------------------------|-----------------------------------------------------------------|------------------------------------------------------------------------------|
| Token meter shows 0/1M for a long time   | Embedder still loading on first take                            | Pre-warm before recording (step 0)                                           |
| Cost shows $0.0000 always                | You're on a local model (no usage)                              | Run `/model`, pick an OpenRouter model                                       |
| `memory.search` returns 0 hits           | RAG ingest didn't run                                           | `bun dev` once, check `/memory` shows runbook count > 0                      |
| SSH "permission denied" on `analyze demo`| Wrong key path in `/env add`                                    | Use `demo/keys/piper-demo` (user key, not host key)                          |
| Demo container restarted, lost state     | Volumes not mounted                                             | `bash demo/setup.sh` (idempotent — restores)                                 |
| GIF is tiny / cropped / shows only cursor| Window-size mismatch between cast and agg                       | Should not happen with the script — both pinned to 140×44                    |
| Status bar overlaps the prompt           | Terminal narrower than 100 cols                                 | Resize before recording. The script pins to 140, but the inner UI assumes ≥100|

---

## 4. Caption suggestions for the README embed

Short version:

> "Restart the stack." Three approval gates later, it's done — and you read
> every command before it ran.

Longer version:

> PIPER turns *"restart the stack"* into a gated mutation: it proposes the
> real `docker compose restart`, hits the host's permission boundary, asks
> for sudo (showing exactly what will run elevated), shows the verbatim
> command + pre-state snapshot, and only executes after approval — then
> verifies every service came back. The LLM proposes; the deterministic
> gate validates; the human stays in the loop.
