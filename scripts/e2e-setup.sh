#!/usr/bin/env bash
# Bring up the PIPER end-to-end SSH fixture.
# Idempotent: generates the test SSH key if missing, then docker-compose up.
set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "$0")"/../tests/fixtures/sshd-docker && pwd)"
KEY="${FIXTURE_DIR}/keys/piper-e2e-test"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for e2e tests; install Docker Desktop or the docker CLI" >&2
  exit 1
fi

if [ ! -f "${KEY}" ]; then
  echo "generating ${KEY}"
  ssh-keygen -t ed25519 -N "" -C "piper-e2e-test" -f "${KEY}" >/dev/null
fi

# Stable host keys: generated once, copied into the container at build time.
# This keeps the sshd fingerprint constant across rebuilds so known_hosts +
# StrictHostKeyChecking=accept-new keeps working.
HOST_KEYS_DIR="${FIXTURE_DIR}/host-keys"
mkdir -p "${HOST_KEYS_DIR}"
if [ ! -f "${HOST_KEYS_DIR}/ssh_host_ed25519_key" ]; then
  ssh-keygen -t ed25519 -N "" -C "piper-e2e-host" -f "${HOST_KEYS_DIR}/ssh_host_ed25519_key" >/dev/null
fi
if [ ! -f "${HOST_KEYS_DIR}/ssh_host_rsa_key" ]; then
  ssh-keygen -t rsa -b 2048 -N "" -C "piper-e2e-host" -f "${HOST_KEYS_DIR}/ssh_host_rsa_key" >/dev/null
fi

# Best-effort known_hosts cleanup; tolerate malformed files.
ssh-keygen -R "[127.0.0.1]:12222" >/dev/null 2>&1 || true

echo "starting piper-e2e-sshd via docker compose..."
docker compose -f "${FIXTURE_DIR}/docker-compose.yml" up -d --build >/dev/null

# Wait for sshd to accept connections (up to 30s).
for attempt in $(seq 1 30); do
  if nc -z 127.0.0.1 12222 2>/dev/null; then
    echo "ready (attempt ${attempt})"
    exit 0
  fi
  sleep 1
done

echo "TIMED OUT: container never accepted on 127.0.0.1:12222" >&2
docker compose -f "${FIXTURE_DIR}/docker-compose.yml" logs --tail 30 >&2 || true
exit 1
