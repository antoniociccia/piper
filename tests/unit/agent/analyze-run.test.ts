import { describe, expect, test } from 'bun:test';

import { runAnalyze } from '../../../src/agent/analyze.ts';
import type { AgentEvent } from '../../../src/agent/types.ts';
import type { SessionId } from '../../../src/memory/types.ts';

// Stub executor: returns canned stdout for each action, never throws.
const executor = {
  exec: async (actionName: string) => ({
    auditId: 1 as never,
    evidenceId: 1 as never,
    stdout: `output for ${actionName}`,
    stderr: '',
    exitCode: 0,
    durationMs: 1,
  }),
};

// Stub model client: non-streaming, returns a grounded one-liner citing ev-1.
// Extended to satisfy ModelClient interface used by trackedComplete:
//   - estimateCost: returns a free estimate (no budget guard needed)
//   - complete: returns a full Completion shape including model/id/toolCalls/etc.
const client = {
  id: 'stub',
  modelId: 'stub-model',
  isLocal: true,
  capabilities: { streaming: false, toolCalling: true, maxContextTokens: 8000 },
  estimateCost: () => ({ free: true as const }),
  complete: async () => ({
    id: 'stub-completion',
    model: 'stub-model',
    content: 'Host looks healthy [ev-1].',
    toolCalls: [] as never[],
    finishReason: 'stop' as const,
    usage: { inputTokens: 1, outputTokens: 1 },
    costUsd: 0,
  }),
  stream: async function* () { /* never called when streaming: false */ },
};

// Stub costTracker: satisfies the CostTracker interface used by trackedComplete:
//   - guard: no-op (maxSessionCostUsd is null so budget is never exceeded)
//   - record: returns zero cost (local model)
const costTracker = {
  maxSessionCostUsd: null,
  visibilityThresholdUsd: 0.05,
  sessionTotal: async () => 0,
  estimateAddCost: () => 0,
  shouldDisplay: () => false,
  guard: async () => {},
  record: async () => ({ costUsd: 0, newSessionTotal: 0 }),
};

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('runAnalyze', () => {
  test('emits a plan, gathers every step, synthesizes, and finishes', async () => {
    const events = await collect(
      runAnalyze(
        { userRequest: 'analizza demo', sessionId: 'sess-1' as SessionId, environment: 'demo' },
        { executor: executor as never, client: client as never, costTracker: costTracker as never },
      ),
    );
    const types = events.map((e) => e.type);
    expect(types).toContain('plan-ready');
    expect(types).toContain('gather-step-done');
    expect(types).toContain('synthesize-ready');
    expect(types[types.length - 1]).toBe('done');
    const done = events[events.length - 1];
    expect(done.type === 'done' && done.result.reportMarkdown).toContain('healthy');
  });
});
