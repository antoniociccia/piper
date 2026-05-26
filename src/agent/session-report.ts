import type { PGlite } from '@electric-sql/pglite';

import type { ChatHistory } from '../memory/chat-history.ts';
import type { CostTracker } from '../models/cost.ts';
import type { CompleteRequest, ModelClient } from '../models/types.ts';
import type { SessionId } from '../memory/types.ts';
import type { EmbeddingClient } from '../rag/embedding-client.ts';
import { vectorLiteral } from '../rag/embedding-client.ts';
import { chunkMarkdown, hashContent } from '../rag/chunker.ts';

import { trackedComplete } from './tracked-complete.ts';

const SESSION_REPORTER_SYSTEM = `You are PIPER's session reporter. You receive the FULL conversation history of
a diagnostic session — every user prompt and every grounded assistant report.

Your job: produce ONE comprehensive markdown report that consolidates everything
into a single coherent document, suitable for handing off to another operator
or filing as a post-incident note.

# Layout (exact section order)

1. **One-paragraph executive summary** (no heading). What was the session
   about? What did we conclude overall?
2. \`## Scope\` — environments and surfaces investigated.
3. \`## Findings\` — the consolidated findings across all turns, grouped by
   environment / topic. Cite individual reports loosely by paraphrase, not
   by \`[ev-N]\` (those refer to per-turn evidence, lost after compaction).
4. \`## Open questions\` — what is still unknown.
5. \`## Recommended next actions\` — concrete steps with owner if obvious.

# Rules

- Do NOT invent facts. Only consolidate what is in the conversation history.
- Use neutral past tense for what happened, present tense for ongoing state.
- No \`[ev-N]\` citations.
- Start IMMEDIATELY with the executive summary — no preamble.
- Aim for 400–900 words. Be specific, not generic.`;

export interface BuildSessionReportInput {
  readonly sessionId: SessionId;
  readonly title?: string;
}

export interface BuildSessionReportDeps {
  readonly chatHistory: ChatHistory;
  readonly client: ModelClient;
  readonly costTracker: CostTracker;
  /** When provided, the report is also embedded and stored in rag_documents
   *  so future sessions can retrieve it semantically. */
  readonly db?: PGlite;
  readonly embedder?: EmbeddingClient;
}

export interface BuildSessionReportOutput {
  readonly reportMarkdown: string;
  readonly costUsd: number;
  readonly ragStored: boolean;
  readonly ragChunkCount: number;
}

function formatTurnsForReporter(messages: readonly { role: string; kind: string; content: string }[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role === 'user' ? 'USER' : m.kind === 'summary' ? 'PIPER (rolling summary)' : 'PIPER';
    lines.push(`### ${role}`);
    lines.push(m.content.trim());
    lines.push('');
  }
  return lines.join('\n');
}

export async function buildSessionReport(
  input: BuildSessionReportInput,
  deps: BuildSessionReportDeps,
): Promise<BuildSessionReportOutput> {
  // Pull the full conversation: planner-shaped view gives us the latest summary
  // (if any) + all messages after it. Then we also pull any pre-summary
  // history that's older than the summary's coverage — already implicitly in
  // the summary itself, so we don't need to fetch them again.
  const conversation = await deps.chatHistory.forPlanner(input.sessionId, 200);
  if (conversation.length === 0) {
    return { reportMarkdown: '', costUsd: 0, ragStored: false, ragChunkCount: 0 };
  }

  const userBody = [
    `Session id: ${input.sessionId}`,
    input.title === undefined ? '' : `Title hint: ${input.title}`,
    '',
    'Conversation history (oldest first; a leading summary entry, if present, covers earlier turns):',
    '',
    formatTurnsForReporter(conversation),
  ]
    .filter((s) => s !== '')
    .join('\n');

  const req: CompleteRequest = {
    messages: [
      { role: 'system', content: SESSION_REPORTER_SYSTEM },
      { role: 'user', content: userBody },
    ],
    temperature: 0.2,
    maxTokens: 2400,
  };

  const { completion, costUsd } = await trackedComplete({
    client: deps.client,
    costTracker: deps.costTracker,
    sessionId: input.sessionId,
    role: 'synthesize',
    req,
  });
  const reportMarkdown = completion.content.trim();
  if (reportMarkdown === '') {
    return { reportMarkdown: '', costUsd, ragStored: false, ragChunkCount: 0 };
  }

  await deps.chatHistory.appendSessionReport(input.sessionId, reportMarkdown);

  let ragStored = false;
  let ragChunkCount = 0;
  if (deps.db !== undefined && deps.embedder !== undefined) {
    try {
      const chunks = chunkMarkdown(reportMarkdown);
      const source = `session-summary:${input.sessionId}`;
      // Wipe any prior version (e.g. if user re-runs /session-report).
      await deps.db.query(`DELETE FROM rag_documents WHERE source = $1`, [source]);
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        if (chunk === undefined) continue;
        const hash = await hashContent(chunk.content);
        const embedding = await deps.embedder.embed(chunk.content);
        await deps.db.query(
          `INSERT INTO rag_documents
             (source, kind, chunk_index, heading_path, content, embedding, content_hash, model_id)
           VALUES ($1, 'session-summary', $2, $3, $4, $5::vector, $6, $7)`,
          [
            source,
            i,
            chunk.headingPath,
            chunk.content,
            vectorLiteral(embedding),
            hash,
            deps.embedder.modelId,
          ],
        );
      }
      ragStored = true;
      ragChunkCount = chunks.length;
    } catch {
      // RAG storage is best-effort.
    }
  }

  return { reportMarkdown, costUsd, ragStored, ragChunkCount };
}
