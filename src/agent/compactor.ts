import type { ChatHistory, ChatMessage } from '../memory/chat-history.ts';
import type { CostTracker } from '../models/cost.ts';
import type { CompleteRequest, ModelClient } from '../models/types.ts';
import type { SessionId } from '../memory/types.ts';

import { trackedComplete } from './tracked-complete.ts';

const COMPACTOR_SYSTEM = `You are PIPER's history compactor. You receive a chronological list of older
turns of a diagnostic session. Each turn is a user prompt followed by the
assistant's grounded report.

Your job: emit ONE concise narrative summary (target 200–500 words) that
preserves:

1. Which environments were investigated and any key facts learned about them
   (OS, services running, recurring errors, suspicious activity).
2. Important deltas (what changed turn-to-turn, what was confirmed vs ruled out).
3. Open questions and unresolved gaps from prior turns.
4. References to specific evidence the planner would want when picking the next
   action (e.g. "backend container demo-backend-1 was up; postgres
   container was not inspected").

Rules:

- Use neutral past tense.
- Do not invent facts. If you don't have it, omit it.
- No \`[ev-N]\` citations (those refer to live evidence, not history).
- Output prose, not bullets. The planner reads this as ONE message.
- Start IMMEDIATELY with the summary — no preamble.`;

export interface CompactionOptions {
  readonly db: never; // typing reminder — we go through ChatHistory, not raw db
}

export interface CompactionParams {
  readonly sessionId: SessionId;
  readonly chatHistory: ChatHistory;
  readonly client: ModelClient;
  readonly costTracker: CostTracker;
  readonly keepRecent?: number;
  readonly minToCompact?: number;
}

const DEFAULT_KEEP_RECENT = 6;
const DEFAULT_MIN_TO_COMPACT = 4;

export interface ShouldCompactInput {
  readonly tokensUsed: number;
  readonly modelLimit: number;
  /** Tokens we want to leave free for the next response generation. */
  readonly reservedForOutput?: number;
  /** Fraction of the EFFECTIVE limit (= modelLimit - reservedForOutput) at which we compact. */
  readonly triggerPct?: number;
  /** Optional fallback: compact whenever this many pending regular messages exist. */
  readonly pendingMessageCount?: number;
  readonly pendingMessageThreshold?: number;
}

/**
 * Decide whether to invoke `maybeCompactHistory` before the next planner call.
 * Returns the reason as a string for logging; null if no compaction needed.
 */
export function shouldCompact(input: ShouldCompactInput): { triggered: true; reason: string } | { triggered: false } {
  const reserved = input.reservedForOutput ?? 2048;
  const triggerPct = input.triggerPct ?? 0.70;
  const effective = Math.max(1, input.modelLimit - reserved);
  const threshold = Math.floor(effective * triggerPct);
  if (input.tokensUsed > threshold) {
    return {
      triggered: true,
      reason: `tokens ${input.tokensUsed} > ${threshold} (${Math.round(triggerPct * 100)}% of ${effective})`,
    };
  }
  if (
    input.pendingMessageCount !== undefined &&
    input.pendingMessageThreshold !== undefined &&
    input.pendingMessageCount > input.pendingMessageThreshold
  ) {
    return {
      triggered: true,
      reason: `pending messages ${input.pendingMessageCount} > ${input.pendingMessageThreshold}`,
    };
  }
  return { triggered: false };
}

function formatPendingForLLM(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = m.role === 'user' ? 'USER' : 'PIPER';
    lines.push(`### ${role}`);
    lines.push(m.content.trim());
    lines.push('');
  }
  return lines.join('\n');
}

export interface CompactionResult {
  readonly compacted: boolean;
  readonly coversUntilId?: number;
  readonly costUsd: number;
  readonly summaryLength?: number;
}

/**
 * If there are at least `minToCompact` older messages (beyond the last
 * `keepRecent`), summarise them via the LLM and persist as a 'summary' message
 * whose `covers_until` points at the most recent id covered.
 *
 * Idempotent: if nothing new to compact, returns { compacted: false }.
 */
export async function maybeCompactHistory(opts: CompactionParams): Promise<CompactionResult> {
  const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;
  const minToCompact = opts.minToCompact ?? DEFAULT_MIN_TO_COMPACT;

  const pending = await opts.chatHistory.pendingForCompaction(opts.sessionId, keepRecent);
  if (pending.length < minToCompact) {
    return { compacted: false, costUsd: 0 };
  }

  const covers = pending[pending.length - 1]?.id;
  if (covers === undefined) return { compacted: false, costUsd: 0 };

  const req: CompleteRequest = {
    messages: [
      { role: 'system', content: COMPACTOR_SYSTEM },
      { role: 'user', content: `Older turns to summarise:\n\n${formatPendingForLLM(pending)}` },
    ],
    temperature: 0.2,
    maxTokens: 800,
  };

  const { completion, costUsd } = await trackedComplete({
    client: opts.client,
    costTracker: opts.costTracker,
    sessionId: opts.sessionId,
    role: 'synthesize',
    req,
  });

  const summaryText = completion.content.trim();
  if (summaryText === '') {
    return { compacted: false, costUsd };
  }

  await opts.chatHistory.appendSummary(opts.sessionId, summaryText, covers);

  return {
    compacted: true,
    coversUntilId: covers,
    costUsd,
    summaryLength: summaryText.length,
  };
}
