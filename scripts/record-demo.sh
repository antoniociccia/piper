#!/usr/bin/env bash
# scripts/record-demo.sh — record the README demo end-to-end.
#
# Wraps asciinema + agg around a real PIPER session against the local Docker
# demo host. Output: docs/assets/demo.cast (asciinema replay) +
# docs/assets/demo.gif (README-embed-ready).
#
# Requirements:
#   brew install asciinema agg              # macOS
#   bash demo/setup.sh && docker compose -f demo/docker-compose.yml up -d
#
# This script does NOT type the prompts for you — it just sets up the
# environment, prints the script you should follow, and starts the recorder.
# Type the prompts at your own pace; asciinema captures them verbatim.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
CAST="${REPO_ROOT}/docs/assets/demo.cast"
GIF="${REPO_ROOT}/docs/assets/demo.gif"
DEMO_DATA="${REPO_ROOT}/demo/.piper-demo-data"

mkdir -p docs/assets

# --- Pre-flight -------------------------------------------------------------
for tool in asciinema agg bun docker; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: '$tool' is required. brew install $tool" >&2
    exit 1
  fi
done

# Demo host must be reachable on :2222.
if ! ssh -q -i demo/keys/piper-demo \
       -o UserKnownHostsFile=/dev/null \
       -o StrictHostKeyChecking=no \
       -o ConnectTimeout=3 \
       -o BatchMode=yes \
       -p 2222 deploy@127.0.0.1 'true' 2>/dev/null; then
  echo "[record] demo host not reachable on 127.0.0.1:2222"
  echo "[record] run: bash demo/setup.sh && docker compose -f demo/docker-compose.yml up -d"
  exit 1
fi
echo "[record] demo host OK"

# Clear the isolated PIPER data dir so the recording is reproducible
# (no carry-over sessions or env from previous runs).
if [ -d "$DEMO_DATA" ]; then
  echo "[record] wiping previous demo session data ($DEMO_DATA)"
  rm -rf "$DEMO_DATA"
fi

# Reset the demo host's restart marker so the stack starts in the broken
# state (worker + redis exited). The marker is what `compose restart` flips.
echo "[record] resetting demo host restart state"
ssh -q -i demo/keys/piper-demo \
    -o UserKnownHostsFile=/dev/null \
    -o StrictHostKeyChecking=no \
    -p 2222 deploy@127.0.0.1 'sudo -n rm -f /tmp/piper-demo-restarted' || {
  echo "[record] WARNING: could not reset restart marker (old demo image without sudo?)"
  echo "[record] rebuild with: docker compose -f demo/docker-compose.yml up -d --build"
}

# --- Recording script — what to type once PIPER starts ----------------------
cat <<'EOF'

================================================================================
  RECORDING THE PIPER DEMO

  Everything is already wired: the demo host is registered as `demo`, the
  model is local, and the data dir is isolated. You only type the prompt.

  Wait for each reply to finish before moving on — asciinema compresses the
  idle gaps afterwards, so thinking time costs the GIF nothing.

  ── THE TAKE ────────────────────────────────────────────────────────────

    1.  analyze demo and tell me everything that is broken

        Then, as it runs:

        a) A deterministic plan of 13 read steps appears.        press  y
        b) The docker probes hit "permission denied ... Docker
           daemon socket", and the SUDO PANEL shows the verbatim
           elevated command that would run.                      press  r
           (r = remember for this session, so the remaining
            docker probes do not prompt again)
        c) The baseline report streams, every claim carrying an
           [ev-N] citation back to the command that produced it.
        d) A FOLLOW-UP PROPOSAL appears — PIPER chaining a drill
           from its own discovery.                               press  y
        e) The report EXTENDS itself: redis OOM-killed -> worker
           refused to start -> web in degraded mode. Connected,
           and cited.

    2.  Ctrl+C   (twice, to exit)

  ── WHAT THE FRAME SHOULD SHOW ──────────────────────────────────────────

  The status bar reads "qwen3.5:9b  ...  * local". That line is the whole
  pitch: no API key, no network, nothing leaving the machine.

  ── NOTES ───────────────────────────────────────────────────────────────

  * kubectl.context_current fails on the demo host (no kubectl installed).
    Leave it in — a reported failed step is graceful degradation, not a flaw.
  * The follow-up proposal is the one LLM-driven beat, so it is the only
    non-deterministic part. Do ONE dry run first and check the proposer
    actually chains a log action on your model. If it does not, re-run.
  * Terminal size is pinned to 140x44 by the recorder — do not resize.
  * Typos do not matter. Re-run the script for another take.

  Shorter alternative, if the full take runs long:

    check uptime, memory and disk on demo -- flag anything unhealthy

  Three actions, one approval, a cited report. Less dramatic, much tighter.

