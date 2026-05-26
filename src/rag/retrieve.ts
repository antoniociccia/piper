import type { PGlite } from '@electric-sql/pglite';

import type { RagDocKind } from '../memory/types.ts';

import { vectorLiteral, type EmbeddingClient } from './embedding-client.ts';

export interface RetrievedChunk {
  readonly id: number;
  readonly source: string;
  readonly kind: RagDocKind;
  readonly headingPath: string;
  readonly content: string;
  readonly similarity: number;
}

export interface RetrieveOptions {
  readonly db: PGlite;
  readonly embedder: EmbeddingClient;
  readonly query: string;
  readonly k?: number;
  readonly minSimilarity?: number;
  readonly kinds?: readonly RagDocKind[];
}

const DEFAULT_K = 4;
const DEFAULT_MIN_SIMILARITY = 0.45;

interface QueryRow {
  readonly id: number;
  readonly source: string;
  readonly kind: RagDocKind;
  readonly heading_path: string;
  readonly content: string;
  readonly sim: number;
}

export async function retrieveRelevant(opts: RetrieveOptions): Promise<readonly RetrievedChunk[]> {
  const queryText = opts.query.trim();
  if (queryText === '') return [];

  const k = opts.k ?? DEFAULT_K;
  const minSim = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const embedding = await opts.embedder.embed(queryText);

  const kinds = opts.kinds;
  const params: unknown[] = [vectorLiteral(embedding), k];
  let kindFilter = '';
  if (kinds !== undefined && kinds.length > 0) {
    params.push(kinds);
    kindFilter = `WHERE kind = ANY ($3::text[])`;
  }

  const result = await opts.db.query<QueryRow>(
    `SELECT id, source, kind, heading_path, content,
            1 - (embedding <=> $1::vector) AS sim
       FROM rag_documents
       ${kindFilter}
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
    params,
  );

  return result.rows
    .filter((r) => r.sim >= minSim)
    .map((r) => ({
      id: r.id,
      source: r.source,
      kind: r.kind,
      headingPath: r.heading_path,
      content: r.content,
      similarity: r.sim,
    }));
}

/**
 * Format retrieved chunks as a system-prompt block.
 * Empty input → empty string (caller can `if (block !== '')` to decide whether
 * to inject it).
 */
export function formatRetrievalBlock(chunks: readonly RetrievedChunk[]): string {
  if (chunks.length === 0) return '';
  const lines: string[] = [
    '# Relevant prior knowledge (from runbooks / ADRs / past sessions)',
    '',
    'Use the items below to inform your plan when they apply. They are NOT evidence — they are guidance from the project\'s knowledge base. Do not cite them in the report (citations are for live action evidence only).',
    '',
  ];
  for (const chunk of chunks) {
    const score = chunk.similarity.toFixed(2);
    const path = chunk.headingPath === '' ? chunk.source : chunk.headingPath;
    lines.push(`## [${chunk.kind}] ${path}   (similarity ${score})`);
    lines.push(chunk.content);
    lines.push('');
  }
  return lines.join('\n');
}
