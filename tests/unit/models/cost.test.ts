import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';

import {
  BudgetExceededError,
  createCostTracker,
  hashPayload,
  type CostTracker,
} from '../../../src/models/cost.ts';
import type { CostEstimate } from '../../../src/models/types.ts';
import { closeDb, openDb } from '../../../src/memory/db.ts';

let db: PGlite | null = null;

async function makeSession(): Promise<string> {
  if (db === null) throw new Error('db not open');
  const id = `cost-${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`,
    [id, JSON.stringify({})],
  );
  return id;
}

beforeEach(async () => {
  db = await openDb();
});

afterEach(async () => {
  if (db !== null) {
    await closeDb(db);
    db = null;
  }
});

describe('models/cost — record + sessionTotal', () => {
  test('record writes llm_calls row, updates sessions.cost_usd_total', async () => {
    if (db === null) throw new Error('db unavailable');
    const sessionId = await makeSession();
    const tracker: CostTracker = createCostTracker({ db });

    const { costUsd, newSessionTotal } = await tracker.record({
      sessionId,
      model: '~anthropic/claude-sonnet-latest',
      role: 'planner',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      payloadHash: 'h1',
    });
    // 1M * 3$/M + 100K * 15$/M = 3 + 1.5 = 4.5
    expect(costUsd).toBeCloseTo(4.5, 4);
    expect(newSessionTotal).toBeCloseTo(4.5, 4);

    const session = await db.query<{ cost_usd_total: string }>(
      `SELECT cost_usd_total::text FROM sessions WHERE id = $1`,
      [sessionId],
    );
    expect(Number(session.rows[0]?.cost_usd_total ?? '0')).toBeCloseTo(4.5, 4);

    const calls = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM llm_calls WHERE session_id = $1`,
      [sessionId],
    );
    expect(Number(calls.rows[0]?.count ?? '0')).toBe(1);
  });

  test('multiple records sum correctly in sessionTotal', async () => {
    if (db === null) throw new Error('db unavailable');
    const sessionId = await makeSession();
    const tracker = createCostTracker({ db });
    await tracker.record({ sessionId, model: '~anthropic/claude-sonnet-latest', role: 'planner', inputTokens: 500_000, outputTokens: 50_000, payloadHash: 'h1' });
    await tracker.record({ sessionId, model: '~anthropic/claude-sonnet-latest', role: 'synthesize', inputTokens: 500_000, outputTokens: 50_000, payloadHash: 'h2' });
    const total = await tracker.sessionTotal(sessionId);
    // each record: 500K * 3$/M + 50K * 15$/M = 1.5 + 0.75 = 2.25 → total 4.5
    expect(total).toBeCloseTo(4.5, 3);
  });

  test('local-tier models record zero cost', async () => {
    if (db === null) throw new Error('db unavailable');
    const sessionId = await makeSession();
    const tracker = createCostTracker({ db });
    const { costUsd } = await tracker.record({
      sessionId,
      model: 'mistralai/devstral-small-2-24b',
      role: 'planner',
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      payloadHash: 'h-local',
    });
    expect(costUsd).toBe(0);
    expect(await tracker.sessionTotal(sessionId)).toBe(0);
  });
});

describe('models/cost — visibility threshold', () => {
  test('shouldDisplay is false for free estimates', () => {
    const tracker = createCostTracker({ db: db as PGlite });
    expect(tracker.shouldDisplay({ free: true })).toBe(false);
  });

  test('shouldDisplay is true when estimate >= threshold', () => {
    const tracker = createCostTracker({ db: db as PGlite, visibilityThresholdUsd: 0.05 });
    const est: CostEstimate = { free: false, minUsd: 0.01, maxUsd: 0.10 };
    expect(tracker.shouldDisplay(est)).toBe(true);
  });

  test('shouldDisplay is false when estimate < threshold', () => {
    const tracker = createCostTracker({ db: db as PGlite, visibilityThresholdUsd: 0.05 });
    const est: CostEstimate = { free: false, minUsd: 0.001, maxUsd: 0.01 };
    expect(tracker.shouldDisplay(est)).toBe(false);
  });
});

describe('models/cost — guard / budget', () => {
  test('guard does nothing when no budget is configured', async () => {
    if (db === null) throw new Error('db unavailable');
    const sessionId = await makeSession();
    const tracker = createCostTracker({ db });
    await expect(
      tracker.guard(sessionId, { free: false, minUsd: 100, maxUsd: 200 }),
    ).resolves.toBeUndefined();
  });

  test('guard does nothing for free (local) estimates', async () => {
    if (db === null) throw new Error('db unavailable');
    const sessionId = await makeSession();
    const tracker = createCostTracker({ db, maxSessionCostUsd: 0.01 });
    await expect(tracker.guard(sessionId, { free: true })).resolves.toBeUndefined();
  });

  test('guard throws BudgetExceededError when projection exceeds limit', async () => {
    if (db === null) throw new Error('db unavailable');
    const sessionId = await makeSession();
    const tracker = createCostTracker({ db, maxSessionCostUsd: 1.0 });
    await tracker.record({
      sessionId,
      model: '~anthropic/claude-sonnet-latest',
      role: 'planner',
      inputTokens: 200_000,
      outputTokens: 20_000,
      payloadHash: 'h1',
    });
    let caught: unknown;
    try {
      await tracker.guard(sessionId, { free: false, minUsd: 0.1, maxUsd: 0.5 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
  });

  test('guard allows projection under limit', async () => {
    if (db === null) throw new Error('db unavailable');
    const sessionId = await makeSession();
    const tracker = createCostTracker({ db, maxSessionCostUsd: 10.0 });
    await expect(
      tracker.guard(sessionId, { free: false, minUsd: 0.01, maxUsd: 0.05 }),
    ).resolves.toBeUndefined();
  });
});

describe('models/cost — hashPayload', () => {
  test('produces a hex sha256 of length 64', async () => {
    const h = await hashPayload({ a: 1, b: 'two' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test('different payloads produce different hashes', async () => {
    const a = await hashPayload({ a: 1 });
    const b = await hashPayload({ a: 2 });
    expect(a).not.toBe(b);
  });
});
