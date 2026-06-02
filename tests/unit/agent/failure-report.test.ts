import { describe, expect, test } from 'bun:test';

import { formatFailureReport } from '../../../src/agent/runner.ts';
import type { StepFailure } from '../../../src/agent/types.ts';

const f = (actionName: string, reason: string): StepFailure => ({ stepId: 's', actionName, reason });

describe('agent/runner — formatFailureReport', () => {
  test('lists each failed action with its reason', () => {
    const r = formatFailureReport([f('docker.compose_up', 'verify exited with code 1 (rolled back)')]);
    expect(r).toContain('docker.compose_up');
    expect(r).toContain('verify exited with code 1');
    expect(r).toContain('every step failed');
  });

  test('adds a sudo/daemon hint when the failure looks like a permission problem', () => {
    const r = formatFailureReport([f('docker.compose_up', 'verify exited with code 1 (rolled back)')]);
    expect(r.toLowerCase()).toContain('sudo');
  });

  test('a permission-denied reason triggers the hint', () => {
    const r = formatFailureReport([f('docker.ps', 'execution-failed: permission denied')]);
    expect(r.toLowerCase()).toContain('sudo');
  });

  test('an unrelated failure gets NO sudo hint', () => {
    const r = formatFailureReport([f('system.disk_usage', 'timeout: killed after 30000ms')]);
    expect(r.toLowerCase()).not.toContain('sudo');
    expect(r).toContain('system.disk_usage');
  });
});