EOF
read -r -p "[record] press Enter to start the recorder, Ctrl+C to abort … " _

# --- Record -----------------------------------------------------------------
# asciinema 3.x:
#   --window-size COLSxROWS   pins the canvas (was --cols/--rows in 2.x)
#   --command "…"             wraps a single command; recorder closes when it exits
#   --idle-time-limit SECS    compresses idle gaps in the playback
#   --output-format asciicast-v2  pinned for compatibility with agg ≤ 1.8
rm -f "$CAST"

# PIPER env for the demo:
# - isolated data dir → never touches the user's real ~/.piper/data
# - isolated credentials → never touches the user's real ~/.piper/credentials.json
# - WASM embedder pre-selected → no embedding-backend wizard during the take
export PIPER_DATA_DIR="$DEMO_DATA"
export PIPER_EMBEDDING_BACKEND=wasm
export PIPER_CREDENTIALS_FILE="${DEMO_DIR:-$REPO_ROOT/demo}/.piper-demo-credentials.json"

# The demo host is registered here rather than typed as `/env add` during the
# take: the recording should spend its seconds on the product, not on setup.
# The model is pinned to a local one so the status bar reads "◆ local" — the
# whole point being that this runs with no API key and no network.
DEMO_MODEL="${DEMO_MODEL:-qwen3.5:9b}"
cat > "$PIPER_CREDENTIALS_FILE" <<JSON
{
  "default_provider": "ollama",
  "default_model": "${DEMO_MODEL}",
  "base_url": "http://localhost:11434/v1",
  "embedding_backend": "wasm",
  "max_session_cost_usd": 0.5,
  "environments": {
    "demo": {
      "host": "localhost",
      "ssh_user": "deploy",
      "port": 2222,
      "identity_file": "${REPO_ROOT}/demo/keys/piper-demo",
      "description": "demo application host",
      "tags": ["demo"]
    }
  }
}
JSON
chmod 600 "$PIPER_CREDENTIALS_FILE"

if ! curl -s -m 3 http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "[record] ERROR: no Ollama on :11434. Start it with 'ollama serve'." >&2
  exit 1
fi
if ! curl -s -m 5 http://localhost:11434/api/tags | grep -q "\"${DEMO_MODEL%%:*}"; then
  echo "[record] ERROR: ${DEMO_MODEL} is not installed. Run: ollama pull ${DEMO_MODEL}" >&2
  exit 1
fi
echo "[record] local model: ${DEMO_MODEL}  ·  demo host registered as 'demo'"

# Pinned canvas: 140 cols × 42 rows.
#   - 140 wide gives PIPER's status bar room to breathe without wrapping
#     ("cost · model · OR credit · token meter · MODE" is long)
#   - 42 tall: ~4 rows for the status bar / input / spacer + ~38 for content,
#     so the streaming reply doesn't push the input box off-screen
# These dimensions MUST match between asciinema and agg, otherwise the GIF
# is cropped or letter-boxed.
WIN_COLS=140
WIN_ROWS=44

asciinema rec "$CAST" \
  --window-size "${WIN_COLS}x${WIN_ROWS}" \
  --idle-time-limit 1.5 \
  --output-format asciicast-v2 \
  --overwrite \
  --command "bun run src/index.tsx"

echo
echo "[record] asciinema cast saved to $CAST"
echo "[record] cast size: $(wc -c <"$CAST") bytes (sanity check; <500 bytes = empty take)"

# --- Convert to GIF ---------------------------------------------------------
#   --cols/--rows    must match the recording window (set above)
#   --font-size 16   default; 140×42 @ 16 → ~1400×940 GIF, crisp on retina,
#                    GitHub fits it to width="900" in the README
#   --fps-cap 20     smooth enough for the eye, ~33% smaller GIF than the
#                    30 fps default
#   --speed 1.25     natural pace, not "watch me type" sluggish
agg "$CAST" "$GIF" \
  --speed 1.25 \
  --font-size 16 \
  --cols "${WIN_COLS}" \
  --rows "${WIN_ROWS}" \
  --fps-cap 20 \
  --theme monokai \
  --last-frame-duration 4

echo
echo "[record] GIF written to $GIF"
echo "[record] play the cast locally with:  asciinema play $CAST"
echo "[record] preview the GIF with:        open $GIF"
echo
echo "[record] commit both files when you're happy with the take."
