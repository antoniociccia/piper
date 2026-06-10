import { describe, expect, test } from 'bun:test';

import { createCatalog } from '../../../src/actions/catalog.ts';
import { registerBuiltins } from '../../../src/actions/builtin/index.ts';
import { runAnalyze } from '../../../src/agent/analyze.ts';
import type { AgentEvent, ProposalDecision, ProposedStep } from '../../../src/agent/types.ts';
import type { EnvironmentRegistry } from '../../../src/environments/registry.ts';
import type { SessionId } from '../../../src/memory/types.ts';
import type {
  Completion,
  CompletionChunk,
  CompleteRequest,
  ModelClient,
  ToolCall,
} from '../../../src/models/types.ts';

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

// Minimal stubs for catalog and registry (used only when approveProposals is set)
const stubCatalog = createCatalog();

const stubRegistry: EnvironmentRegistry = {
  upsert: async () => { throw new Error('not implemented'); },
  remove: async () => false,
  get: async () => null,
  list: async () => [],
  describeForLLM: async () => 'envs: (none)',
};

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ── Scripted client helper (mirrors runner.test.ts) ─────────────────────────

interface ScriptedResponse {
  readonly content?: string;
  readonly toolCalls?: readonly ToolCall[];
}

function makeScriptedClient(responses: readonly ScriptedResponse[]): ModelClient {
  let i = 0;
  return {
    id: 'scripted',
    modelId: 'scripted-model',
    isLocal: true,
    capabilities: { toolCalling: true, maxContextTokens: 128_000, streaming: false },
    estimateCost: () => ({ free: true as const }),
    complete: async (_req: CompleteRequest): Promise<Completion> => {
      const r = responses[i] ?? { content: 'no more scripted responses' };
      i += 1;
      return {
        id: `script-${i}`,
        model: 'scripted-model',
        content: r.content ?? '',
        toolCalls: (r.toolCalls ?? []) as ToolCall[],
        finishReason: (r.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
        usage: { inputTokens: 100, outputTokens: 50 },
        costUsd: 0,
      };
    },
    // eslint-disable-next-line require-yield
    stream: async function* (): AsyncIterable<CompletionChunk> {
      return;
    },
  };
}

describe('runAnalyze', () => {
  test('emits a plan, gathers every step, synthesizes, and finishes', async () => {
    const events = await collect(
      runAnalyze(
        { userRequest: 'analizza demo', sessionId: 'sess-1' as SessionId, environment: 'demo' },
        {
          executor: executor as never,
          client: client as never,
          costTracker: costTracker as never,
          catalog: stubCatalog,
          registry: stubRegistry,
        },
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

  test('runs one follow-up round when proposals are approved', async () => {
    const catalog = createCatalog();
    registerBuiltins(catalog);

    const registry: EnvironmentRegistry = {
      upsert: async () => { throw new Error('not implemented'); },
      remove: async () => false,
      get: async () => null,
      list: async () => [],
      describeForLLM: async () => 'envs: demo',
    };

    const scriptedClient = makeScriptedClient([
      // Call 1: baseline synthesize
      { content: 'Host looks healthy [ev-1].' },
      // Call 2: proposer (returns tool call for docker.compose_logs)
      {
        toolCalls: [
          {
            id: 'p1',
            name: 'docker.compose_logs',
            arguments: { environment: 'demo', project_dir: '/opt/orderly' },
          },
        ],
      },
      // Call 3: incremental synthesize
      { content: 'Host looks healthy [ev-1]. Logs show redis OOM [ev-13].' },
    ]);

    const approveProposals = async (
      proposals: readonly ProposedStep[],
      _iteration: number,
    ): Promise<ProposalDecision> => ({
      acceptedIndices: proposals.map((_, i) => i),
      stop: false,
    });

    const events = await collect(
      runAnalyze(
        { userRequest: 'analizza demo e dammi i log', sessionId: 'sess-2' as SessionId, environment: 'demo' },
        {
          executor: executor as never,
          client: scriptedClient as never,
          costTracker: costTracker as never,
          catalog,
          registry,
          approveProposals,
          maxFollowupIterations: 1,
        },
      ),
    );

    const types = events.map((e) => e.type);

    // proposals-ready must appear
    expect(types).toContain('proposals-ready');

    // Two synthesize-ready events: baseline + incremental
    const synthReadyCount = types.filter((t) => t === 'synthesize-ready').length;
    expect(synthReadyCount).toBe(2);

    // Final done event
    expect(types[types.length - 1]).toBe('done');
    const doneEv = events[events.length - 1];
    expect(doneEv.type).toBe('done');
    if (doneEv.type !== 'done') throw new Error('unreachable');

    // Report contains OOM mention
    expect(doneEv.result.reportMarkdown).toContain('OOM');

    // Evidence: 12 discovery + 1 follow-up = 13
    expect(doneEv.result.evidence.length).toBe(13);

    // The last evidence item has id ev-13
    const lastEvidence = doneEv.result.evidence[doneEv.result.evidence.length - 1];
    expect(lastEvidence?.id).toBe('ev-13');
  });
});
