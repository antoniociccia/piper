import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { createCatalog, type Catalog } from '../../src/actions/catalog.ts';
import type { Action } from '../../src/actions/types.ts';
import { parseWatchPlan, validateAgainstCatalog } from '../../src/monitor/plan-loader.ts';
import { InvalidWatchPlanError } from '../../src/monitor/types.ts';

const readEcho: Action<{ environment: string }, string> = {
  name: 'fake.read_echo',
  tier: 'read',
  description: 'fake read action',
  argsSchema: z.object({ environment: z.string() }),
  buildCommand: () => ['echo', 'ok'],
  parseResult: (raw) => raw.stdout,
};

const mutateAction: Action<{ environment: string }, string> = {
  name: 'fake.mutate',
  tier: 'mutate',
  description: 'fake mutate action',
  argsSchema: z.object({ environment: z.string() }),
  buildCommand: () => ['echo', 'mutate'],
  parseResult: (raw) => raw.stdout,
};

const destructiveAction: Action<{ environment: string }, string> = {
  name: 'fake.destroy',
  tier: 'destructive',
  description: 'fake destructive action',
  argsSchema: z.object({ environment: z.string() }),
  buildCommand: () => ['echo', 'destroy'],
  parseResult: (raw) => raw.stdout,
};

function makeCatalog(): Catalog {
  const catalog = createCatalog();
  catalog.register(readEcho);
  catalog.register(mutateAction);
  catalog.register(destructiveAction);
  return catalog;
}

function planText(actionName: string, args = '{ environment: staging }'): string {
  return [
    '---',
    'name: gate-test',
    'description: gate test plan',
    'environment: staging',
    'checks:',
    `  - action: ${actionName}`,
    `    args: ${args}`,
    '    expect: { kind: exit_zero }',
    '    every: 30s',
    '---',
    '',
    '# Runbook',
    'Look at the logs.',
  ].join('\n');
}

describe('GATE: deep-freeze on check args', () => {
  test('check args are deep-frozen — nested objects cannot be mutated after validation', () => {
    const plan = parseWatchPlan(
      [
        '---',
        'name: gate-test',
        'description: gate test plan',
        'environment: staging',
        'checks:',
        '  - action: fake.read_echo',
        '    args: { environment: staging, opts: { flag: safe } }',
        '    expect: { kind: exit_zero }',
        '    every: 30s',
        '---',
        'body',
      ].join('\n'),
      'user',
    );
    const check = plan.checks[0];
    expect(check).toBeDefined();
    expect(Object.isFrozen(check?.args)).toBe(true);
    const opts = check?.args['opts'] as Record<string, unknown>;
    expect(Object.isFrozen(opts)).toBe(true);
    expect(() => {
      opts['flag'] = 'INJECTED';
    }).toThrow(TypeError);
    expect(opts['flag']).toBe('safe');
  });
});

describe('GATE: prototype pollution via plan files', () => {
  test('__proto__ keys in args do not pollute Object.prototype', () => {
    const plan = parseWatchPlan(
      [
        '---',
        'name: gate-test',
        'description: gate test plan',
        'environment: staging',
        'checks:',
        '  - action: fake.read_echo',
        '    args: { environment: staging, __proto__: { polluted: yes } }',
        '    expect: { kind: exit_zero }',
        '    every: 30s',
        '---',
        'body',
      ].join('\n'),
      'user',
    );
    // parsing must not have polluted the global prototype
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    // and the plan's own args must not expose the injected key as an own property either
    const check = plan.checks[0];
    expect(check).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(check?.args ?? {}, 'polluted')).toBe(false);
  });

  test('constructor/prototype keys in frontmatter do not pollute and do not crash', () => {
    const text = [
      '---',
      'name: gate-test',
      'description: gate test plan',
      'environment: staging',
      'constructor: { prototype: { polluted: yes } }',
      'checks:',
      '  - action: fake.read_echo',
      '    args: { environment: staging }',
      '    expect: { kind: exit_zero }',
      '    every: 30s',
      '---',
      'body',
    ].join('\n');
    // plan either parses (extra keys stripped by zod) or is rejected — both are safe.
    // What must NOT happen: global prototype pollution or an unhandled crash.
    try {
      parseWatchPlan(text, 'user');
    } catch {
      // rejection is acceptable
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('GATE: watch plans cannot escape the read tier', () => {
  test('a plan referencing an action NOT in the catalog is rejected', () => {
    const plan = parseWatchPlan(planText('does.not_exist'), 'user');
    expect(() => validateAgainstCatalog(plan, makeCatalog())).toThrow(InvalidWatchPlanError);
    expect(() => validateAgainstCatalog(plan, makeCatalog())).toThrow(/not in catalog/);
  });

  test('a plan referencing a MUTATE-tier action is rejected', () => {
    const plan = parseWatchPlan(planText('fake.mutate'), 'user');
    expect(() => validateAgainstCatalog(plan, makeCatalog())).toThrow(/read-tier/);
  });

  test('a plan referencing a DESTRUCTIVE-tier action is rejected', () => {
    const plan = parseWatchPlan(planText('fake.destroy'), 'user');
    expect(() => validateAgainstCatalog(plan, makeCatalog())).toThrow(/read-tier/);
  });

  test('a plan whose check args fail the action argsSchema is rejected', () => {
    // fake.read_echo requires `environment` as a string; pass a number instead
    const plan = parseWatchPlan(planText('fake.read_echo', '{ environment: 42 }'), 'user');
    expect(() => validateAgainstCatalog(plan, makeCatalog())).toThrow(InvalidWatchPlanError);
  });

  test('a valid read-tier plan passes validation', () => {
    const plan = parseWatchPlan(planText('fake.read_echo'), 'user');
    expect(() => validateAgainstCatalog(plan, makeCatalog())).not.toThrow();
  });
});
