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

  Once PIPER opens, type EACH prompt and wait for the reply to finish before
  moving on. Take your time — asciinema will compress idle gaps later.

  Prompt order — restart + reactive sudo (the v0.4.x money shot):

    1.  /env add demo deploy@localhost:2222 --key demo/keys/piper-demo
    2.  restart the compose stack at /opt/orderly on demo — redis OOM'd
        and the worker is down
        (planner proposes 'docker.compose_restart'; approval panel appears)
        → press 'y' on the plan-approval panel
        → the read-only snapshot probe hits "permission denied … Docker
          daemon socket" → SUDO ELEVATION PANEL appears
        → approve sudo — the whole mutation re-runs elevated
        → MAGENTA MUTATION PANEL appears with the verbatim 'sudo -n docker
          compose … restart' command, dry-run, pre-state snapshot, and the
          [a]/[r]/[n] row
        → press 'a' (approve once) — execute + verify run, every service
          comes back up
    3.  is everything running now?
        (read-only follow-up; grounded answer citing compose ps)
    4.  /quit

  Tip: don't worry about typos — re-run the script to redo the take.
  Tip: terminal recommended size 120×32 — wider feels cinematic, ≥32 rows
       avoids the status bar wrapping.

  Stop recording with /quit inside PIPER (clean exit), or Ctrl+D as fallback.
================================================================================

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
# - WASM embedder pre-selected → no embedding-backend wizard during the take
export PIPER_DATA_DIR="$DEMO_DATA"
export PIPER_EMBEDDING_BACKEND=wasm

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
