import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';

import { BUILTIN_ACTIONS } from '../../../src/actions/builtin/index.ts';
import { createCatalog, type Catalog } from '../../../src/actions/catalog.ts';
import type { Action } from '../../../src/actions/types.ts';
import { createExecutor, type Executor } from '../../../src/exec/executor.ts';
import { createLogger } from '../../../src/logging/logger.ts';
import { closeDb, openDb } from '../../../src/memory/db.ts';
import { resolvePlanByName, runOneShotCheck } from '../../../src/monitor/one-shot.ts';
import type { WatchPlan } from '../../../src/monitor/types.ts';

// ── Fake actions (same pattern as check-runner.test.ts) ──────────────────────

const fakePassing: Action<Record<string, never>, string> = {
  name: 'fake.passes',
  tier: 'read',
  description: 'always exits 0',
  argsSchema: z.object({}),
  buildCommand: () => ['sh', '-c', 'exit 0'],
  parseResult: (raw, _args) => raw.stdout,
};

const fakeFailing: Action<Record<string, never>, string> = {
  name: 'fake.fails',
  tier: 'read',
  description: 'always exits 1',
  argsSchema: z.object({}),
  buildCommand: () => ['sh', '-c', 'exit 1'],
  parseResult: (raw, _args) => raw.stdout,
};

// ── Setup ─────────────────────────────────────────────────────────────────────

let db: PGlite;
let catalog: Catalog;
let executor: Executor;
let sessionId: string;

const silentLogger = createLogger({ destination: () => undefined });

beforeEach(async () => {
  db = await openDb();
  catalog = createCatalog();
  catalog.register(fakePassing);
  catalog.register(fakeFailing);
  sessionId = `one-shot-test-${crypto.randomUUID()}`;
  await db.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [
    sessionId,
    JSON.stringify({}),
  ]);
  executor = createExecutor({ db, catalog });
});

afterEach(async () => {
  await closeDb(db);
});

// ── Helper: build minimal WatchPlan without going through YAML parser ─────────

function makePlan(
  checks: WatchPlan['checks'],
): WatchPlan {
  return {
    name: 'test-plan',
    description: 'test',
    environment: 'staging',
    checks,
    runbook: '',
    source: 'user',
  };
}

// ── runOneShotCheck ───────────────────────────────────────────────────────────

describe('monitor/one-shot — runOneShotCheck', () => {
  test('all checks pass → exit code 0', async () => {
    const plan = makePlan([
      {
        name: 'pass-1',
        action: 'fake.passes',
        args: {},
        expect: { kind: 'exit_zero' },
        intervalMs: 60_000,
      },
      {
        name: 'pass-2',
        action: 'fake.passes',
        args: {},
        expect: { kind: 'exit_zero' },
        intervalMs: 60_000,
      },
    ]);

    const code = await runOneShotCheck(plan, {
      catalog,
      executor,
      sessionId,
      logger: silentLogger,
    });

    expect(code).toBe(0);
  });

  test('expectation failure → exit code 1', async () => {
    const plan = makePlan([
      {
        name: 'fail-expectation',
        action: 'fake.fails',
        args: {},
        expect: { kind: 'exit_zero' }, // will fail: exit code is 1
        intervalMs: 60_000,
      },
    ]);

    const code = await runOneShotCheck(plan, {
      catalog,
      executor,
      sessionId,
      logger: silentLogger,
    });

    expect(code).toBe(1);
  });

  test('check error (unknown action) → exit code 2', async () => {
    const plan = makePlan([
      {
        name: 'ghost',
        action: 'not.in_catalog',
        args: {},
        expect: { kind: 'exit_zero' },
        intervalMs: 60_000,
      },
    ]);

    const code = await runOneShotCheck(plan, {
      catalog,
      executor,
      sessionId,
      logger: silentLogger,
    });

    expect(code).toBe(2);
  });

  test('mixed: worst outcome wins — error beats failure beats pass', async () => {
    const plan = makePlan([
      {
        name: 'ok',
        action: 'fake.passes',
        args: {},
        expect: { kind: 'exit_zero' },
        intervalMs: 60_000,
      },
      {
        name: 'expectation-fail',
        action: 'fake.fails',
        args: {},
        expect: { kind: 'exit_zero' },
        intervalMs: 60_000,
      },
      {
        name: 'check-error',
        action: 'completely.unknown',
        args: {},
        expect: { kind: 'exit_zero' },
        intervalMs: 60_000,
      },
    ]);

    const code = await runOneShotCheck(plan, {
      catalog,
      executor,
      sessionId,
      logger: silentLogger,
    });

    expect(code).toBe(2);
  });

  test('pass + failure, no error → exit code 1', async () => {
    const plan = makePlan([
      {
        name: 'ok',
        action: 'fake.passes',
        args: {},
        expect: { kind: 'exit_zero' },
        intervalMs: 60_000,
      },
      {
        name: 'fail',
        action: 'fake.fails',
        args: {},
        expect: { kind: 'exit_zero' },
        intervalMs: 60_000,
      },
    ]);

    const code = await runOneShotCheck(plan, {
      catalog,
      executor,
      sessionId,
      logger: silentLogger,
    });

    expect(code).toBe(1);
  });
});

// ── resolvePlanByName ─────────────────────────────────────────────────────────

describe('monitor/one-shot — resolvePlanByName', () => {
  test('returns null for an unknown plan name', async () => {
    const result = await resolvePlanByName('completely-unknown-plan', {
      catalog,
      executor,
      sessionId,
      logger: silentLogger,
    });
    expect(result).toBeNull();
  });

  test('returns null for a stock plan when no environment is provided', async () => {
    // stock plans need __ENV__ replaced; without environmentName → null
    const result = await resolvePlanByName('docker-basics', {
      catalog,
      executor,
      sessionId,
      logger: silentLogger,
      // environmentName intentionally absent
    });
    expect(result).toBeNull();
  });

  test('resolves a stock plan when environment is provided and builtins are registered', async () => {
    // Register real builtins so validateAgainstCatalog can see the actions used
    // by docker-basics (docker.ps, system.disk_usage).
    const fullCatalog = createCatalog();
    for (const action of BUILTIN_ACTIONS) fullCatalog.register(action);

    const result = await resolvePlanByName('docker-basics', {
      catalog: fullCatalog,
      executor,
      sessionId,
      logger: silentLogger,
      environmentName: 'staging',
    });

    expect(result).not.toBeNull();
    expect(result?.name).toBe('docker-basics');
    expect(result?.environment).toBe('staging');
    expect(result?.source).toBe('stock');
  });

  test('returns null for a stock plan whose catalog validation fails (actions not registered)', async () => {
    // fakeCatalog only knows about fake actions, not docker.ps / system.disk_usage
    const result = await resolvePlanByName('docker-basics', {
      catalog, // only has fake.passes / fake.fails
      executor,
      sessionId,
      logger: silentLogger,
      environmentName: 'staging',
    });
    expect(result).toBeNull();
  });
});
