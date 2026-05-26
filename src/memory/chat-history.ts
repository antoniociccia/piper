import type { PGlite } from '@electric-sql/pglite';

import type { ChatKind, ChatMessageRow, ChatRole, SessionId } from './types.ts';

const DEFAULT_RECENT_LIMIT = 6;

export interface ChatMessage {
  readonly id: number;
  readonly role: ChatRole;
  readonly kind: ChatKind;
  readonly content: string;
  readonly ts: string;
  readonly coversUntil?: number;
}

export interface ChatHistory {
  appendUser(sessionId: SessionId, content: string): Promise<ChatMessage>;
  appendAssistant(sessionId: SessionId, content: string): Promise<ChatMessage>;
  appendSummary(sessionId: SessionId, content: string, coversUntilId: number): Promise<ChatMessage>;
  appendSessionReport(sessionId: SessionId, content: string): Promise<ChatMessage>;
  recent(sessionId: SessionId, limit?: number): Promise<readonly ChatMessage[]>;
  /**
   * Returns a planner-friendly view: at most one active 'summary' message
   * (the most recent one) plus the most recent `limit` regular messages
   * after it. Older regular messages already covered by the summary are
   * omitted from the result.
   */
  forPlanner(sessionId: SessionId, limit?: number): Promise<readonly ChatMessage[]>;
  count(sessionId: SessionId): Promise<number>;
  /**
   * Returns the regular (prompt/report) messages older than the most recent
   * 'summary' OR older than the last `keepRecent` messages — i.e. the messages
   * that should be compacted into a new summary on the next round.
   */
  pendingForCompaction(sessionId: SessionId, keepRecent: number): Promise<readonly ChatMessage[]>;
}

function rowToMessage(row: ChatMessageRow & { covers_until?: number | null }): ChatMessage {
  const cu = row.covers_until;
  return {
    id: row.id,
    role: row.role,
    kind: row.kind,
    content: row.content,
    ts: row.ts,
    ...(cu !== null && cu !== undefined ? { coversUntil: cu } : {}),
  };
}

type FullChatRow = ChatMessageRow & { covers_until?: number | null };

export function createChatHistory(db: PGlite): ChatHistory {
  async function insert(
    sessionId: SessionId,
    role: ChatRole,
    kind: ChatKind,
    content: string,
    coversUntilId?: number,
  ): Promise<ChatMessage> {
    const result = await db.query<FullChatRow>(
      `INSERT INTO chat_messages (session_id, role, kind, content, covers_until)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, session_id, ts, role, kind, content, covers_until`,
      [sessionId, role, kind, content, coversUntilId ?? null],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('failed to insert chat message');
    return rowToMessage(row);
  }

  async function latestSummary(sessionId: SessionId): Promise<FullChatRow | undefined> {
    const result = await db.query<FullChatRow>(
      `SELECT id, session_id, ts, role, kind, content, covers_until
         FROM chat_messages
        WHERE session_id = $1 AND kind = 'summary'
        ORDER BY id DESC
        LIMIT 1`,
      [sessionId],
    );
    return result.rows[0];
  }

  return {
    appendUser(sessionId, content) {
      return insert(sessionId, 'user', 'prompt', content);
    },
    appendAssistant(sessionId, content) {
      return insert(sessionId, 'assistant', 'report', content);
    },
    appendSummary(sessionId, content, coversUntilId) {
      return insert(sessionId, 'assistant', 'summary', content, coversUntilId);
    },
    appendSessionReport(sessionId, content) {
      return insert(sessionId, 'assistant', 'session-report', content);
    },
    async recent(sessionId, limit = DEFAULT_RECENT_LIMIT) {
      const result = await db.query<FullChatRow>(
        `SELECT id, session_id, ts, role, kind, content, covers_until
           FROM chat_messages
          WHERE session_id = $1 AND kind IN ('prompt', 'report')
          ORDER BY ts DESC, id DESC
          LIMIT $2`,
        [sessionId, limit],
      );
      return [...result.rows].reverse().map(rowToMessage);
    },
    async forPlanner(sessionId, limit = DEFAULT_RECENT_LIMIT) {
      const summary = await latestSummary(sessionId);
      if (summary === undefined) {
        const recent = await db.query<FullChatRow>(
          `SELECT id, session_id, ts, role, kind, content, covers_until
             FROM chat_messages
            WHERE session_id = $1 AND kind IN ('prompt', 'report')
            ORDER BY ts DESC, id DESC
            LIMIT $2`,
          [sessionId, limit],
        );
        return [...recent.rows].reverse().map(rowToMessage);
      }
      // Pull regular messages strictly after the summary's coverage window.
      const recent = await db.query<FullChatRow>(
        `SELECT id, session_id, ts, role, kind, content, covers_until
           FROM chat_messages
          WHERE session_id = $1
            AND kind IN ('prompt', 'report')
            AND id > $2
          ORDER BY ts DESC, id DESC
          LIMIT $3`,
        [sessionId, summary.covers_until ?? 0, limit],
      );
      const post = [...recent.rows].reverse().map(rowToMessage);
      return [rowToMessage(summary), ...post];
    },
    async count(sessionId) {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM chat_messages WHERE session_id = $1`,
        [sessionId],
      );
      return Number(result.rows[0]?.count ?? '0');
    },
    async pendingForCompaction(sessionId, keepRecent) {
      const summary = await latestSummary(sessionId);
      const sinceId = summary?.covers_until ?? 0;
      // Take regular messages after the latest summary, in oldest-first order,
      // then drop the most-recent `keepRecent` (we keep those verbatim).
      const all = await db.query<FullChatRow>(
        `SELECT id, session_id, ts, role, kind, content, covers_until
           FROM chat_messages
          WHERE session_id = $1
            AND kind IN ('prompt', 'report')
            AND id > $2
          ORDER BY id ASC`,
        [sessionId, sinceId],
      );
      const list = all.rows;
      if (list.length <= keepRecent) return [];
      return list.slice(0, list.length - keepRecent).map(rowToMessage);
    },
  };
}
