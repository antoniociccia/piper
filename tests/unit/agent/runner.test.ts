import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';

import { createAgentRunner } from '../../../src/agent/runner.ts';
import type { AgentEvent } from '../../../src/agent/types.ts';
import { createCatalog } from '../../../src/actions/catalog.ts';
import type { Action } from '../../../src/actions/types.ts';
import { createEnvironmentRegistry } from '../../../src/environments/registry.ts';
import { createExecutor } from '../../../src/exec/executor.ts';
import { closeDb, openDb } from '../../../src/memory/db.ts';
import { createCostTracker } from '../../../src/models/cost.ts';
import type {
  Completion,
  CompletionChunk,
  CompleteRequest,
  ModelClient,
  ToolCall,
} from '../../../src/models/types.ts';

let db: PGlite | null = null;

beforeEach(async () => {
  db = await openDb();
});

afterEach(async () => {
  if (db !== null) {
    await closeDb(db);
    db = null;
  }
});

interface ScriptedResponse {
  readonly content?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

function makeScriptedClient(responses: readonly ScriptedResponse[]): ModelClient {
  let i = 0;
  return {
    id: 'scripted',
    modelId: 'scripted-model',
    isLocal: true,
    capabilities: { toolCalling: true, maxContextTokens: 128_000, streaming: false },
    estimateCost: () => ({ free: true }),
    complete: async (_req: CompleteRequest): Promise<Completion> => {
      const r = responses[i] ?? { content: 'no more scripted responses' };
      i += 1;
      return {
        id: `script-${i}`,
        model: 'mistralai/devstral-small-2-24b',
        content: r.content ?? '',
        toolCalls: r.toolCalls ?? [],
        finishReason: (r.toolCalls?.length ?? 0) > 0 ? 'tool_calls' : 'stop',
        usage: { inputTokens: r.inputTokens ?? 100, outputTokens: r.outputTokens ?? 50 },
        costUsd: 0,
      };
    },
    // eslint-disable-next-line require-yield
    stream: async function* (): AsyncIterable<CompletionChunk> {
      return;
    },
  };
}

const fakeAction: Action<{ environment: string; tag: string }, string> = {
  name: 'fake.run',
  tier: 'read',
  description: 'echoes a tag on the remote env',
  argsSchema: z.object({ environment: z.string(), tag: z.string() }),
  buildCommand: (args, ctx) => {
    if (ctx.environment === undefined) throw new Error('no env in ctx');
    return ['echo', `${ctx.environment.sshUser}@${ctx.environment.host}:${args.tag}`];
  },
  parseResult: (raw) => raw.stdout,
};

async function setup() {
  if (db === null) throw new Error('db not open');
  const catalog = createCatalog();
  catalog.register(fakeAction);
  const registry = createEnvironmentRegistry(db);
  await registry.upsert({ name: 'loop', host: '127.0.0.1', sshUser: 'me', description: 'demo' });
  const executor = createExecutor({ db, catalog, registry });
  const costTracker = createCostTracker({ db });
  const sessionId = `agent-${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`,
    [sessionId, JSON.stringify({})],
  );
  return { catalog, registry, executor, costTracker, sessionId };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('agent/runner — happy path', () => {
  test('plan → gather → synthesize → verify (clean) emits expected event sequence', async () => {
    const { catalog, registry, executor, costTracker, sessionId } = await setup();
    const client = makeScriptedClient([
      // planner emits one tool call
      {
        toolCalls: [
          { id: 'c1', name: 'fake.run', arguments: { environment: 'loop', tag: 'hello' } },
        ],
      },
      // synthesizer produces a grounded report
      {
        content:
          '# Status\nThe fake action returned hello from the remote host [ev-1].\n',
      },
    ]);
    const runner = createAgentRunner({
      catalog,
      registry,
      executor,
      client,
      costTracker,
    });

    const events = await collect(runner.run({ userRequest: 'do the fake thing on loop', sessionId }));
    const types = events.map((e) => e.type);
    expect(types).toContain('session-started');
    expect(types).toContain('plan-ready');
    expect(types).toContain('gather-step-started');
    expect(types).toContain('gather-step-done');
    expect(types).toContain('synthesize-ready');
    expect(types).toContain('verify-passed');
    expect(types[types.length - 1]).toBe('done');

    const done = events[events.length - 1];
    if (done?.type !== 'done') throw new Error('expected done event last');
    expect(done.result.evidence).toHaveLength(1);
    expect(done.result.verification?.ok).toBe(true);
    expect(done.result.reportMarkdown).toContain('[ev-1]');
    expect(done.result.aborted).toBe(false);
  });
});

describe('agent/runner — failure paths', () => {
  test('planner produces no tool calls → surfaces assistant content as a direct reply', async () => {
    const { catalog, registry, executor, costTracker, sessionId } = await setup();
    const client = makeScriptedClient([{ content: 'sorry I cannot help with that' }]);
    const runner = createAgentRunner({ catalog, registry, executor, client, costTracker });
    const events = await collect(runner.run({ userRequest: 'x', sessionId }));
    // No abort — the model's content is shown as a one-shot reply through the
    // synthesize-ready event so the chat UI commits it like a normal answer.
    expect(events.find((e) => e.type === 'aborted')).toBeUndefined();
    const ready = events.find((e) => e.type === 'synthesize-ready');
    expect(ready).toBeDefined();
    if (ready?.type === 'synthesize-ready') {
      expect(ready.reportMarkdown).toContain('sorry I cannot help');
    }
  });

  test('verify failure retries synthesize, then surfaces an ungrounded report', async () => {
    const { catalog, registry, executor, costTracker, sessionId } = await setup();
    const client = makeScriptedClient([
      // planner
      {
        toolCalls: [{ id: 'c1', name: 'fake.run', arguments: { environment: 'loop', tag: 'h' } }],
      },
      // synthesize attempt 1 — uncited substantive line
      { content: 'The server is completely on fire and requires immediate intervention.' },
      // synthesize attempt 2 — still uncited
      { content: 'No grounding here either, the server might be on fire.' },
    ]);
    const runner = createAgentRunner({
      catalog,
      registry,
      executor,
      client,
      costTracker,
      maxSynthesizeRetries: 1,
    });
    const events = await collect(runner.run({ userRequest: 'is it on fire', sessionId }));
    const verifyFails = events.filter((e) => e.type === 'verify-failed');
    expect(verifyFails.length).toBeGreaterThanOrEqual(1);
    const done = events[events.length - 1];
    if (done?.type !== 'done') throw new Error('expected done event last');
    expect(done.result.verification?.ok).toBe(false);
  });

  test('all gather steps fail → aborted with gather-empty reason', async () => {
    const { catalog, registry, executor, costTracker, sessionId } = await setup();
    const client = makeScriptedClient([
      {
        toolCalls: [
          { id: 'c1', name: 'fake.run', arguments: { environment: 'ghost', tag: 'h' } },
        ],
      },
    ]);
    const runner = createAgentRunner({ catalog, registry, executor, client, costTracker });
    const events = await collect(runner.run({ userRequest: 'do something', sessionId }));
    const aborted = events.find((e) => e.type === 'aborted');
    expect(aborted).toBeDefined();
    if (aborted?.type === 'aborted') {
      expect(aborted.reason).toContain('gather-empty');
    }
  });
});

describe('agent/runner — cost accounting', () => {
  test('costUsd accumulates from planner and synthesizer (zero for local mocks)', async () => {
    const { catalog, registry, executor, costTracker, sessionId } = await setup();
    const client = makeScriptedClient([
      {
        toolCalls: [{ id: 'c1', name: 'fake.run', arguments: { environment: 'loop', tag: 'h' } }],
      },
      { content: 'OK [ev-1]\n' },
    ]);
    const runner = createAgentRunner({ catalog, registry, executor, client, costTracker });
    const events = await collect(runner.run({ userRequest: 'go', sessionId }));
    const done = events[events.length - 1];
    if (done?.type !== 'done') throw new Error('expected done event last');
    expect(done.result.costUsd).toBe(0);
  });
});

describe('agent/runner — follow-up proposals', () => {
  test('synth+propose → callback accepts → re-gather → re-synth+propose', async () => {
    const { catalog, registry, executor, costTracker, sessionId } = await setup();
    // Now each iteration: PLAN, then SYNTH (report only), then PROPOSE (proposals only).
    const client = makeScriptedClient([
      // plan
      { toolCalls: [{ id: 'c1', name: 'fake.run', arguments: { environment: 'loop', tag: 'A' } }] },
      // synth #1 — report only
      { content: 'Initial findings: action A returned A from the loop host [ev-1].' },
      // propose #1 — tool_calls only
      { toolCalls: [{ id: 'p1', name: 'fake.run', arguments: { environment: 'loop', tag: 'B' } }] },
      // synth #2 — second report after follow-up gather
      { content: 'Updated findings: action A [ev-1] and follow-up B [ev-2] both returned cleanly.' },
      // propose #2 — no further proposals → ends loop
      { content: '' },
    ]);

    const decisions: Array<{ count: number; iter: number }> = [];
    const runner = createAgentRunner({
      catalog,
      registry,
      executor,
      client,
      costTracker,
      maxFollowupIterations: 2,
      approveProposals: async (proposals, iter) => {
        decisions.push({ count: proposals.length, iter });
        return { acceptedIndices: proposals.map((_, i) => i), stop: false };
      },
    });
    const events = await collect(runner.run({ userRequest: 'go', sessionId }));
    const types = events.map((e) => e.type);
    expect(types).toContain('proposals-ready');
    expect(types.filter((t) => t === 'synthesize-ready')).toHaveLength(2);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.iter).toBe(1);

    const done = events[events.length - 1];
    if (done?.type !== 'done') throw new Error('expected done event last');
    expect(done.result.evidence).toHaveLength(2);
    expect(done.result.evidence[0]?.id).toBe('ev-1');
    expect(done.result.evidence[1]?.id).toBe('ev-2');
  });

  test('callback declines (stop:true) → no follow-up gather, done immediately', async () => {
    const { catalog, registry, executor, costTracker, sessionId } = await setup();
    const client = makeScriptedClient([
      // plan
      { toolCalls: [{ id: 'c1', name: 'fake.run', arguments: { environment: 'loop', tag: 'A' } }] },
      // synth (report only)
      { content: 'Initial findings [ev-1].' },
      // propose (tool_calls)
      { toolCalls: [{ id: 'p1', name: 'fake.run', arguments: { environment: 'loop', tag: 'B' } }] },
    ]);
    const runner = createAgentRunner({
      catalog,
      registry,
      executor,
      client,
      costTracker,
      maxFollowupIterations: 2,
      approveProposals: async () => ({ acceptedIndices: [], stop: true }),
    });
    const events = await collect(runner.run({ userRequest: 'go', sessionId }));
    const types = events.map((e) => e.type);
    expect(types).toContain('proposals-ready');
    expect(types).toContain('proposals-declined');
    expect(types.filter((t) => t === 'synthesize-ready')).toHaveLength(1);
  });

  test('no callback wired → proposer not called, single synth, done', async () => {
    const { catalog, registry, executor, costTracker, sessionId } = await setup();
    const client = makeScriptedClient([
      { toolCalls: [{ id: 'c1', name: 'fake.run', arguments: { environment: 'loop', tag: 'A' } }] },
      { content: 'Initial findings [ev-1].' },
    ]);
    const runner = createAgentRunner({ catalog, registry, executor, client, costTracker });
    const events = await collect(runner.run({ userRequest: 'go', sessionId }));
    const types = events.map((e) => e.type);
    expect(types).not.toContain('proposals-ready');
    expect(types.filter((t) => t === 'synthesize-ready')).toHaveLength(1);
  });

  test('proposer returns zero tool_calls → no proposals event, normal done', async () => {
    const { catalog, registry, executor, costTracker, sessionId } = await setup();
    const client = makeScriptedClient([
      { toolCalls: [{ id: 'c1', name: 'fake.run', arguments: { environment: 'loop', tag: 'A' } }] },
      { content: 'Final findings [ev-1].' },
      { content: '' /* propose: nothing to add */ },
    ]);
    const runner = createAgentRunner({
      catalog,
      registry,
      executor,
      client,
      costTracker,
      approveProposals: async () => ({ acceptedIndices: [], stop: false }),
    });
    const events = await collect(runner.run({ userRequest: 'go', sessionId }));
    const types = events.map((e) => e.type);
    expect(types).not.toContain('proposals-ready');
    expect(types.filter((t) => t === 'synthesize-ready')).toHaveLength(1);
  });
});

