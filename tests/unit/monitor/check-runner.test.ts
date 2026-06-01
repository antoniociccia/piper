import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';

import { createCatalog, type Catalog } from '../../../src/actions/catalog.ts';
import type { Action } from '../../../src/actions/types.ts';
import { createExecutor, type Executor } from '../../../src/exec/executor.ts';
import { closeDb, openDb } from '../../../src/memory/db.ts';
import { runCheck } from '../../../src/monitor/check-runner.ts';
import type { WatchCheck } from '../../../src/monitor/types.ts';

let db: PGlite;
let catalog: Catalog;
let executor: Executor;
let sessionId: string;

// parseResult takes (raw: RawExecOutput, args: Args) — both params required
const echoJson: Action<{ payload: string }, readonly { name: string; state: string }[]> = {
  name: 'fake.echo_json',
  tier: 'read',
  description: 'echoes a JSON payload and parses it as a container list',
  argsSchema: z.object({ payload: z.string() }),
  buildCommand: (args) => ['echo', args.payload],
  parseResult: (raw, _args) => {
    try {
      return JSON.parse(raw.stdout) as readonly { name: string; state: string }[];
    } catch {
      return [];
    }
  },
};

// Uses 'sh -c exit 1' to reliably exit non-zero (same pattern as executor test fixtures)
const failing: Action<Record<string, never>, string> = {
  name: 'fake.fails',
  tier: 'read',
  description: 'a command that exits non-zero',
  argsSchema: z.object({}),
  buildCommand: () => ['sh', '-c', 'exit 1'],
  parseResult: (raw, _args) => raw.stdout,
};

beforeEach(async () => {
  db = await openDb();
  catalog = createCatalog();
  catalog.register(echoJson);
  catalog.register(failing);
  sessionId = `test-${crypto.randomUUID()}`;
  await db.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [
    sessionId,
    JSON.stringify({}),
  ]);
  executor = createExecutor({ db, catalog });
});

afterEach(async () => {
  await closeDb(db);
});

const NOW = 1_700_000_000_000;

describe('monitor/check-runner', () => {
  test('pass: command runs, parseResult feeds the expectation', async () => {
    const check: WatchCheck = {
      name: 'containers',
      action: 'fake.echo_json',
      args: { payload: JSON.stringify([{ name: 'web', state: 'running' }]) },
      expect: { kind: 'all_running' },
      intervalMs: 30_000,
    };
    const outcome = await runCheck(check, { executor, catalog, sessionId, now: () => NOW });
    expect(outcome.kind).toBe('pass');
    expect(outcome.checkName).toBe('containers');
    expect(outcome.executedAtMs).toBe(NOW);
    expect(outcome.exitCode).toBe(0);
  });

  test('expectation-failed: command runs but expectation does not hold', async () => {
    const check: WatchCheck = {
      name: 'containers',
      action: 'fake.echo_json',
      args: { payload: JSON.stringify([{ name: 'db', state: 'exited' }]) },
      expect: { kind: 'all_running' },
      intervalMs: 30_000,
    };
    const outcome = await runCheck(check, { executor, catalog, sessionId, now: () => NOW });
    expect(outcome.kind).toBe('expectation-failed');
    expect(outcome.detail).toContain('db');
  });

  test('check-error: ExecError (e.g. unknown action) becomes an outcome, not an exception', async () => {
    const check: WatchCheck = {
      name: 'ghost',
      action: 'not.in_catalog',
      args: {},
      expect: { kind: 'exit_zero' },
      intervalMs: 30_000,
    };
    const outcome = await runCheck(check, { executor, catalog, sessionId, now: () => NOW });
    expect(outcome.kind).toBe('check-error');
    // ExecError message is 'not in catalog'; reason is 'unknown-action'
    // runCheck formats it as "${reason}: ${message}" = "unknown-action: not in catalog"
    expect(outcome.detail).toContain('not in catalog');
    expect(outcome.exitCode).toBeNull();
  });

  test('non-zero exit with exit_zero expectation is expectation-failed (command DID run)', async () => {
    const check: WatchCheck = {
      name: 'fails',
      action: 'fake.fails',
      args: {},
      expect: { kind: 'exit_zero' },
      intervalMs: 30_000,
    };
    const outcome = await runCheck(check, { executor, catalog, sessionId, now: () => NOW });
    expect(outcome.kind).toBe('expectation-failed');
    expect(outcome.exitCode).toBe(1);
  });

  test('a throwing parseResult degrades to no-parsed-data, not a check error', async () => {
    const throwingParser: Action<Record<string, never>, string> = {
      name: 'fake.throwing_parser',
      tier: 'read',
      description: 'parseResult always throws',
      argsSchema: z.object({}),
      buildCommand: (_args, _ctx) => ['echo', 'hello'],
      parseResult: (_raw, _args) => {
        throw new Error('parser exploded');
      },
    };
    catalog.register(throwingParser);
    // executor also needs it registered (it uses its own catalog ref from deps)
    executor = createExecutor({ db, catalog });

    const check: WatchCheck = {
      name: 'parser-throws',
      action: 'fake.throwing_parser',
      args: {},
      expect: { kind: 'all_running' },
      intervalMs: 30_000,
    };
    const outcome = await runCheck(check, { executor, catalog, sessionId, now: () => NOW });
    // all_running with no parsed data → expectation-failed (fail-closed), NOT check-error
    expect(outcome.kind).toBe('expectation-failed');
    expect(outcome.detail).toContain('no parsed item list');
  });

  test('a catalog whose resolve throws yields check-error, never an exception', async () => {
    // The executor uses its own catalog reference (passed at construction time) for
    // the initial gate checks and command building — so we give it the real catalog
    // to let exec succeed. runCheck's deps.catalog is a separate reference used only
    // for the post-exec parseResult call; we inject the bomb there.
    const bombCatalog: Catalog = {
      register: catalog.register.bind(catalog),
      list: catalog.list.bind(catalog),
      size: catalog.size.bind(catalog),
      resolve: (_name: string) => {
        throw new Error('catalog exploded');
      },
    };

    const check: WatchCheck = {
      name: 'bomb',
      action: 'fake.echo_json',
      args: { payload: '[]' },
      expect: { kind: 'exit_zero' },
      intervalMs: 30_000,
    };
    // executor uses the real catalog; runCheck gets the bomb catalog only for its
    // post-exec catalog.resolve call
    const outcome = await runCheck(check, {
      executor,
      catalog: bombCatalog,
      sessionId,
      now: () => NOW,
    });
    expect(outcome.kind).toBe('check-error');
    expect(outcome.detail).toContain('catalog exploded');
    expect(outcome.exitCode).toBe(0); // the command DID run — exit code preserved
  });

  test('every check execution lands in the audit log', async () => {
    const check: WatchCheck = {
      name: 'containers',
      action: 'fake.echo_json',
      args: { payload: '[]' },
      expect: { kind: 'all_running' },
      intervalMs: 30_000,
    };
    await runCheck(check, { executor, catalog, sessionId, now: () => NOW });
    const audit = await db.query<{ action_name: string }>(
      `SELECT action_name FROM audit_log WHERE session_id = $1 AND kind = 'exec'`,
      [sessionId],
    );
    expect(audit.rows.map((r) => r.action_name)).toContain('fake.echo_json');
  });
});
