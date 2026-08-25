import { describe, expect, test } from 'bun:test';

import { createCatalog } from '../../../src/actions/catalog.ts';
import { registerBuiltins } from '../../../src/actions/builtin/index.ts';
import { buildDiscoveryPlan, runAnalyze } from '../../../src/agent/analyze.ts';
import type { AgentEvent, ProposedStep } from '../../../src/agent/types.ts';
import type { EnvironmentRegistry } from '../../../src/environments/registry.ts';
import type { SessionId } from '../../../src/memory/types.ts';
import type { CompleteRequest, ModelClient } from '../../../src/models/types.ts';

/**
 * Two defects found by pointing analyze at a host with seven planted incidents
 * and watching three different local models all miss most of them.
 *
 *   1. The drill round was gated on the baseline report passing verification.
 *      A model that mis-formats its citations was therefore forbidden from
 *      GATHERING MORE EVIDENCE — and then judged on the evidence it had been
 *      prevented from collecting. Measured: qwen3.5:9b scored WORSE than
 *      qwen3.5:4b purely because the 4b happened to pass verification on its
 *      third attempt and so was allowed to drill.
 *
 *   2. The deterministic discovery sweep never looked at logs, so any incident
 *      living in a file under /var/log was invisible unless the model guessed
 *      the path unprompted. Three of the seven planted incidents — a failing
 *      backup, an expired certificate, an unrotated 62 MB log — were missed by
 *      every model for this reason.
 */

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

const costTracker = {
  maxSessionCostUsd: null,
  visibilityThresholdUsd: 0.05,
  sessionTotal: async () => 0,
  estimateAddCost: () => 0,
  shouldDisplay: () => false,
  guard: async () => {},
  record: async () => ({ costUsd: 0, newSessionTotal: 0 }),
};

const stubRegistry: EnvironmentRegistry = {
  upsert: async () => {
    throw new Error('not implemented');
  },
  remove: async () => false,
  get: async () => null,
  list: async () => [],
  describeForLLM: async () => 'envs: (none)',
};

/**
 * Answers with an UNGROUNDED report (no `[ev-N]`, so verification always
 * fails), but proposes a follow-up when asked as the proposer. The proposer
 * turn is the one carrying tools.
 */
function ungroundedClientThatWantsToDrill(): ModelClient {
  return {
    id: 'stub',
    modelId: 'stub-model',
    isLocal: true,
    capabilities: { streaming: false, toolCalling: true, maxContextTokens: 8000 },
    estimateCost: () => ({ free: true as const }),
    complete: async (req: CompleteRequest) => {
      const isProposer = req.tools !== undefined && req.tools.length > 0;
      return {
        id: 'c',
        model: 'stub-model',
        content: isProposer ? '' : 'The host is broken but I forgot to cite anything.',
        toolCalls: isProposer
          ? [{ id: 't1', name: 'logs.tail', arguments: { environment: 'demo', path: '/var/log/app.log' } }]
          : [],
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1 },
        costUsd: 0,
      };
    },
    stream: async function* () {
      /* streaming disabled */
    },
  } as unknown as ModelClient;
}

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('analyze drills even when the report failed verification', () => {
  test('an ungrounded baseline still reaches the follow-up round', async () => {
    const catalog = createCatalog();
    registerBuiltins(catalog);

    const seen: ProposedStep[][] = [];
    const events = await collect(
      runAnalyze(
        {
          userRequest: 'what is broken',
          sessionId: 's' as SessionId,
          environment: 'demo',
        },
        {
          executor: executor as never,
          client: ungroundedClientThatWantsToDrill(),
          costTracker: costTracker as never,
          catalog,
          registry: stubRegistry,
          maxFollowupIterations: 1,
          approveProposals: async (proposals) => {
            seen.push([...proposals]);
            return { acceptedIndices: proposals.map((_, i) => i), stop: false };
          },
        },
      ),
    );

    expect(events.some((e) => e.type === 'verify-failed')).toBe(true);
    // The whole point: verification failed, and the drill happened anyway.
    expect(seen.length).toBe(1);
    expect(seen[0]?.[0]?.actionName).toBe('logs.tail');
    expect(events.some((e) => e.type === 'proposals-ready')).toBe(true);
  });

  test('the follow-up evidence is gathered and appended', async () => {
    const catalog = createCatalog();
    registerBuiltins(catalog);

    const events = await collect(
      runAnalyze(
        { userRequest: 'what is broken', sessionId: 's' as SessionId, environment: 'demo' },
        {
          executor: executor as never,
          client: ungroundedClientThatWantsToDrill(),
          costTracker: costTracker as never,
          catalog,
          registry: stubRegistry,
          maxFollowupIterations: 1,
          approveProposals: async (proposals) => ({
            acceptedIndices: proposals.map((_, i) => i),
            stop: false,
          }),
        },
      ),
    );

    const drilled = events.filter(
      (e) => e.type === 'gather-step-done' && e.step.actionName === 'logs.tail',
    );
    expect(drilled.length).toBe(1);
  });
});

describe('discovery sweep looks at logs', () => {
  test('the deterministic plan includes log discovery', () => {
    const plan = buildDiscoveryPlan('demo');
    const actions = plan.steps.map((s) => s.actionName);
    expect(actions).toContain('discover.log_files');
  });

  test('every discovery step targets the requested environment', () => {
    const plan = buildDiscoveryPlan('staging');
    for (const step of plan.steps) {
      expect((step.args as { environment?: string }).environment).toBe('staging');
    }
  });
});