describe('agent/runner — approveSteps (HUMAN mode bridge)', () => {
  test('approveSteps callback fires with the planned proposals before gather', async () => {
    const { catalog, registry, executor, costTracker, sessionId } = await setup();
    const client = makeScriptedClient([
      { toolCalls: [{ id: 'c1', name: 'fake.run', arguments: { environment: 'loop', tag: 'hi' } }] },
      { content: '# Done\nThe fake said hello [ev-1].\n' },
    ]);

    let approveCalls = 0;
    const runner = createAgentRunner({
      catalog,
      registry,
      executor,
      client,
      costTracker,
      approveSteps: async (proposals) => {
        approveCalls += 1;
        expect(proposals.length).toBe(1);
        return { acceptedIndices: [0], stop: false };
      },
    });
    const events = await collect(runner.run({ userRequest: 'do it', sessionId }));
    expect(approveCalls).toBe(1);
    const types = events.map((e) => e.type);
    expect(types).toContain('plan-ready');
    expect(types).toContain('gather-step-done');
    expect(types[types.length - 1]).toBe('done');
  });

  test('declined initial plan → aborts with no gather', async () => {
    const { catalog, registry, executor, costTracker, sessionId } = await setup();
    const client = makeScriptedClient([
      { toolCalls: [{ id: 'c1', name: 'fake.run', arguments: { environment: 'loop', tag: 'hi' } }] },
    ]);
    const runner = createAgentRunner({
      catalog,
      registry,
      executor,
      client,
      costTracker,
      approveSteps: async () => ({ acceptedIndices: [], stop: true }),
    });
    const events = await collect(runner.run({ userRequest: 'do it', sessionId }));
    const types = events.map((e) => e.type);
    expect(types).toContain('proposals-declined');
    expect(types).toContain('aborted');
    expect(types).not.toContain('gather-step-done');
    expect(types[types.length - 1]).toBe('done');
    const done = events[events.length - 1];
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.result.aborted).toBe(true);
  });

  test('no approveSteps → backward compatible: gather runs automatically', async () => {
    const { catalog, registry, executor, costTracker, sessionId } = await setup();
    const client = makeScriptedClient([
      { toolCalls: [{ id: 'c1', name: 'fake.run', arguments: { environment: 'loop', tag: 'hi' } }] },
      { content: '# Done\nReply [ev-1].\n' },
    ]);
    const runner = createAgentRunner({ catalog, registry, executor, client, costTracker });
    const events = await collect(runner.run({ userRequest: 'do it', sessionId }));
    const types = events.map((e) => e.type);
    expect(types).toContain('gather-step-done');
    expect(types[types.length - 1]).toBe('done');
  });
});
