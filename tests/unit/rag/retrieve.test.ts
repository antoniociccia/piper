import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';

import type { EmbeddingClient } from '../../../src/rag/embedding-client.ts';
import { formatRetrievalBlock, retrieveRelevant } from '../../../src/rag/retrieve.ts';
import { closeDb, openDb } from '../../../src/memory/db.ts';

let db: PGlite | null = null;

beforeEach(async () => {
  db = await openDb();
  // shrink dimension to 3 for hand-crafted vectors
  if (db !== null) {
    await db.exec('DROP TABLE rag_documents');
    await db.exec(`
      CREATE TABLE rag_documents (
        id            BIGSERIAL PRIMARY KEY,
        source        TEXT NOT NULL,
        kind          TEXT NOT NULL CHECK (kind IN ('runbook', 'adr', 'session-summary', 'note')),
        chunk_index   INTEGER NOT NULL,
        heading_path  TEXT NOT NULL DEFAULT '',
        content       TEXT NOT NULL,
        embedding     vector(3) NOT NULL,
        content_hash  TEXT NOT NULL,
        model_id      TEXT NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }
});

afterEach(async () => {
  if (db !== null) {
    await closeDb(db);
    db = null;
  }
});

function fixedEmbedder(vector: readonly number[]): EmbeddingClient {
  return {
    id: 'test',
    modelId: 'test',
    dimension: vector.length,
    isLocal: true,
    embed: async () => Float32Array.from(vector),
    embedBatch: async (ts) => ts.map(() => Float32Array.from(vector)),
  };
}

async function seed(
  rows: ReadonlyArray<{ source: string; kind: 'runbook' | 'adr' | 'session-summary' | 'note'; v: [number, number, number]; content: string; heading?: string }>,
): Promise<void> {
  if (db === null) throw new Error('db missing');
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (r === undefined) continue;
    await db.query(
      `INSERT INTO rag_documents (source, kind, chunk_index, heading_path, content, embedding, content_hash, model_id)
       VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)`,
      [r.source, r.kind, i, r.heading ?? '', r.content, `[${r.v.join(',')}]`, `h${i}`, 'mock'],
    );
  }
}

describe('rag/retrieve', () => {
  test('returns chunks ordered by descending cosine similarity, above threshold', async () => {
    await seed([
      { source: 'runbook:a', kind: 'runbook', v: [1, 0, 0], content: 'aligned', heading: 'A' },
      { source: 'runbook:b', kind: 'runbook', v: [0.7, 0.7, 0], content: 'partial', heading: 'B' },
      { source: 'runbook:c', kind: 'runbook', v: [0, 1, 0], content: 'orthogonal', heading: 'C' },
    ]);
    const out = await retrieveRelevant({
      db: db!,
      embedder: fixedEmbedder([1, 0, 0]),
      query: 'anything',
      minSimilarity: 0.5,
    });
    expect(out.map((c) => c.headingPath)).toEqual(['A', 'B']); // 'C' filtered out at sim=0
    expect(out[0]!.similarity).toBeGreaterThan(out[1]!.similarity);
  });

  test('respects k (top-N)', async () => {
    await seed([
      { source: 's1', kind: 'runbook', v: [1, 0, 0], content: 'a' },
      { source: 's2', kind: 'runbook', v: [0.9, 0.1, 0], content: 'b' },
      { source: 's3', kind: 'runbook', v: [0.8, 0.2, 0], content: 'c' },
      { source: 's4', kind: 'runbook', v: [0.7, 0.3, 0], content: 'd' },
    ]);
    const out = await retrieveRelevant({
      db: db!,
      embedder: fixedEmbedder([1, 0, 0]),
      query: 'q',
      k: 2,
      minSimilarity: 0,
    });
    expect(out).toHaveLength(2);
  });

  test('respects kinds filter', async () => {
    await seed([
      { source: 'r', kind: 'runbook', v: [1, 0, 0], content: 'rbook' },
      { source: 'a', kind: 'adr', v: [1, 0, 0], content: 'adr' },
    ]);
    const out = await retrieveRelevant({
      db: db!,
      embedder: fixedEmbedder([1, 0, 0]),
      query: 'q',
      kinds: ['adr'],
      minSimilarity: 0,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('adr');
  });

  test('empty query short-circuits to []', async () => {
    await seed([{ source: 'x', kind: 'runbook', v: [1, 0, 0], content: 'x' }]);
    const out = await retrieveRelevant({
      db: db!,
      embedder: fixedEmbedder([1, 0, 0]),
      query: '   ',
    });
    expect(out).toEqual([]);
  });

  test('formatRetrievalBlock yields empty string for no chunks', () => {
    expect(formatRetrievalBlock([])).toBe('');
  });

  test('formatRetrievalBlock embeds heading path, kind, similarity', () => {
    const block = formatRetrievalBlock([
      {
        id: 1,
        source: 'runbook:setup',
        kind: 'runbook',
        headingPath: 'Setup > Step 1',
        content: 'body content',
        similarity: 0.81,
      },
    ]);
    expect(block).toContain('Relevant prior knowledge');
    expect(block).toContain('[runbook] Setup > Step 1');
    expect(block).toContain('similarity 0.81');
    expect(block).toContain('body content');
  });
});
