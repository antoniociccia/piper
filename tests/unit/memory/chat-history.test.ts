import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';

import { createChatHistory, type ChatHistory } from '../../../src/memory/chat-history.ts';
import { closeDb, openDb } from '../../../src/memory/db.ts';

let db: PGlite | null = null;
let history: ChatHistory;
let sessionId: string;

beforeEach(async () => {
  db = await openDb();
  history = createChatHistory(db);
  sessionId = `cht-${crypto.randomUUID()}`;
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

describe('memory/chat-history', () => {
  test('returns empty list when no messages yet', async () => {
    expect(await history.recent(sessionId)).toEqual([]);
    expect(await history.count(sessionId)).toBe(0);
  });

  test('appendUser stores role=user, kind=prompt', async () => {
    const msg = await history.appendUser(sessionId, 'check uptime');
    expect(msg.role).toBe('user');
    expect(msg.kind).toBe('prompt');
    expect(msg.content).toBe('check uptime');
  });

  test('appendAssistant stores role=assistant, kind=report', async () => {
    const msg = await history.appendAssistant(sessionId, '# Report\nUptime is fine.');
    expect(msg.role).toBe('assistant');
    expect(msg.kind).toBe('report');
    expect(msg.content).toContain('Uptime is fine');
  });

  test('recent returns messages in chronological order (oldest first)', async () => {
    await history.appendUser(sessionId, 'one');
    await history.appendAssistant(sessionId, 'two');
    await history.appendUser(sessionId, 'three');
    const recent = await history.recent(sessionId);
    expect(recent.map((m) => m.content)).toEqual(['one', 'two', 'three']);
  });

  test('recent respects limit, keeping the most recent N', async () => {
    for (let i = 1; i <= 10; i += 1) {
      await history.appendUser(sessionId, `m${i}`);
    }
    const recent = await history.recent(sessionId, 3);
    expect(recent.map((m) => m.content)).toEqual(['m8', 'm9', 'm10']);
  });

  test('default limit is 6', async () => {
    for (let i = 1; i <= 10; i += 1) {
      await history.appendUser(sessionId, `m${i}`);
    }
    const recent = await history.recent(sessionId);
    expect(recent).toHaveLength(6);
  });

  test('messages are scoped per session', async () => {
    const otherSession = `other-${crypto.randomUUID()}`;
    await db!.query(
      `INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`,
      [otherSession, JSON.stringify({})],
    );
    await history.appendUser(sessionId, 'mine');
    await history.appendUser(otherSession, 'theirs');
    const mine = await history.recent(sessionId);
    const theirs = await history.recent(otherSession);
    expect(mine.map((m) => m.content)).toEqual(['mine']);
    expect(theirs.map((m) => m.content)).toEqual(['theirs']);
  });

  test('count returns the total number of messages for a session', async () => {
    await history.appendUser(sessionId, 'a');
    await history.appendAssistant(sessionId, 'b');
    await history.appendUser(sessionId, 'c');
    expect(await history.count(sessionId)).toBe(3);
  });
});

describe('memory/chat-history — compaction view', () => {
  test('pendingForCompaction returns older regular messages, oldest-first', async () => {
    for (let i = 1; i <= 10; i += 1) {
      if (i % 2 === 1) await history.appendUser(sessionId, `u${i}`);
      else await history.appendAssistant(sessionId, `a${i}`);
    }
    // keep 4 most recent → 6 should be pending
    const pending = await history.pendingForCompaction(sessionId, 4);
    expect(pending).toHaveLength(6);
    expect(pending[0]?.content).toBe('u1');
    expect(pending[5]?.content).toBe('a6');
  });

  test('pendingForCompaction returns [] when there is nothing old enough', async () => {
    await history.appendUser(sessionId, 'a');
    await history.appendUser(sessionId, 'b');
    expect(await history.pendingForCompaction(sessionId, 6)).toEqual([]);
  });

  test('forPlanner without any summary mirrors recent()', async () => {
    for (let i = 1; i <= 4; i += 1) await history.appendUser(sessionId, `m${i}`);
    const planner = await history.forPlanner(sessionId, 6);
    expect(planner.map((m) => m.content)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  test('forPlanner with a summary returns [summary, ...messages after it]', async () => {
    const m1 = await history.appendUser(sessionId, 'm1');
    await history.appendAssistant(sessionId, 'r1');
    const m3 = await history.appendUser(sessionId, 'm3');
    await history.appendAssistant(sessionId, 'r3');
    await history.appendSummary(sessionId, 'summary covers m1..r3', m3.id + 1);
    // post-summary turns
    await history.appendUser(sessionId, 'm5');
    await history.appendAssistant(sessionId, 'r5');

    const planner = await history.forPlanner(sessionId, 6);
    expect(planner).toHaveLength(3);
    expect(planner[0]?.kind).toBe('summary');
    expect(planner[0]?.content).toContain('summary covers');
    expect(planner[1]?.content).toBe('m5');
    expect(planner[2]?.content).toBe('r5');
    // m1, r1, m3, r3 are NOT in the planner view (already covered)
    void m1;
  });

  test('appendSessionReport persists a session-report kind', async () => {
    const msg = await history.appendSessionReport(sessionId, '# Session report\nbody');
    expect(msg.kind).toBe('session-report');
  });
});
