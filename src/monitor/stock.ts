// src/monitor/stock.ts
//
// Bundled "stock" watch plans. Plans are TS string constants (template literals)
// so they survive `bun build --compile` with zero asset-bundling work.
//
// The placeholder __ENV__ is replaced with a real environment name at instantiation
// time. Using __ENV__ (not ENV) avoids corrupting prose words like "ENVIRONMENT".
//
// CONSTRAINT: every action referenced here MUST exist in the builtin catalog with
// tier=read, and every args object MUST satisfy that action's argsSchema. The test
// in tests/unit/monitor/stock.test.ts enforces this against the real catalog.

export interface StockPlan {
  readonly name: string;
  /** Raw plan text — contains __ENV__ placeholders. Call instantiateStockPlan before parsing. */
  readonly text: string;
}

// ── docker-basics ─────────────────────────────────────────────────────────────
// Uses: docker.ps (list containers), system.disk_usage (disk not filling)
// docker.ps returns DockerContainer[] — all_running expectation makes sense.
// system.disk_usage returns DiskUsageEntry[] with percentUsed strings — max_percent
// is evaluated by the runner against the numeric portion of percentUsed.
const DOCKER_BASICS = `---
name: docker-basics
description: Containers up, no error spam in logs, disk not filling
environment: __ENV__
checks:
  - name: containers-running
    action: docker.ps
    args:
      environment: __ENV__
      all: true
    expect:
      kind: all_running
    every: 30s
  - name: disk-space
    action: system.disk_usage
    args:
      environment: __ENV__
    expect:
      kind: max_percent
      value: 90
    every: 5m
---

# Docker basics runbook

## Containers not all running

Run \`docker.ps\` with \`all: true\` to see stopped containers and their exit codes.
The two most common causes:

1. **The database container died first** — the app container follows it on connection
   refused. Check the db container logs (\`docker.logs\` with the db container name)
   before blaming the app container.
2. **Disk full** — if the disk check is also failing, that is the root cause: Docker
   cannot write layers or volumes to a full filesystem. Free space before restarting
   containers.

If containers were restarted recently, check who triggered the restart (systemd
journal, \`docker.logs\`, or \`system.dmesg\`) before assuming a crash loop.

## Disk usage above 90 %

Run \`system.disk_usage\` with a specific \`path\` (e.g. \`/var/lib/docker\`) to
identify which filesystem is filling up. Common Docker disk consumers:

- Dangling images (\`docker image prune\`) — propose as a mutate action after diagnosis.
- Large log files — consider log rotation in the compose file (\`max-size\`, \`max-file\`).
- Unused volumes (\`docker volume prune\`).

Never prune without human approval — the PIPER approval gate will prompt you.
`;

// ── k8s-basics ────────────────────────────────────────────────────────────────
// Uses: kubectl.get pods (regex_absent for bad pod states), kubectl.events
// (regex_absent for Warning events), kubectl.top_pod (resource hogs)
// kubectl.get returns {raw, lines} — regex_absent on raw for CrashLoopBackOff /
// OOMKilled / Evicted / Error patterns is the right liveness gate.
// kubectl.events returns {raw: string} — regex_absent for "Warning" events.
const K8S_BASICS = `---
name: k8s-basics
description: Pods healthy, no Warning events, resource usage in check
environment: __ENV__
defaults:
  every: 60s
checks:
  - name: pods-healthy
    action: kubectl.get
    args:
      environment: __ENV__
      resource: pods
      all_namespaces: true
    expect:
      kind: regex_absent
      pattern: "CrashLoopBackOff|OOMKilled|Evicted|Error"
    every: 30s
  - name: no-warning-events
    action: kubectl.events
    args:
      environment: __ENV__
      all_namespaces: true
      field_selector: "type=Warning"
    expect:
      kind: regex_absent
      pattern: "BackOff|OOMKilling|Evicted|FailedScheduling"
    every: 2m
  - name: pod-resource-usage
    action: kubectl.top_pod
    args:
      environment: __ENV__
      all_namespaces: true
      sort_by: memory
    expect:
      kind: exit_zero
    every: 5m
---

# Kubernetes basics runbook

## Pods not healthy (CrashLoopBackOff / OOMKilled / Evicted / Error)

Run \`kubectl.get\` with \`resource: pods\` and \`all_namespaces: true\` to see the
current pod table. Then narrow to the failing pod with \`kubectl.describe\` for the
full event history and last exit reason.

Common causes:

- **CrashLoopBackOff** — application is crashing on startup. Check \`kubectl.logs\`
  for the container's stderr. Look for missing env vars, failed DB migrations, or
  out-of-memory exits.
- **OOMKilled** — the container hit its memory limit. The \`kubectl.top_pod\`
  check shows current usage; compare against the limit in the pod spec. Either
  reduce memory consumption or increase the limit (mutate action, requires approval).
- **Evicted** — node ran out of resources. Check node pressure with
  \`kubectl.get\` on \`nodes\` and \`kubectl.events\` filtered to the node.

## Warning events (BackOff / OOMKilling / FailedScheduling)

Warning events are often early signals before a pod enters a bad state. Run
\`kubectl.events\` without a field_selector to see the full event stream. Filter
by the object name from the event to find the affected resource.

## pod-resource-usage check error

\`kubectl top pod\` requires metrics-server. If the check consistently returns a
non-zero exit code, verify metrics-server is running:
\`kubectl.get\` with \`resource: pods\`, \`namespace: kube-system\`,
\`label_selector: k8s-app=metrics-server\`.
`;

