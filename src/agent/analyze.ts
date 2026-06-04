import type { Plan, PlanStep } from './types.ts';

interface StepSpec {
  readonly action: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly description: string;
}

/** The deterministic, skill-independent discovery sweep. Same actions, same
 *  order, every run — this is the reproducible "first step". */
export function buildDiscoveryPlan(environment: string): Plan {
  const env = { environment };
  const specs: readonly StepSpec[] = [
    { action: 'system.os_info', args: env, description: 'OS / kernel' },
    { action: 'system.cpu_info', args: env, description: 'CPU' },
    { action: 'system.memory', args: env, description: 'memory + swap' },
    { action: 'system.disk_usage', args: env, description: 'disk usage' },
    { action: 'system.uptime', args: env, description: 'uptime + load' },
    { action: 'system.process_list', args: { ...env, limit: 15 }, description: 'top processes' },
    { action: 'network.connections', args: { ...env, listening_only: true }, description: 'open ports' },
    { action: 'docker.ps', args: { ...env, all: true }, description: 'containers (incl. stopped)' },
    { action: 'docker.compose_ls', args: { ...env, all: true }, description: 'compose projects' },
    { action: 'discover.compose_files', args: env, description: 'compose files on disk' },
    { action: 'kubectl.context_current', args: env, description: 'kubernetes context' },
    { action: 'system.systemctl_list', args: { ...env, state: 'active' }, description: 'active services' },
  ];

  const steps: PlanStep[] = specs.map((s, i) => ({
    id: `discover-${i + 1}`,
    actionName: s.action,
    args: s.args,
    description: s.description,
  }));

  return {
    steps,
    parallelismHint: { fanout: steps.length, reasoning: 'deterministic baseline discovery sweep' },
    rationale: `baseline analyze discovery of ${environment}`,
  };
}
