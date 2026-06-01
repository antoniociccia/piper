import { describe, expect, test } from 'bun:test';

import {
  parseWatchPlan,
  serializeWatchPlan,
  splitFrontmatter,
} from '../../../src/monitor/plan-loader.ts';
import { InvalidWatchPlanError } from '../../../src/monitor/types.ts';

const VALID = [
  '---',
  'name: staging-health',
  'description: Staging containers and disk',
  'environment: staging',
  'defaults: { every: 60s }',
  'checks:',
  '  - action: docker.ps',
  '    args: { environment: staging }',
  '    expect: { kind: all_running }',
  '    every: 30s',
  '  - action: system.disk_usage',
  '    args: { environment: staging }',
  '    expect: { kind: max_percent, value: 90 }',
  '---',
  '',
  '# Runbook',
  '',
  'Compose file at /opt/deploy/docker-compose.yml.',
].join('\n');

describe('monitor/plan-loader — splitFrontmatter', () => {
  test('splits frontmatter from body', () => {
    const { frontmatterRaw, body } = splitFrontmatter(VALID);
    expect(frontmatterRaw).toContain('name: staging-health');
    expect(body).toContain('# Runbook');
    expect(body).not.toContain('---');
  });

  test('rejects files without frontmatter delimiters', () => {
    expect(() => splitFrontmatter('# just markdown')).toThrow(InvalidWatchPlanError);
    expect(() => splitFrontmatter('---\nunclosed: true\n')).toThrow(InvalidWatchPlanError);
  });
});

describe('monitor/plan-loader — parseWatchPlan', () => {
  test('parses a valid plan with defaults and per-check override', () => {
    const plan = parseWatchPlan(VALID, 'user');
    expect(plan.name).toBe('staging-health');
    expect(plan.environment).toBe('staging');
    expect(plan.checks).toHaveLength(2);
    expect(plan.checks[0]?.intervalMs).toBe(30_000); // per-check override
    expect(plan.checks[1]?.intervalMs).toBe(60_000); // plan default
    expect(plan.checks[0]?.name).toBe('docker.ps');
    expect(plan.runbook).toContain('Compose file');
    expect(plan.source).toBe('user');
  });

  test('check names are unique (suffix on action collision)', () => {
    const text = VALID.replace('system.disk_usage', 'docker.ps');
    const plan = parseWatchPlan(text, 'user');
    expect(plan.checks[0]?.name).toBe('docker.ps');
    expect(plan.checks[1]?.name).toBe('docker.ps-2');
  });

  test('reports the failing field on schema violations', () => {
    const broken = VALID.replace('name: staging-health', 'name: NOT VALID NAME');
    expect(() => parseWatchPlan(broken, 'user')).toThrow(/name/);
  });

  test('a plan with no checks is rejected', () => {
    const noChecks = [
      '---',
      'name: empty',
      'description: x',
      'environment: staging',
      'checks: []',
      '---',
      'body',
    ].join('\n');
    expect(() => parseWatchPlan(noChecks, 'user')).toThrow(InvalidWatchPlanError);
  });

  test('a check without `every` and without plan defaults gets the 60s fallback', () => {
    const noDefaults = VALID.replace('defaults: { every: 60s }\n', '').replace(
      '    every: 30s\n',
      '',
    );
    const plan = parseWatchPlan(noDefaults, 'user');
    expect(plan.checks[0]?.intervalMs).toBe(60_000);
  });
});

describe('monitor/plan-loader — serializeWatchPlan round-trip', () => {
  test('serialize → parse yields an equivalent plan', () => {
    const original = parseWatchPlan(VALID, 'compiled');
    const text = serializeWatchPlan(original);
    const reparsed = parseWatchPlan(text, 'compiled');
    expect(reparsed.name).toBe(original.name);
    expect(reparsed.environment).toBe(original.environment);
    expect(reparsed.checks).toEqual(original.checks);
    expect(reparsed.runbook.trim()).toBe(original.runbook.trim());
  });
});
