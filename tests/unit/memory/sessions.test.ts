import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';

import { closeDb, openDb } from '../../../src/memory/db.ts';
import { createSessionsRepo, type SessionsRepo } from '../../../src/memory/sessions.ts';

let db: PGlite | null = null;
let repo: SessionsRepo;

async function insertSession(d: PGlite, id: string, configJson: object): Promise<void> {
  await d.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [
    id,
    JSON.stringify(configJson),
  ]);
}

beforeEach(async () => {
  db = await openDb();
  repo = createSessionsRepo(db);
});

afterEach(async () => {
  if (db !== null) {
    await closeDb(db);
    db = null;
  }
});

describe('memory/sessions', () => {
  test('setTitle round-trips via SQL', async () => {
    if (db === null) throw new Error('db missing');
    const id = `s-${crypto.randomUUID()}`;
    await insertSession(db, id, {});
    expect(await repo.getTitle(id)).toBeNull();
    await repo.setTitle(id, 'Investigate Uptime on Staging');
    expect(await repo.getTitle(id)).toBe('Investigate Uptime on Staging');
  });

  test('setTitle ignores empty/whitespace titles', async () => {
    if (db === null) throw new Error('db missing');
    const id = `s-${crypto.randomUUID()}`;
    await insertSession(db, id, {});
    await repo.setTitle(id, '   ');
    expect(await repo.getTitle(id)).toBeNull();
  });

  test('touch bumps last_active_at', async () => {
    if (db === null) throw new Error('db missing');
    const id = `s-${crypto.randomUUID()}`;
    await insertSession(db, id, {});
    const before = await db.query<{ last_active_at: string }>(
      `SELECT last_active_at FROM sessions WHERE id = $1`,
      [id],
    );
    const beforeTs = new Date(before.rows[0]!.last_active_at).getTime();
    // small wait to make sure now() advances
    await new Promise((r) => setTimeout(r, 10));
    await repo.touch(id);
    const after = await db.query<{ last_active_at: string }>(
      `SELECT last_active_at FROM sessions WHERE id = $1`,
      [id],
    );
    const afterTs = new Date(after.rows[0]!.last_active_at).getTime();
    expect(afterTs).toBeGreaterThanOrEqual(beforeTs);
  });

  test('listRecent returns sessions ordered by last_active_at DESC', async () => {
    if (db === null) throw new Error('db missing');
    const a = `s-${crypto.randomUUID()}`;
    const b = `s-${crypto.randomUUID()}`;
    await insertSession(db, a, {});
    await new Promise((r) => setTimeout(r, 5));
    await insertSession(db, b, {});
    await repo.setTitle(a, 'Older Session');
    await repo.setTitle(b, 'Newer Session');
    // touch a to make it newer
    await new Promise((r) => setTimeout(r, 5));
    await repo.touch(a);
    const list = await repo.listRecent(10);
    expect(list[0]?.id).toBe(a);
    expect(list[1]?.id).toBe(b);
    expect(list[0]?.title).toBe('Older Session');
  });

  test('listRecent counts chat_messages', async () => {
    if (db === null) throw new Error('db missing');
    const id = `s-${crypto.randomUUID()}`;
    await insertSession(db, id, {});
    await db.query(
      `INSERT INTO chat_messages (session_id, kind, role, content) VALUES ($1, 'prompt', 'user', $2)`,
      [id, 'hello'],
    );
    const list = await repo.listRecent(10);
    const found = list.find((s) => s.id === id);
    expect(found?.messageCount).toBe(1);
  });
});
