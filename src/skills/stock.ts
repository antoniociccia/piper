export interface StockSkill {
  readonly name: string;
  readonly text: string;
}

export const DEFAULT_SKILL_NAME = 'default';

const DEFAULT_SKILL = `---
skill: default
description: Universal baseline — system specs, top processes, open ports, deployments, and logs
---

# Default analyze runbook

A baseline sweep of any host. Report, with citations:

- **System specs** — OS/kernel, CPU, memory + swap, disk usage per filesystem, uptime and load.
- **Top processes** — the CPU/memory hogs worth noticing.
- **Open ports** — what is listening, and on which address.
- **Deployments** — docker-compose projects, k8s contexts, non-compose containers,
  and notable systemd services, with their status. Flag anything declared but not running.
- **Logs** — recurring errors in the application and database logs.

Connect the dots when failures are causally linked (e.g. cache down → worker
won't start). Cite every substantive fact. Do not propose mutations.
`;

export const STOCK_SKILLS: readonly StockSkill[] = [
  { name: DEFAULT_SKILL_NAME, text: DEFAULT_SKILL },
];