// ── disk-and-memory ───────────────────────────────────────────────────────────
// Uses: system.disk_usage (max_percent 85), system.memory (swap-pressure check).
// system.memory returns {raw: string, ...} — the raw field contains the `free -h`
// output. The swap check uses regex_absent on the pattern
// Swap:\s+\S+\s+[1-9]\d*(\.\d+)?Gi, which matches only when the USED column (second
// column of the Swap line) is in the gigabyte range. The total column is consumed by
// \S+ and skipped; [1-9] prevents a false alarm on "0B" or sub-1Gi MB values.
// Healthy output: "Swap:  2.0Gi  0B  2.0Gi" — no match, check passes.
// Swapping output: "Swap:  2.0Gi  1.5Gi  512Mi" — match, check fails.
// OOM kill detection (dmesg-level) requires system.dmesg and is handled by the LLM
// diagnosis flow, not the deterministic watch check.
const DISK_AND_MEMORY = `---
name: disk-and-memory
description: Host disk usage below threshold and no swap exhaustion
environment: __ENV__
defaults:
  every: 5m
checks:
  - name: disk-below-85pct
    action: system.disk_usage
    args:
      environment: __ENV__
    expect:
      kind: max_percent
      value: 85
    every: 5m
  - name: memory-ok
    action: system.memory
    args:
      environment: __ENV__
    expect:
      kind: regex_absent
      pattern: "Swap:\\\\s+\\\\S+\\\\s+[1-9]\\\\d*(\\\\.\\\\d+)?Gi"
    every: 2m
---

# Disk and memory runbook

## Disk usage above 85 %

Run \`system.disk_usage\` with a specific \`path\` to narrow down which filesystem
is filling up. Common culprits:

- **/var/log** — unrotated application logs. Check with \`system.list_dir\` and
  set up log rotation.
- **/var/lib/docker** — Docker image and volume data. Use
  \`docker.ps\` to see what is running, then prune dangling images (with approval).
- **/tmp** — large temporary files from application processing.
- **Home directories** — user data or build artifacts accumulating over time.

Act before reaching 95 %: at that point, most Linux services start failing to
write and processes crash unpredictably.

## Memory swap pressure

The \`memory-ok\` check reads \`free -h\` output and alarms when the swap USED column
reaches the gigabyte range (pattern: \`Swap: <total> <used>\` where used ≥ 1Gi).
Sub-gigabyte swap usage (e.g. \`512Mi\`) and zero swap usage (\`0B\`) are both healthy.

When the check fails, run \`system.memory\` to see the full picture, then use
\`system.process_list\` to find the top memory consumers. Common causes:

- A memory-leaking application that has been running for days without restart.
- A runaway build or test process consuming all available RAM.
- Under-provisioned VM — add RAM or reduce the number of running containers.

For OOM kills (processes already killed by the kernel), use \`system.dmesg\` — OOM
killer invocations appear in the kernel ring buffer, not in \`free -h\` output.
`;

// ── Registry ──────────────────────────────────────────────────────────────────

export const STOCK_PLANS: readonly StockPlan[] = [
  { name: 'docker-basics', text: DOCKER_BASICS },
  { name: 'k8s-basics', text: K8S_BASICS },
  { name: 'disk-and-memory', text: DISK_AND_MEMORY },
];

/**
 * Stock plans use the placeholder __ENV__ for the environment name. Resolve it
 * to a real registered environment name before passing to parseWatchPlan.
 *
 * Using __ENV__ (double-underscored) rather than ENV avoids corrupting prose
 * words that contain the substring "ENV" (e.g. "ENVIRONMENT", "env vars").
 */
export function instantiateStockPlan(text: string, environmentName: string): string {
  return text.replaceAll('__ENV__', environmentName);
}
