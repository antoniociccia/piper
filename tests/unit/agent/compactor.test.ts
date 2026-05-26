import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';

import { maybeCompactHistory, shouldCompact } from '../../../src/agent/compactor.ts';
import { createChatHistory } from '../../../src/memory/chat-history.ts';
import { closeDb, openDb } from '../../../src/memory/db.ts';
import { createCostTracker } from '../../../src/models/cost.ts';
import type {
  Completion,
  CompletionChunk,
  CompleteRequest,
  ModelClient,
} from '../../../src/models/types.ts';

let db: PGlite | null = null;
let sessionId: string;

beforeEach(async () => {
  db = await openDb();
  sessionId = `cmp-${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`,
    [sessionId, JSON.stringify({})],
  );
});

afterEach(async () => {
  if (db !== null) {
    await closeDb(db);
    db = null;
  }
});

function fakeClient(content: string): ModelClient {
  return {
    id: 'fake',
    isLocal: true,
    capabilities: { toolCalling: false, maxContextTokens: 100000, streaming: false },
    estimateCost: () => ({ free: true }),
    complete: async (_req: CompleteRequest): Promise<Completion> => ({
      id: 'c',
      model: 'm',
      content,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 100 },
      costUsd: 0,
    }),
    // eslint-disable-next-line require-yield
    stream: async function* (): AsyncIterable<CompletionChunk> {
      return;
    },
  };
}

describe('agent/compactor', () => {
  test('returns {compacted:false} when not enough older messages', async () => {
    if (db === null) throw new Error('db missing');
    const history = createChatHistory(db);
    const tracker = createCostTracker({ db });
    await history.appendUser(sessionId, 'just one');
    const result = await maybeCompactHistory({
      sessionId,
      chatHistory: history,
      client: fakeClient('UNREACHED'),
      costTracker: tracker,
      keepRecent: 4,
      minToCompact: 4,
    });
    expect(result.compacted).toBe(false);
  });

  test('summarises older turns into a single summary message', async () => {
    if (db === null) throw new Error('db missing');
    const history = createChatHistory(db);
    const tracker = createCostTracker({ db });
    for (let i = 1; i <= 12; i += 1) {
      if (i % 2 === 1) await history.appendUser(sessionId, `prompt ${i}`);
      else await history.appendAssistant(sessionId, `report ${i}`);
    }
    const result = await maybeCompactHistory({
      sessionId,
      chatHistory: history,
      client: fakeClient('Session-wide summary text here.'),
      costTracker: tracker,
      keepRecent: 4,
      minToCompact: 4,
    });
    expect(result.compacted).toBe(true);
    expect(typeof result.coversUntilId).toBe('number');

    const planner = await history.forPlanner(sessionId, 6);
    expect(planner[0]?.kind).toBe('summary');
    expect(planner[0]?.content).toContain('Session-wide summary text here.');
    // Remaining: the 4 most recent original messages
    expect(planner.length).toBe(5);
  });

  test('a second call produces nothing when no new pending messages exist', async () => {
    if (db === null) throw new Error('db missing');
    const history = createChatHistory(db);
    const tracker = createCostTracker({ db });
    for (let i = 1; i <= 10; i += 1) {
      await history.appendUser(sessionId, `m${i}`);
    }
    const first = await maybeCompactHistory({
      sessionId,
      chatHistory: history,
      client: fakeClient('first summary'),
      costTracker: tracker,
      keepRecent: 4,
      minToCompact: 4,
    });
    expect(first.compacted).toBe(true);

    const second = await maybeCompactHistory({
      sessionId,
      chatHistory: history,
      client: fakeClient('UNREACHED'),
      costTracker: tracker,
      keepRecent: 4,
      minToCompact: 4,
    });
    expect(second.compacted).toBe(false);
  });
});

describe('agent/compactor — shouldCompact', () => {
  test('does not trigger below threshold', () => {
    const r = shouldCompact({
      tokensUsed: 50_000,
      modelLimit: 200_000,
      reservedForOutput: 4_000,
      triggerPct: 0.7,
    });
    expect(r.triggered).toBe(false);
  });

  test('triggers above threshold (token-based)', () => {
    const r = shouldCompact({
      tokensUsed: 180_000,
      modelLimit: 200_000,
      reservedForOutput: 4_000,
      triggerPct: 0.7,
    });
    expect(r.triggered).toBe(true);
    if (r.triggered) expect(r.reason).toContain('tokens');
  });

  test('triggers on pending-message fallback when token usage is moderate', () => {
    const r = shouldCompact({
      tokensUsed: 5_000,
      modelLimit: 200_000,
      pendingMessageCount: 15,
      pendingMessageThreshold: 12,
    });
    expect(r.triggered).toBe(true);
    if (r.triggered) expect(r.reason).toContain('pending messages');
  });

  test('respects reservedForOutput when computing the threshold', () => {
    // 100k limit, 50k reserved → effective 50k, trigger at 70% = 35k
    const high = shouldCompact({
      tokensUsed: 40_000,
      modelLimit: 100_000,
      reservedForOutput: 50_000,
      triggerPct: 0.7,
    });
    const low = shouldCompact({
      tokensUsed: 40_000,
      modelLimit: 100_000,
      reservedForOutput: 1_000,
      triggerPct: 0.7,
    });
    expect(high.triggered).toBe(true);
    expect(low.triggered).toBe(false);
  });
});
