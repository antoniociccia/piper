import { z } from 'zod';

import type { Action, ActionExecContext } from '../types.ts';

const argsSchema = z.object({
  query: z.string().min(2).max(500),
  k: z.number().int().positive().max(10).optional(),
  kinds: z
    .array(z.enum(['runbook', 'adr', 'session-summary', 'note', 'solved-case']))
    .optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface MemorySearchResult {
  readonly query: string;
  readonly hits: ReadonlyArray<{
    readonly source: string;
    readonly kind: string;
    readonly headingPath: string;
    readonly similarity: number;
    readonly excerpt: string;
  }>;
}

/**
 * Look up the project's knowledge base (runbooks, ADRs, prior session summaries,
 * solved cases) for chunks semantically similar to a query. Read-tier: this is
 * a pure DB lookup, no shell, no SSH. The agent calls this when it suspects a
 * known incident pattern or wants to find prior guidance.
 *
 * Implementation: this action is RESOLVED INSIDE THE EXECUTOR via the special
 * action-name dispatch (see executor.ts). We can't shell out because the data
 * lives in PGlite + pgvector inside the same process.
 */
export const memorySearch: Action<Args, MemorySearchResult> = {
  name: 'memory.search',
  tier: 'read',
  description:
    'Search PIPER\'s knowledge base (runbooks, ADRs, past session summaries, solved cases) for chunks semantically similar to a free-text query. Use this when the user\'s prompt looks like something the project may already document — known incident patterns, deploy procedures, prior diagnoses on the same host. Returns up to k results above a similarity threshold.',
  argsSchema,
  buildCommand: (_args, _ctx: ActionExecContext) => {
    // Special action: handled in-process by the executor (no exec).
    // We still return a dummy command so the catalog plumbing is happy; the
    // executor dispatches by action name before reaching shell.
    return ['__memory_search__'];
  },
  parseResult: (raw) => {
    // The executor for this special action writes the JSON result to stdout
    // verbatim. We parse it back into the typed result.
    try {
      return JSON.parse(raw.stdout) as MemorySearchResult;
    } catch {
      return { query: '', hits: [] };
    }
  },
};
