import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';

import { closeDb, openDb } from '../../../src/memory/db.ts';
import { appliedVersions } from '../../../src/memory/migrations.ts';
import { createWatchStore, type WatchStore } from '../../../src/monitor/watch-store.ts';

let db: PGlite;
let store: WatchStore;
let sessionId: string;

beforeEach(async () => {
  db = await openDb();
  sessionId = `test-${crypto.randomUUID()}`;
  await db.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [
    sessionId,
    JSON.stringify({}),
  ]);
  store = createWatchStore(db);
});

afterEach(async () => {
  await closeDb(db);
});

describe('memory/migrations — v3 applied', () => {
  test('migration 3 (watch tables) is applied by openDb', async () => {
    const versions = await appliedVersions(db);
    expect(versions).toContain(3);
  });
});

describe('monitor/watch-store', () => {
  test('createRun → finishRun lifecycle', async () => {
    const runId = await store.createRun(sessionId, 'staging-health', 'staging');
    expect(runId).toBeGreaterThan(0);

    await store.finishRun(runId, 'user-stopped');
    const row = await db.query<{ stopped_reason: string | null }>(
      'SELECT stopped_reason FROM watch_runs WHERE id = $1',
      [runId],
    );
    expect(row.rows[0]?.stopped_reason).toBe('user-stopped');
  });

  test('recordCheckResult persists outcome and scrubs detail', async () => {
    const runId = await store.createRun(sessionId, 'staging-health', 'staging');
    await store.recordCheckResult(runId, {
      checkName: 'docker.ps',
      kind: 'expectation-failed',
      // kv-secret pattern: "password=<value>" is matched by the scrubber
      detail: 'password=hunter2 leaked into output',
      exitCode: 0,
      executedAtMs: 1_700_000_000_000,
    });
    const row = await db.query<{ outcome: string; detail_scrubbed: string }>(
      'SELECT outcome, detail_scrubbed FROM watch_check_results WHERE watch_run_id = $1',
      [runId],
    );
    expect(row.rows[0]?.outcome).toBe('expectation-failed');
    expect(row.rows[0]?.detail_scrubbed).not.toContain('hunter2');
    // scrub.ts renders redactions as [REDACTED:<kind>] — kv-secret here
    expect(row.rows[0]?.detail_scrubbed).toContain('[REDACTED:kv-secret]');
  });

  test('recordAnomaly + updateAnomalyDiagnosis', async () => {
    const runId = await store.createRun(sessionId, 'staging-health', 'staging');
    const anomalyId = await store.recordAnomaly(runId, 'docker.ps', 'expectation-failed');
    expect(anomalyId).toBeGreaterThan(0);

    await store.updateAnomalyDiagnosis(anomalyId, { status: 'ready', reportMarkdown: '# Diagnosis\nThe db is down.' });
    const row = await db.query<{ diagnosis_status: string; diagnosis_report: string | null }>(
      'SELECT diagnosis_status, diagnosis_report FROM watch_anomalies WHERE id = $1',
      [anomalyId],
    );
    expect(row.rows[0]?.diagnosis_status).toBe('ready');
    expect(row.rows[0]?.diagnosis_report).toContain('db is down');
  });

  test('updateAnomalyDiagnosis with skip reason', async () => {
    const runId = await store.createRun(sessionId, 'p', 'staging');
    const anomalyId = await store.recordAnomaly(runId, 'c', 'check-error');
    await store.updateAnomalyDiagnosis(anomalyId, { status: 'skipped-budget' });
    const row = await db.query<{ diagnosis_status: string }>(
      'SELECT diagnosis_status FROM watch_anomalies WHERE id = $1',
      [anomalyId],
    );
    expect(row.rows[0]?.diagnosis_status).toBe('skipped-budget');
  });

  test('updateAnomalyDiagnosis scrubs secrets from the report', async () => {
    const runId = await store.createRun(sessionId, 'staging-health', 'staging');
    const anomalyId = await store.recordAnomaly(runId, 'docker.ps', 'expectation-failed');
    await store.updateAnomalyDiagnosis(anomalyId, {
      status: 'ready',
      reportMarkdown: '# Diagnosis\nFound password=hunter2 in the container env.',
    });
    const row = await db.query<{ diagnosis_report: string | null }>(
      'SELECT diagnosis_report FROM watch_anomalies WHERE id = $1',
      [anomalyId],
    );
    expect(row.rows[0]?.diagnosis_report).not.toContain('hunter2');
    expect(row.rows[0]?.diagnosis_report).toContain('[REDACTED:kv-secret]');
  });

  test('createRun scrubs secrets from environment column', async () => {
    const runId = await store.createRun(sessionId, 'staging-health', 'staging password=hunter2');
    const row = await db.query<{ environment: string }>(
      'SELECT environment FROM watch_runs WHERE id = $1',
      [runId],
    );
    expect(row.rows[0]?.environment).not.toContain('hunter2');
    expect(row.rows[0]?.environment).toContain('[REDACTED:kv-secret]');
  });
});
