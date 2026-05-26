#!/usr/bin/env bash
# PIPER demo host — bring down.
#
# Make executable once with:   chmod +x demo/teardown.sh
# Run with:                    bash demo/teardown.sh           (keeps keys)
#                              bash demo/teardown.sh --wipe    (also deletes keys)

set -euo pipefail

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="${DEMO_DIR}/docker-compose.yml"
PORT=2222

echo "[teardown] stopping piper-demo-host..."
docker compose -f "${COMPOSE_FILE}" down -v >/dev/null 2>&1 || true

# Drop the stale known_hosts entry, the container fingerprint stays the same
# across rebuilds but we still want a clean state if the user wipes keys.
ssh-keygen -R "[127.0.0.1]:${PORT}" >/dev/null 2>&1 || true

if [ "${1:-}" = "--wipe" ]; then
  echo "[teardown] --wipe: removing generated keys"
  rm -f "${DEMO_DIR}/keys/piper-demo" "${DEMO_DIR}/keys/piper-demo.pub"
  rm -f "${DEMO_DIR}/host-keys/ssh_host_ed25519_key"   "${DEMO_DIR}/host-keys/ssh_host_ed25519_key.pub"
  rm -f "${DEMO_DIR}/host-keys/ssh_host_rsa_key"       "${DEMO_DIR}/host-keys/ssh_host_rsa_key.pub"
fi

echo "[teardown] done."
