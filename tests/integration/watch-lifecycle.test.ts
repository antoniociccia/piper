import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';

import { createCatalog, type Catalog } from '../../src/actions/catalog.ts';
import type { Action } from '../../src/actions/types.ts';
import { createExecutor, type Executor } from '../../src/exec/executor.ts';
import { closeDb, openDb } from '../../src/memory/db.ts';
import { createAnomalyPolicy } from '../../src/monitor/anomaly-policy.ts';
import { runCheck } from '../../src/monitor/check-runner.ts';
import { parseWatchPlan, validateAgainstCatalog } from '../../src/monitor/plan-loader.ts';
import { runWatch } from '../../src/monitor/scheduler.ts';
import type { WatchEvent } from '../../src/monitor/types.ts';
import { createWatchStore } from '../../src/monitor/watch-store.ts';

let db: PGlite;
let catalog: Catalog;
let executor: Executor;
let sessionId: string;

// Toggleable fake: starts healthy, can be flipped to broken mid-run.
let healthy = true;

// parseResult takes (raw: RawExecOutput, args: Args) — same as check-runner test pattern.
const healthCheck: Action<Record<string, never>, string> = {
  name: 'fake.health',
  tier: 'read',
  description: 'health probe (echo healthy/broken)',
  argsSchema: z.object({}),
  buildCommand: () => ['echo', healthy ? 'healthy' : 'ERROR connection refused'],
  parseResult: (raw, _args) => raw.stdout,
};

const PLAN_TEXT = [
  '---',
  'name: lifecycle-test',
  'description: integration lifecycle',
  'environment: staging',
  'checks:',
  '  - action: fake.health',
  '    args: {}',
  '    expect: { kind: regex_absent, pattern: ERROR }',
  '    every: 30s',
  '---',
  '',
  'Runbook: check the db first.',
].join('\n');

beforeEach(async () => {
  db = await openDb();
  healthy = true;
  catalog = createCatalog();
  catalog.register(healthCheck);
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

describe('integration: full watch lifecycle', () => {
  test('start → healthy ticks → break → debounce → anomaly → diagnosis → stop, all persisted', async () => {
    let nowMs = 1_700_000_000_000;
    const abort = new AbortController();
    const store = createWatchStore(db);

    const plan = parseWatchPlan(PLAN_TEXT, 'user');
    validateAgainstCatalog(plan, catalog);

    let ticks = 0;
    const events: WatchEvent[] = [];

    const gen = runWatch(plan, {
      runCheck: (check) => runCheck(check, { executor, catalog, sessionId, now: () => nowMs }),
      policy: createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, () => nowMs),
      store,
      sessionId,
      now: () => nowMs,
      sleep: (ms) => {
        nowMs += ms;
        ticks += 1;
        if (ticks === 2) healthy = false; // break the system after 2 healthy ticks
        if (ticks >= 8) abort.abort();    // safety stop
        return Promise.resolve();
      },
      signal: abort.signal,
      diagnose: () => Promise.resolve({ kind: 'ready', reportMarkdown: '# Diagnosis\nConnection refused — db down.' }),
    });

    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === 'diagnosis-ready') abort.abort();
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('watch-started');
    expect(types).toContain('anomaly');
    expect(types).toContain('diagnosis-ready');
    expect(types[types.length - 1]).toBe('watch-stopped');

    // Everything persisted: run, check results, anomaly with diagnosis.
    const runs = await db.query<{ id: number }>('SELECT id FROM watch_runs WHERE session_id = $1', [sessionId]);
    expect(runs.rows).toHaveLength(1);
    const runId = runs.rows[0]?.id;

    const results = await db.query<{ outcome: string }>(
      'SELECT outcome FROM watch_check_results WHERE watch_run_id = $1 ORDER BY id',
      [runId],
    );
    expect(results.rows.length).toBeGreaterThanOrEqual(4); // 2 healthy + 2 failed minimum
    expect(results.rows[0]?.outcome).toBe('pass');

    const anomalies = await db.query<{ diagnosis_status: string; diagnosis_report: string | null }>(
      'SELECT diagnosis_status, diagnosis_report FROM watch_anomalies WHERE watch_run_id = $1',
      [runId],
    );
    expect(anomalies.rows).toHaveLength(1);
    expect(anomalies.rows[0]?.diagnosis_status).toBe('ready');
    expect(anomalies.rows[0]?.diagnosis_report).toContain('db down');

    // Audit log saw every check execution (the executor did them all).
    const audit = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM audit_log WHERE session_id = $1 AND action_name = 'fake.health'`,
      [sessionId],
    );
    expect(Number(audit.rows[0]?.count)).toBeGreaterThanOrEqual(4);
  });
});
