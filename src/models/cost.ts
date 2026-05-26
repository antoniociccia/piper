import type { PGlite } from '@electric-sql/pglite';

import type { SessionId } from '../memory/types.ts';
import { computeCost } from './pricing.ts';
import type { CostEstimate } from './types.ts';

export class BudgetExceededError extends Error {
  readonly sessionId: SessionId;
  readonly currentTotalUsd: number;
  readonly estimatedAddUsd: number;
  readonly limitUsd: number;

  constructor(opts: {
    sessionId: SessionId;
    currentTotalUsd: number;
    estimatedAddUsd: number;
    limitUsd: number;
  }) {
    super(
      `session ${opts.sessionId} would exceed budget (current=$${opts.currentTotalUsd.toFixed(4)}, +$${opts.estimatedAddUsd.toFixed(4)}, limit=$${opts.limitUsd.toFixed(2)})`,
    );
    this.name = 'BudgetExceededError';
    this.sessionId = opts.sessionId;
    this.currentTotalUsd = opts.currentTotalUsd;
    this.estimatedAddUsd = opts.estimatedAddUsd;
    this.limitUsd = opts.limitUsd;
  }
}

export interface RecordCostInput {
  readonly sessionId: SessionId;
  readonly model: string;
  readonly role: 'planner' | 'gather' | 'synthesize' | 'verifier' | 'tl' | 'worker' | 'other';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly payloadHash: string;
}

export interface CostTrackerOptions {
  readonly db: PGlite;
  readonly maxSessionCostUsd?: number;
  readonly visibilityThresholdUsd?: number;
}

export interface CostTracker {
  readonly visibilityThresholdUsd: number;
  readonly maxSessionCostUsd: number | null;
  sessionTotal(sessionId: SessionId): Promise<number>;
  estimateAddCost(estimate: CostEstimate): number;
  shouldDisplay(estimate: CostEstimate): boolean;
  guard(sessionId: SessionId, estimate: CostEstimate): Promise<void>;
  record(input: RecordCostInput): Promise<{ costUsd: number; newSessionTotal: number }>;
}

const DEFAULT_VISIBILITY_THRESHOLD = 0.05;

export function createCostTracker(opts: CostTrackerOptions): CostTracker {
  const visibilityThresholdUsd = opts.visibilityThresholdUsd ?? DEFAULT_VISIBILITY_THRESHOLD;
  const maxSessionCostUsd = opts.maxSessionCostUsd ?? null;
  const db = opts.db;

  async function sessionTotal(sessionId: SessionId): Promise<number> {
    const result = await db.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::text AS total
         FROM llm_calls WHERE session_id = $1`,
      [sessionId],
    );
    const raw = result.rows[0]?.total ?? '0';
    return Number(raw);
  }

  function estimateAddCost(estimate: CostEstimate): number {
    if (estimate.free) return 0;
    return estimate.maxUsd;
  }

  function shouldDisplay(estimate: CostEstimate): boolean {
    if (estimate.free) return false;
    return estimate.maxUsd >= visibilityThresholdUsd;
  }

  async function guard(sessionId: SessionId, estimate: CostEstimate): Promise<void> {
    if (maxSessionCostUsd === null) return;
    if (estimate.free) return;
    const current = await sessionTotal(sessionId);
    const projected = current + estimate.maxUsd;
    if (projected > maxSessionCostUsd) {
      throw new BudgetExceededError({
        sessionId,
        currentTotalUsd: current,
        estimatedAddUsd: estimate.maxUsd,
        limitUsd: maxSessionCostUsd,
      });
    }
  }

  async function record(
    input: RecordCostInput,
  ): Promise<{ costUsd: number; newSessionTotal: number }> {
    const cost = computeCost(input.model, input.inputTokens, input.outputTokens);
    await db.query(
      `INSERT INTO llm_calls
         (session_id, model, role, input_tokens, output_tokens, cost_usd, payload_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        input.sessionId,
        input.model,
        input.role,
        input.inputTokens,
        input.outputTokens,
        cost.totalUsd,
        input.payloadHash,
      ],
    );
    await db.query(
      `UPDATE sessions SET cost_usd_total = cost_usd_total + $1 WHERE id = $2`,
      [cost.totalUsd, input.sessionId],
    );
    const newTotal = await sessionTotal(input.sessionId);
    return { costUsd: cost.totalUsd, newSessionTotal: newTotal };
  }

  return {
    visibilityThresholdUsd,
    maxSessionCostUsd,
    sessionTotal,
    estimateAddCost,
    shouldDisplay,
    guard,
    record,
  };
}

export async function hashPayload(payload: unknown): Promise<string> {
  const text = JSON.stringify(payload);
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}
