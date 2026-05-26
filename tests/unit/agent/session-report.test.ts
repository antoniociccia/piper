import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';

import { buildSessionReport } from '../../../src/agent/session-report.ts';
import { createChatHistory } from '../../../src/memory/chat-history.ts';
import { closeDb, openDb } from '../../../src/memory/db.ts';
import { createCostTracker } from '../../../src/models/cost.ts';
import type {
  Completion,
  CompletionChunk,
  CompleteRequest,
  ModelClient,
} from '../../../src/models/types.ts';
import type { EmbeddingClient } from '../../../src/rag/embedding-client.ts';

let db: PGlite | null = null;
let sessionId: string;

beforeEach(async () => {
  db = await openDb();
  sessionId = `sr-${crypto.randomUUID()}`;
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

function makeClient(content: string): ModelClient {
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

function makeEmbedder(dim = 4): EmbeddingClient {
  return {
    id: 'mock-embed',
    modelId: 'mock-embed',
    dimension: dim,
    isLocal: true,
    embed: async (s) => {
      // deterministic, dim-N
      const out = new Float32Array(dim);
      for (let i = 0; i < dim; i += 1) out[i] = ((s.charCodeAt(i) ?? 0) % 100) / 100;
      return out;
    },
    embedBatch: async (ts) =>
      ts.map((s) => {
        const out = new Float32Array(dim);
        for (let i = 0; i < dim; i += 1) out[i] = ((s.charCodeAt(i) ?? 0) % 100) / 100;
        return out;
      }),
  };
}

describe('agent/session-report', () => {
  test('produces and persists a session-report message; reports cost', async () => {
    if (db === null) throw new Error('db missing');
    const history = createChatHistory(db);
    const tracker = createCostTracker({ db });
    await history.appendUser(sessionId, 'check uptime on staging');
    await history.appendAssistant(sessionId, 'Uptime is fine [ev-1].');

    const out = await buildSessionReport(
      { sessionId },
      {
        chatHistory: history,
        client: makeClient('# Session report\nAll healthy.\n\n## Findings\n- staging up.'),
        costTracker: tracker,
      },
    );
    expect(out.reportMarkdown).toContain('Session report');
    expect(out.costUsd).toBe(0);
    expect(out.ragStored).toBe(false);

    const persisted = await db.query<{ kind: string; content: string }>(
      `SELECT kind, content FROM chat_messages WHERE session_id = $1 AND kind = 'session-report'`,
      [sessionId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]?.content).toContain('Session report');
  });

  test('embeds and stores in rag_documents when db + embedder are provided', async () => {
    if (db === null) throw new Error('db missing');
    // Shrink rag_documents to dim=4 for the test
    await db.exec('DROP TABLE rag_documents');
    await db.exec(`
      CREATE TABLE rag_documents (
        id            BIGSERIAL PRIMARY KEY,
        source        TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('runbook', 'adr', 'session-summary', 'note')),
        chunk_index   INTEGER NOT NULL,
        heading_path  TEXT NOT NULL DEFAULT '',
        content       TEXT NOT NULL,
        embedding     vector(4) NOT NULL,
        content_hash  TEXT NOT NULL,
        model_id      TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const history = createChatHistory(db);
    const tracker = createCostTracker({ db });
    await history.appendUser(sessionId, 'inspect deploy');
    await history.appendAssistant(sessionId, 'Deploy is healthy.');

    const out = await buildSessionReport(
      { sessionId },
      {
        chatHistory: history,
        client: makeClient('# Summary\nbody body body.\n\n## A\nmore body.'),
        costTracker: tracker,
        db,
        embedder: makeEmbedder(4),
      },
    );
    expect(out.ragStored).toBe(true);
    expect(out.ragChunkCount).toBeGreaterThan(0);

    const stored = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM rag_documents WHERE source = $1`,
      [`session-summary:${sessionId}`],
    );
    expect(Number(stored.rows[0]?.count ?? '0')).toBe(out.ragChunkCount);
  });

  test('returns empty string when there is no conversation history yet', async () => {
    if (db === null) throw new Error('db missing');
    const history = createChatHistory(db);
    const tracker = createCostTracker({ db });

    const out = await buildSessionReport(
      { sessionId },
      { chatHistory: history, client: makeClient('UNREACHED'), costTracker: tracker },
    );
    expect(out.reportMarkdown).toBe('');
    expect(out.ragStored).toBe(false);
  });
});
