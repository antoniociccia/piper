import type { PGlite } from '@electric-sql/pglite';

interface ColumnInfo {
  readonly atttypmod: number;
}

/**
 * pgvector stores its vector dimension directly in the column's `atttypmod`
 * (NOT with the +4 VARHDRSZ offset that variable-length string types use).
 *
 * Returns the current dim of the `rag_documents.embedding` column, or null if
 * the table doesn't exist yet (first boot, hasn't been ingested into).
 */
export async function getCurrentRagDimension(db: PGlite): Promise<number | null> {
  try {
    const r = await db.query<ColumnInfo>(
      `SELECT atttypmod
         FROM pg_attribute
        WHERE attrelid = 'rag_documents'::regclass
          AND attname  = 'embedding'`,
    );
    const mod = r.rows[0]?.atttypmod;
    if (mod === undefined || mod === null || mod === -1) return null;
    return mod;
  } catch {
    return null;
  }
}

/**
 * Ensure the `rag_documents` table is shaped for the embedder we're about to
 * use. If the existing column has a different dimension (e.g. we switched from
 * 768-dim ollama/nomic to 384-dim WASM/MiniLM), DROP+RECREATE the table.
 *
 * Drops all RAG data, by design — embeddings from one model are not comparable
 * to embeddings from another. They'd produce garbage similarity scores.
 */
export async function ensureRagDimension(
  db: PGlite,
  expectedDimension: number,
): Promise<{ recreated: boolean; previousDimension: number | null }> {
  const current = await getCurrentRagDimension(db);
  if (current === expectedDimension) {
    return { recreated: false, previousDimension: current };
  }
  if (current === null) {
    // Table doesn't exist or was somehow created without a dim — let migrations
    // handle it. We don't recreate from nothing here.
    return { recreated: false, previousDimension: null };
  }
  // Dim mismatch: drop and recreate.
  await db.exec(`
    DROP TABLE IF EXISTS rag_documents;
    CREATE TABLE rag_documents (
      id            BIGSERIAL   PRIMARY KEY,
      source        TEXT        NOT NULL,
      kind          TEXT        NOT NULL CHECK (kind IN ('runbook', 'adr', 'session-summary', 'note', 'solved-case')),
      chunk_index   INTEGER     NOT NULL,
      heading_path  TEXT        NOT NULL DEFAULT '',
      content       TEXT        NOT NULL,
      embedding     vector(${expectedDimension}) NOT NULL,
      content_hash  TEXT        NOT NULL,
      model_id      TEXT        NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (source, chunk_index)
    );
    CREATE INDEX rag_documents_source     ON rag_documents (source);
    CREATE INDEX rag_documents_kind       ON rag_documents (kind);
    CREATE INDEX rag_documents_embedding  ON rag_documents
      USING hnsw (embedding vector_cosine_ops);
  `);
  return { recreated: true, previousDimension: current };
}
