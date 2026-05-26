import type { PGlite } from '@electric-sql/pglite';

import type { SessionId } from './types.ts';

export interface SessionSummary {
  readonly id: SessionId;
  readonly title: string | null;
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
  readonly messageCount: number;
}

export interface SessionsRepo {
  setTitle(sessionId: SessionId, title: string): Promise<void>;
  touch(sessionId: SessionId): Promise<void>;
  listRecent(limit?: number): Promise<readonly SessionSummary[]>;
  getTitle(sessionId: SessionId): Promise<string | null>;
}

export function createSessionsRepo(db: PGlite): SessionsRepo {
  return {
    async setTitle(sessionId, title) {
      const trimmed = title.trim();
      if (trimmed === '') return;
      await db.query(
        `UPDATE sessions SET title = $1, last_active_at = now() WHERE id = $2`,
        [trimmed, sessionId],
      );
    },
    async touch(sessionId) {
      await db.query(`UPDATE sessions SET last_active_at = now() WHERE id = $1`, [sessionId]);
    },
    async getTitle(sessionId) {
      const r = await db.query<{ title: string | null }>(
        `SELECT title FROM sessions WHERE id = $1`,
        [sessionId],
      );
      return r.rows[0]?.title ?? null;
    },
    async listRecent(limit = 10) {
      const r = await db.query<{
        id: string;
        title: string | null;
        started_at: string;
        last_active_at: string;
        message_count: string | number;
      }>(
        `SELECT s.id, s.title, s.started_at, s.last_active_at,
                (SELECT count(*) FROM chat_messages cm WHERE cm.session_id = s.id) AS message_count
         FROM sessions s
         ORDER BY s.last_active_at DESC
         LIMIT $1`,
        [limit],
      );
      return r.rows.map((row) => ({
        id: row.id as SessionId,
        title: row.title,
        startedAt: new Date(row.started_at),
        lastActiveAt: new Date(row.last_active_at),
        messageCount: typeof row.message_count === 'string' ? Number(row.message_count) : row.message_count,
      }));
    },
  };
}
