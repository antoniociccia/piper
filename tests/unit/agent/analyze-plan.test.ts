import { describe, expect, test } from 'bun:test';

import { createCatalog } from '../../../src/actions/catalog.ts';
import { registerBuiltins } from '../../../src/actions/builtin/index.ts';
import { buildDiscoveryPlan } from '../../../src/agent/analyze.ts';

const catalog = (() => {
  const c = createCatalog();
  registerBuiltins(c);
  return c;
})();

describe('buildDiscoveryPlan', () => {
  const plan = buildDiscoveryPlan('demo');

  test('every step targets the given environment', () => {
    for (const step of plan.steps) {
      expect((step.args as { environment: string }).environment).toBe('demo');
    }
  });

  test('every step references a real read-tier action with valid args', () => {
    for (const step of plan.steps) {
      const action = catalog.resolve(step.actionName);
      expect(action, `unknown action ${step.actionName}`).toBeDefined();
      expect(action!.tier).toBe('read');
      const parsed = action!.argsSchema.safeParse(step.args);
      expect(parsed.success, `bad args for ${step.actionName}: ${JSON.stringify(step.args)}`).toBe(true);
    }
  });

  test('covers specs, processes, ports, and deployment discovery', () => {
    const names = plan.steps.map((s) => s.actionName);
    expect(names).toContain('system.os_info');
    expect(names).toContain('system.memory');
    expect(names).toContain('system.disk_usage');
    expect(names).toContain('system.process_list');
    expect(names).toContain('network.connections');
    expect(names).toContain('docker.compose_ls');
    expect(names).toContain('discover.compose_files');
    expect(names).toContain('kubectl.context_current');
  });

  test('step ids are unique', () => {
    const ids = plan.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
