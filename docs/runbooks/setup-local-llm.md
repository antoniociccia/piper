# Runbook — Set up a local LLM for PIPER

PIPER works equally well with a remote provider (OpenRouter, etc.) and a local
LLM server. This runbook covers the local path — useful when:

- You can't (or don't want to) send prompts to a third party.
- You're on an air-gapped or regulated network.
- You don't want to pay per-token.

We support four local backends. **Ollama** is the easiest to start with on
macOS / Linux / Windows; the others trade convenience for performance or
flexibility.

| Provider     | Default port | Best for                                  |
|--------------|--------------|-------------------------------------------|
| **Ollama**     | `11434`      | Default for CLI-comfortable users         |
| **LM Studio**  | `1234`       | GUI-first setup on Mac/Windows            |
| **llama.cpp**  | `8080`       | Power users, edge / constrained hardware  |
| **vLLM**       | `8000`       | Team / shared inference (Linux + CUDA GPU)|

PIPER probes all four on the wizard's first step. Whichever responds first to
`/v1/models` becomes a one-keystroke pick.

---

## Recommended models

Three local models we've found to behave well with PIPER's tool-calling planner:

| Model                          | Size  | Why                                                                |
|--------------------------------|-------|--------------------------------------------------------------------|
| **Devstral-Small-2-24B**       | 24B   | Agentic-first, native Mistral function-calling. Strong default.    |
| **gpt-oss-20B**                | 20B   | Cleanest JSON tool-call adherence; smaller footprint.              |
| **Qwen3-Coder-30B-A3B**        | 30B*  | MoE — activated ~3B params per token. High BFCL, RL on SWE-Bench.  |

*Activated params

All three have tool-calling-capable releases. Quantised GGUFs run well on
Apple Silicon and modern x86_64 CPUs.

---

## Path A — Ollama (recommended)

### 1. Install Ollama

macOS:

```bash
brew install ollama
ollama serve &           # starts the daemon on localhost:11434
```

Linux:

```bash
curl -fsSL https://ollama.com/install.sh | sh
systemctl start ollama
```

Windows: download the installer from <https://ollama.com/download>.

### 2. Pull a model

```bash
# Pick one (or all three to compare). Sizes are GGUF Q4_K_M roughly.
ollama pull mistral-small3.2         # Devstral-class small Mistral (~14 GB)
ollama pull gpt-oss:20b              # gpt-oss-20B (~12 GB)
ollama pull qwen3-coder:30b          # Qwen3-Coder MoE (~18 GB)
```

If you don't have 12+ GB of RAM/VRAM free, try a smaller variant:

```bash
ollama pull qwen2.5-coder:7b
```

7B models are noticeably weaker at multi-step tool-calling but workable for
single-action queries.

### 3. Verify Ollama is up

```bash
curl -s http://localhost:11434/v1/models | jq '.data | length'
```

If you see a number > 0, you're good.

### 4. Point PIPER at it

Either run the wizard (`bun dev` with no `~/.piper/credentials.json`) — it
will detect Ollama automatically — or edit the file directly:

```json
{
  "default_provider": "ollama",
  "base_url": "http://localhost:11434/v1",
  "default_model": "qwen3-coder:30b",
  "max_session_cost_usd": null
}
```

For local, `max_session_cost_usd` is meaningless ($0 per call) — leave it out.

### 5. Smoke-test

```bash
bun dev
```

Inside the TUI:

```
› check uptime on <your-env>
```

You should see streaming output within a couple of seconds. If the model emits
preambles like "Sto raccogliendo evidenze…" before writing the actual report,
your model isn't strict enough about tool-calls and proposals — try a bigger
one or pick a different family.

---

## Path B — LM Studio (GUI-first)

1. Download <https://lmstudio.ai/>.
2. In the app: **Discover** tab → search for `qwen3-coder` or `gpt-oss` → pick
   a tool-calling variant → click "Download".
3. **Developer** tab → "Start Server" → port `1234`.
4. Run `bun dev` — the wizard sees LM Studio on `:1234` automatically.

LM Studio is the easiest if you don't want a CLI installed at all. Tradeoff:
GUI-only, closed source.

---

## Path C — llama.cpp server

If you want bare-metal control or are running on a constrained device:

```bash
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
make LLAMA_CURL=1
./llama-server -m /path/to/model.gguf --port 8080 --host 127.0.0.1
```

PIPER probes `:8080` — it'll be detected.

llama.cpp's tool-calling support is OpenAI-compatible but format-strict. If
you see persistent "JSON parse error" lines on PIPER's side, your model isn't
emitting valid `tool_calls` — switch to a stricter variant.

---

## Path D — vLLM

For a shared team endpoint on a Linux + CUDA box:

```bash
pip install vllm
python -m vllm.entrypoints.openai.api_server \
  --model qwen/qwen3-coder-30b-a3b \
  --host 0.0.0.0 --port 8000
```

Then on the operator's machine:

```json
{
  "default_provider": "vllm",
  "base_url": "http://<gpu-box>:8000/v1",
  "default_model": "qwen/qwen3-coder-30b-a3b"
}
```

Note `base_url` overrides the localhost default — useful when the GPU box is
elsewhere.

---

## Troubleshooting

### "No models available from this backend"

Probably you haven't `ollama pull`'d anything (or LM Studio hasn't downloaded).
Re-run the pull / download, then `curl http://localhost:11434/v1/models` should
return entries.

### Streaming hangs after a few tokens

Some local models stream slowly under load. Increase the per-action timeout in
your action's args or upgrade to a stronger model.

### "verify failed — ungrounded" on every report

The model isn't citing evidence in the format PIPER expects (`[ev-N]` or
`[ev-1, ev-N]`). Smaller models (< 14B) often skip citations. Either:

1. Bump to a 20B+ model, or
2. Accept the ungrounded warning (the report is still in the audit log) and
   manually verify.

### Model outputs a preamble before the report ("Sto raccogliendo…")

The synthesizer prompt has explicit forbidden openers, but some local models
ignore the instruction. PIPER will retry once. If it persists, swap to a more
disciplined model (Devstral-Small-2 or gpt-oss-20B are usually fine).

### Wizard says "no provider detected"

Make sure your local server is actually listening on its default port:

```bash
lsof -i :11434     # Ollama
lsof -i :1234      # LM Studio
lsof -i :8080      # llama.cpp
lsof -i :8000      # vLLM
```

If it's on a non-standard port, set `PIPER_BASE_URL=http://localhost:<port>/v1`
in your shell and re-run the wizard.

---

## Privacy posture

When a local provider is configured, **nothing leaves your machine** for LLM
inference. PIPER still:

- Logs to PGlite locally (audit + evidence, scrubbed).
- Runs scrubber over messages even though no remote provider exists — defense
  in depth in case you later switch to a remote provider mid-session.
- Spawns local processes via the Executor — but those are CLIs you already
  trust (`ssh`, `ls`, `df`, etc.).

For regulated environments (healthcare, finance, defense), this is the path
that satisfies most data-residency requirements without further configuration.
