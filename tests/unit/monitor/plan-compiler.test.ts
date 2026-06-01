import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { createCatalog, type Catalog } from '../../../src/actions/catalog.ts';
import type { Action } from '../../../src/actions/types.ts';
import { compileWatchPlan, buildCompilerMessages } from '../../../src/monitor/plan-compiler.ts';

const dockerPs: Action<{ environment: string }, string> = {
  name: 'docker.ps',
  tier: 'read',
  description: 'list containers',
  argsSchema: z.object({ environment: z.string() }),
  buildCommand: () => ['docker', 'ps'],
  parseResult: (raw) => raw.stdout,
};

function makeCatalog(): Catalog {
  const catalog = createCatalog();
  catalog.register(dockerPs);
  return catalog;
}

const GOOD_RESPONSE = [
  'Here is your watch plan:',
  '```yaml',
  'name: staging-health',
  'description: Watch staging containers',
  'environment: staging',
  'checks:',
  '  - action: docker.ps',
  '    args: { environment: staging }',
  '    expect: { kind: all_running }',
  '    every: 30s',
  '```',
].join('\n');

const BAD_THEN_GOOD = [
  // first response references a non-existent action → triggers retry
  ['```yaml', 'name: staging-health', 'description: x', 'environment: staging', 'checks:', '  - action: kubectl.delete', '    args: {}', '    expect: { kind: exit_zero }', '```'].join('\n'),
  GOOD_RESPONSE,
];

describe('monitor/plan-compiler', () => {
  test('buildCompilerMessages includes catalog read actions, environments, and the DSL reference', () => {
    const messages = buildCompilerMessages('watch staging containers', makeCatalog(), ['staging', 'prod']);
    const allText = messages.map((m) => m.content).join('\n');
    expect(allText).toContain('docker.ps');         // catalog
    expect(allText).toContain('staging');           // environments
    expect(allText).toContain('all_running');       // DSL reference
    expect(allText).toContain('watch staging containers'); // user request
    // mutate actions must NOT be offered (catalog here has none, but the prompt must say read-only)
    expect(allText.toLowerCase()).toContain('read-only');
  });

  test('compiles a valid plan from the model response', async () => {
    let calls = 0;
    const result = await compileWatchPlan('watch staging containers', {
      catalog: makeCatalog(),
      environmentNames: ['staging'],
      complete: () => {
        calls += 1;
        return Promise.resolve(GOOD_RESPONSE);
      },
    });
    expect(calls).toBe(1);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.plan.name).toBe('staging-health');
      expect(result.plan.source).toBe('compiled');
      expect(result.plan.checks[0]?.action).toBe('docker.ps');
    }
  });

  test('retries once with validation errors in context, then succeeds', async () => {
    let calls = 0;
    const result = await compileWatchPlan('watch staging', {
      catalog: makeCatalog(),
      environmentNames: ['staging'],
      complete: (messages) => {
        const response = BAD_THEN_GOOD[calls];
        calls += 1;
        if (calls === 2) {
          // the retry prompt must contain the validation error
          const lastMessage = messages[messages.length - 1];
          expect(lastMessage?.content).toContain('not in catalog');
        }
        return Promise.resolve(response ?? '');
      },
    });
    expect(calls).toBe(2);
    expect(result.kind).toBe('ok');
  });

  test('gives up after the retry with a readable error', async () => {
    const result = await compileWatchPlan('watch staging', {
      catalog: makeCatalog(),
      environmentNames: ['staging'],
      complete: () => Promise.resolve('I cannot do that'), // never produces YAML
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toContain('no yaml block');
  });

  test('a complete() that throws yields an error result, not an exception', async () => {
    const result = await compileWatchPlan('watch staging', {
      catalog: makeCatalog(),
      environmentNames: ['staging'],
      complete: () => Promise.reject(new Error('model unreachable')),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toContain('model unreachable');
  });

  test('a mutate-tier action in the response is rejected by the gate and reported', async () => {
    // catalog has only read-tier docker.ps; response references kubectl.delete (not registered)
    const responses = [BAD_THEN_GOOD[0] ?? '', BAD_THEN_GOOD[0] ?? '']; // bad twice
    let calls = 0;
    const result = await compileWatchPlan('delete everything', {
      catalog: makeCatalog(),
      environmentNames: ['staging'],
      complete: () => {
        const r = responses[calls] ?? '';
        calls += 1;
        return Promise.resolve(r);
      },
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toContain('not in catalog');
  });
});
