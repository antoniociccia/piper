# Orderly worker keeps dying — redis ECONNREFUSED

## Symptom

The `orderly-worker-1` container is missing from `docker ps`. `docker ps -a`
shows it in state `Exited (1)`. The worker log (`docker logs orderly-worker-1`
or `/var/log/orderly/worker.log`) contains:

```
[error] redis attach failed: connect ECONNREFUSED 127.0.0.1:6379
[fatal] cannot operate without cache; exiting with code 1
```

The web tier (`orderly-web-1`) is up but logs the same connection failures and
falls back to "degraded read-only mode" — slower responses, no per-session
state, no event queue draining.

## Root cause

The worker treats redis as a hard dependency: if the cache isn't reachable at
boot, the process aborts intentionally (it would otherwise lose every job).
The web tier is more permissive — it stays up in degraded mode.

The actual reason redis is unreachable is one of three patterns. Check in
order:

1. **Redis itself is dead.** `docker ps -a` shows `orderly-redis-1` exited.
   Inspect for the exit code:
   - `137` → OOM-killed (kernel cgroup limit). See "Fixing redis OOM" below.
   - `0` → graceful stop. Someone (or another script) ran `docker stop`.
   - `1` → config error in the redis container.
2. **Redis is up but unreachable on the expected port/host.** The compose
   network may be in a wedged state. `docker network ls` then `docker network
   inspect orderly_default`.
3. **The worker is configured against the wrong host.** Some `config.yml`
   templates use `127.0.0.1:6379` instead of `redis:6379`. The former
   resolves to the worker container itself, NOT the redis container, and so
   refuses on principle.

## Fix

If redis was OOM-killed:

```bash
# Confirm the kill
docker inspect orderly-redis-1 --format '{{.State.ExitCode}}'   # → 137

# Inspect memory configuration
docker inspect orderly-redis-1 --format '{{.HostConfig.Memory}}'

# Restart redis + worker
docker compose -f /opt/orderly/docker-compose.yml up -d redis
docker compose -f /opt/orderly/docker-compose.yml up -d worker
```

After restart, watch for the next OOM:

```bash
docker stats --no-stream orderly-redis-1
docker logs --tail 50 orderly-redis-1
```

If memory pressure recurs, either raise the redis container's memory limit
(temporary) or apply a redis eviction policy (`maxmemory-policy
allkeys-lru`).

## Diagnosis hints for the agent

- The hostname of the demo host is `demo-host`.
- `docker ps -a` is the single most-informative read action here. The exit
  codes tell the whole story (`137` for redis = OOM, `1` for worker = chosen
  abort).
- `docker logs orderly-worker-1` is short — a dozen lines — but it
  EXPLICITLY mentions `ECONNREFUSED 127.0.0.1:6379` and "cannot operate
  without cache". Cite this line in the answer.
- `ps -eo args` on the host won't show the worker (it's in a stopped
  container) but will show `orderly-web-1` running. The absence is the signal.

## Related

- runbook: redis-oom-eviction-policy (not in this demo)
- ADR: container-restart-policy
