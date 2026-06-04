import { describe, expect, test } from 'bun:test';

import { ingestReportDoc } from '../../../src/agent/session-report.ts';

describe('ingestReportDoc — kind/source are parameterized', () => {
  test('writes the requested kind and source', async () => {
    const captured: { sql: string[]; params: unknown[][] } = { sql: [], params: [] };
    const db = {
      query: async (sql: string, params: unknown[]) => {
        captured.sql.push(sql);
        captured.params.push(params);
        return { rows: [] };
      },
    };
    const embedder = { embed: async () => [0.1, 0.2], modelId: 'fake-embed' };
    const out = await ingestReportDoc({
      db: db as never,
      embedder: embedder as never,
      source: 'solved-case:sess-1',
      kind: 'solved-case',
      markdown: '# Title\n\nbody text here that is long enough.',
    });
    expect(out.ragStored).toBe(true);
    // first call is the DELETE, subsequent are INSERTs
    const insert = captured.params.find((p) => p.includes('solved-case'));
    expect(insert).toBeDefined();
    expect(insert).toContain('solved-case:sess-1');
  });
});
