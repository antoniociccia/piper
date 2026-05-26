import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EmbeddingClient } from '../../../src/rag/embedding-client.ts';
import { ingestRunbooks } from '../../../src/rag/ingest.ts';
import { closeDb, openDb } from '../../../src/memory/db.ts';

let db: PGlite | null = null;
let tmp: string;

beforeEach(async () => {
  db = await openDb();
  tmp = mkdtempSync(join(tmpdir(), 'piper-ingest-'));
});

afterEach(async () => {
  if (db !== null) {
    await closeDb(db);
    db = null;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function makeDeterministicEmbedder(modelId: string): EmbeddingClient {
  // Deterministic embedding from a hash of the input — same input always produces
  // the same 4-dim vector. Suitable for testing ingest/dedup behaviour.
  function embed(text: string): Float32Array {
    let h = 0;
    for (let i = 0; i < text.length; i += 1) {
      h = (h * 31 + text.charCodeAt(i)) | 0;
    }
    return Float32Array.from([
      Math.sin(h) / 2,
      Math.cos(h) / 2,
      Math.sin(h * 2) / 2,
      Math.cos(h * 3) / 2,
    ]);
  }
  return {
    id: 'test-embedder',
    modelId,
    dimension: 4,
    isLocal: true,
    embed: async (t) => embed(t),
    embedBatch: async (ts) => ts.map(embed),
  };
}

async function setSchemaTo4dim(): Promise<void> {
  // The default schema uses vector(768). For tests we want vector(4) to keep
  // the mock embedder small. Re-create the table.
  if (db === null) return;
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
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (source, chunk_index)
    );
  `);
}

describe('rag/ingest', () => {
  test('inserts all chunks on first run; idempotent on second', async () => {
    if (db === null) throw new Error('db missing');
    await setSchemaTo4dim();
    mkdirSync(join(tmp, 'docs/runbooks'), { recursive: true });
    writeFileSync(
      join(tmp, 'docs/runbooks/hello.md'),
      '# Hello\nIntro.\n\n## A\nBody A.\n\n## B\nBody B.',
    );
    const embedder = makeDeterministicEmbedder('test-model');

    const first = await ingestRunbooks({ db, embedder, projectRoot: tmp });
    expect(first).toHaveLength(1);
    expect(first[0]?.chunksInserted).toBe(3);
    expect(first[0]?.chunksSkipped).toBe(0);

    const second = await ingestRunbooks({ db, embedder, projectRoot: tmp });
    expect(second[0]?.chunksInserted).toBe(0);
    expect(second[0]?.chunksSkipped).toBe(3);

    const count = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM rag_documents`,
    );
    expect(Number(count.rows[0]?.count ?? '0')).toBe(3);
  });

  test('re-embeds chunks whose content changed', async () => {
    if (db === null) throw new Error('db missing');
    await setSchemaTo4dim();
    mkdirSync(join(tmp, 'docs/runbooks'), { recursive: true });
    writeFileSync(join(tmp, 'docs/runbooks/x.md'), '# T\nfirst body\n\n## S\nstable');
    const embedder = makeDeterministicEmbedder('m1');

    await ingestRunbooks({ db, embedder, projectRoot: tmp });

    writeFileSync(join(tmp, 'docs/runbooks/x.md'), '# T\nchanged body\n\n## S\nstable');
    const result = await ingestRunbooks({ db, embedder, projectRoot: tmp });
    expect(result[0]?.chunksInserted).toBe(1); // only first chunk changed
    expect(result[0]?.chunksSkipped).toBe(1);
  });

  test('deletes stale chunks when the file shrinks', async () => {
    if (db === null) throw new Error('db missing');
    await setSchemaTo4dim();
    mkdirSync(join(tmp, 'docs/runbooks'), { recursive: true });
    writeFileSync(join(tmp, 'docs/runbooks/y.md'), '# T\na\n\n## B\nb\n\n## C\nc');
    const embedder = makeDeterministicEmbedder('m1');

    await ingestRunbooks({ db, embedder, projectRoot: tmp });
    let count = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM rag_documents`);
    expect(Number(count.rows[0]?.count ?? '0')).toBe(3);

    writeFileSync(join(tmp, 'docs/runbooks/y.md'), '# T\nonly');
    await ingestRunbooks({ db, embedder, projectRoot: tmp });
    count = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM rag_documents`);
    expect(Number(count.rows[0]?.count ?? '0')).toBe(1);
  });

  test('re-embeds when the embedder model_id changes', async () => {
    if (db === null) throw new Error('db missing');
    await setSchemaTo4dim();
    mkdirSync(join(tmp, 'docs/runbooks'), { recursive: true });
    writeFileSync(join(tmp, 'docs/runbooks/z.md'), '# T\nbody');
    await ingestRunbooks({ db, embedder: makeDeterministicEmbedder('m1'), projectRoot: tmp });

    const result = await ingestRunbooks({ db, embedder: makeDeterministicEmbedder('m2'), projectRoot: tmp });
    expect(result[0]?.chunksInserted).toBe(1);
    expect(result[0]?.chunksSkipped).toBe(0);
  });
});
