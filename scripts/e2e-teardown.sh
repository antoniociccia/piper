#!/usr/bin/env bash
set -euo pipefail
FIXTURE_DIR="$(cd "$(dirname "$0")"/../tests/fixtures/sshd-docker && pwd)"
docker compose -f "${FIXTURE_DIR}/docker-compose.yml" down -v >/dev/null 2>&1 || true
echo "piper-e2e-sshd stopped"
