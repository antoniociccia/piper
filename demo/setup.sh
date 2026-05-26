#!/usr/bin/env bash
# PIPER demo host — bring up.
#
# Idempotent:
#   - Generates an SSH keypair (demo/keys/piper-demo) if missing.
#   - Generates host keys (demo/host-keys/ssh_host_{ed25519,rsa}_key) if missing.
#   - Builds + starts the demo container via docker compose.
#   - Waits for sshd on 127.0.0.1:2222.
#   - Prints copy-paste instructions for wiring the env into PIPER.
#
# Make executable once with:   chmod +x demo/setup.sh
# Run from anywhere with:      bash demo/setup.sh

set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
KEY="${DEMO_DIR}/keys/piper-demo"
HOST_KEYS_DIR="${DEMO_DIR}/host-keys"
COMPOSE_FILE="${DEMO_DIR}/docker-compose.yml"
PORT=2222

# --- Pre-flight --------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker is required. Install Docker Desktop or the docker CLI." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: 'docker compose' (v2) is required. Update Docker Desktop." >&2
  exit 1
fi

if ! command -v ssh-keygen >/dev/null 2>&1; then
  echo "ERROR: ssh-keygen is required (part of openssh)." >&2
  exit 1
fi

# --- User key ----------------------------------------------------------------
mkdir -p "${DEMO_DIR}/keys"
if [ ! -f "${KEY}" ]; then
  echo "[setup] generating user SSH key at ${KEY}"
  ssh-keygen -t ed25519 -N "" -C "piper-demo" -f "${KEY}" >/dev/null
else
  echo "[setup] reusing existing user SSH key at ${KEY}"
fi

# --- Host keys (pinned for stable fingerprint across rebuilds) ---------------
mkdir -p "${HOST_KEYS_DIR}"
if [ ! -f "${HOST_KEYS_DIR}/ssh_host_ed25519_key" ]; then
  echo "[setup] generating host ed25519 key"
  ssh-keygen -t ed25519 -N "" -C "piper-demo-host" -f "${HOST_KEYS_DIR}/ssh_host_ed25519_key" >/dev/null
fi
if [ ! -f "${HOST_KEYS_DIR}/ssh_host_rsa_key" ]; then
  echo "[setup] generating host rsa key"
  ssh-keygen -t rsa -b 2048 -N "" -C "piper-demo-host" -f "${HOST_KEYS_DIR}/ssh_host_rsa_key" >/dev/null
fi

# --- known_hosts hygiene -----------------------------------------------------
# Drop any stale entry for [127.0.0.1]:2222 so first connect is clean.
ssh-keygen -R "[127.0.0.1]:${PORT}" >/dev/null 2>&1 || true

# --- Build + start -----------------------------------------------------------
echo "[setup] building + starting piper-demo-host via docker compose..."
docker compose -f "${COMPOSE_FILE}" up -d --build >/dev/null

# --- Wait for sshd -----------------------------------------------------------
echo -n "[setup] waiting for sshd on 127.0.0.1:${PORT} "
ready=0
for attempt in $(seq 1 30); do
  # bash-builtin /dev/tcp works on macOS + Linux without netcat.
  if (echo > "/dev/tcp/127.0.0.1/${PORT}") >/dev/null 2>&1; then
    ready=1
    echo " ready (attempt ${attempt})"
    break
  fi
  echo -n "."
  sleep 1
done

if [ "${ready}" -ne 1 ]; then
  echo
  echo "TIMED OUT after 30s — container never accepted on 127.0.0.1:${PORT}" >&2
  docker compose -f "${COMPOSE_FILE}" logs --tail 50 >&2 || true
  exit 1
fi

# --- Instructions ------------------------------------------------------------
cat <<EOF

================================================================================
  PIPER demo host is UP on 127.0.0.1:${PORT}
================================================================================

  Wire it into PIPER:

      /env add demo deploy@localhost:${PORT} --key ${KEY}

  Manual sanity check (key auth, no password prompt):

      ssh -i ${KEY} \\
          -o UserKnownHostsFile=/dev/null \\
          -o StrictHostKeyChecking=accept-new \\
          -p ${PORT} deploy@127.0.0.1 \\
          "cat /etc/motd && ps aux | grep -E 'orderly|nginx' | grep -v grep"

  Tear down when done:

      bash ${DEMO_DIR}/teardown.sh

  Planted anomalies (so the demo finds something interesting):
    1. App log: recurring ECONNREFUSED on 127.0.0.1:6379 (cache down).
    2. Nginx access log: scans from 198.51.100.42 / Example-Audit-Bot/1.0.
    3. Config declares 'worker' enabled, but no worker process is running
       (and /var/log/orderly/worker.log shows it FATAL-exited at boot).

EOF
