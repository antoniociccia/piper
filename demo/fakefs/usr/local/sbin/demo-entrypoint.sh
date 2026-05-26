#!/usr/bin/env bash
# PIPER demo host entrypoint.
#
# Spawns the fake processes that make the host look "alive":
#   - one process that pretends to be `node /opt/orderly/dist/server.js`
#   - one process that pretends to be `nginx: worker process`
#
# Notably, the `orderly worker` process is NOT spawned. The on-disk config
# (/opt/orderly/config.yml) declares it enabled, /var/log/orderly/worker.log
# shows it crashed at boot 3 days ago, and `ps` confirms it's not running.
# That's the planted "missing worker" anomaly.
#
# Finally, exec sshd in the foreground as PID 1's main child.

set -u

# Set the hostname displayed by `uname -n`, `hostname`, and any tool that
# reads /etc/hostname. We do it in the entrypoint because non-root container
# starts can't reliably change /etc/hostname at build time.
hostname demo-host 2>/dev/null || true
echo demo-host > /etc/hostname 2>/dev/null || true

# Cosmetic state directories the config references.
mkdir -p /run/orderly /run/nginx

# --- Fake "orderly web" process ---------------------------------------------
# We use bash's `exec -a` to set $0 (the name `ps` displays) to the path of
# the node binary the config claims is running. The actual command is
# `sleep infinity`, which uses no CPU.
(
  exec -a "node /opt/orderly/dist/server.js" /bin/sleep infinity
) </dev/null >/dev/null 2>&1 &

# --- Fake "nginx worker" process --------------------------------------------
(
  exec -a "nginx: worker process" /bin/sleep infinity
) </dev/null >/dev/null 2>&1 &

# --- sshd (foreground, PID-1 child) -----------------------------------------
exec /usr/sbin/sshd -D -e
