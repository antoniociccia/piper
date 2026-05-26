import type { PGlite } from '@electric-sql/pglite';
import { Glob } from 'bun';
import { resolve as resolvePath } from 'node:path';

import type { Logger } from '../logging/logger.ts';
import type { RagDocKind } from '../memory/types.ts';

import { chunkMarkdown, hashContent } from './chunker.ts';
import { vectorLiteral, type EmbeddingClient } from './embedding-client.ts';

interface IngestSource {
  readonly glob: string;
  readonly kind: RagDocKind;
}

const DEFAULT_SOURCES: readonly IngestSource[] = [
  { glob: 'docs/runbooks/**/*.md', kind: 'runbook' },
  { glob: 'docs/decisions/**/*.md', kind: 'adr' },
];

export interface IngestOptions {
  readonly db: PGlite;
  readonly embedder: EmbeddingClient;
  readonly logger?: Logger;
  readonly projectRoot?: string;
  readonly sources?: readonly IngestSource[];
}

export interface IngestStats {
  readonly source: string;
  readonly kind: RagDocKind;
  readonly chunksTotal: number;
  readonly chunksInserted: number;
  readonly chunksSkipped: number;
}

interface ExistingChunkRow {
  readonly chunk_index: number;
  readonly content_hash: string;
  readonly model_id: string;
}

function sourceKey(kind: RagDocKind, relPath: string): string {
  return `${kind}:${relPath.replace(/^docs\//, '').replace(/\.md$/, '')}`;
}

export async function ingestRunbooks(opts: IngestOptions): Promise<readonly IngestStats[]> {
  const root = opts.projectRoot ?? process.cwd();
  const sources = opts.sources ?? DEFAULT_SOURCES;
  const stats: IngestStats[] = [];

  for (const src of sources) {
    const glob = new Glob(src.glob);
    for await (const relPath of glob.scan({ cwd: root })) {
      const abs = resolvePath(root, relPath);
      const content = await Bun.file(abs).text();
      const source = sourceKey(src.kind, relPath);
      const chunks = chunkMarkdown(content);

      const existing = await opts.db.query<ExistingChunkRow>(
        `SELECT chunk_index, content_hash, model_id FROM rag_documents WHERE source = $1`,
        [source],
      );
      const byIndex = new Map<number, ExistingChunkRow>();
      for (const row of existing.rows) byIndex.set(row.chunk_index, row);

      let inserted = 0;
      let skipped = 0;

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (chunk === undefined) continue;
        const hash = await hashContent(chunk.content);
        const prior = byIndex.get(i);
        if (
          prior !== undefined &&
          prior.content_hash === hash &&
          prior.model_id === opts.embedder.modelId
        ) {
          skipped += 1;
          byIndex.delete(i);
          continue;
        }

        const embedding = await opts.embedder.embed(chunk.content);

        if (prior !== undefined) {
          await opts.db.query(
            `UPDATE rag_documents
                SET heading_path = $1,
                    content      = $2,
                    embedding    = $3::vector,
                    content_hash = $4,
                    model_id     = $5
              WHERE source = $6 AND chunk_index = $7`,
            [chunk.headingPath, chunk.content, vectorLiteral(embedding), hash, opts.embedder.modelId, source, i],
          );
          byIndex.delete(i);
        } else {
          await opts.db.query(
            `INSERT INTO rag_documents
               (source, kind, chunk_index, heading_path, content, embedding, content_hash, model_id)
             VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8)`,
            [
              source,
              src.kind,
              i,
              chunk.headingPath,
              chunk.content,
              vectorLiteral(embedding),
              hash,
              opts.embedder.modelId,
            ],
          );
        }
        inserted += 1;
      }

      // Stale chunks (file shrank): delete any remaining old rows.
      for (const staleIndex of byIndex.keys()) {
        await opts.db.query(
          `DELETE FROM rag_documents WHERE source = $1 AND chunk_index = $2`,
          [source, staleIndex],
        );
      }

      stats.push({
        source,
        kind: src.kind,
        chunksTotal: chunks.length,
        chunksInserted: inserted,
        chunksSkipped: skipped,
      });
      opts.logger?.debug('ingested', {
        source,
        kind: src.kind,
        total: chunks.length,
        inserted,
        skipped,
      });
    }
  }

  return stats;
}
