import { describe, expect, test } from 'bun:test';

import { generateSessionTitle } from '../../../src/agent/title.ts';
import type {
  CompleteRequest,
  Completion,
  CompletionChunk,
  ModelClient,
} from '../../../src/models/types.ts';

function makeClient(content: string): ModelClient {
  return {
    id: 'fake-title',
    modelId: 'fake-model',
    isLocal: true,
    capabilities: { toolCalling: false, maxContextTokens: 4096, streaming: false },
    estimateCost: () => ({ free: true }),
    complete: async (_req: CompleteRequest): Promise<Completion> => ({
      id: 'r1',
      model: 'fake',
      content,
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 30, outputTokens: 8 },
      costUsd: 0,
    }),
    stream: async function* (): AsyncIterable<CompletionChunk> {
      return;
    },
  };
}

function makeErrorClient(): ModelClient {
  return {
    id: 'fake-err',
    modelId: 'fake-model',
    isLocal: true,
    capabilities: { toolCalling: false, maxContextTokens: 4096, streaming: false },
    estimateCost: () => ({ free: true }),
    complete: async (): Promise<Completion> => {
      throw new Error('upstream down');
    },
    stream: async function* (): AsyncIterable<CompletionChunk> {
      return;
    },
  };
}

describe('agent/title — generateSessionTitle', () => {
  test('returns the cleaned title for a normal prompt', async () => {
    const t = await generateSessionTitle(
      'verifica memoria e disco su prod-01',
      makeClient('Prod-01 Memory and Disk Audit'),
    );
    expect(t).toBe('Prod-01 Memory and Disk Audit');
  });

  test('strips surrounding quotes', async () => {
    const t = await generateSessionTitle(
      'check uptime',
      makeClient('"Investigate Uptime on Staging"'),
    );
    expect(t).toBe('Investigate Uptime on Staging');
  });

  test('strips a "Title:" prefix', async () => {
    const t = await generateSessionTitle(
      'check uptime',
      makeClient('Title: Investigate Uptime'),
    );
    expect(t).toBe('Investigate Uptime');
  });

  test('returns null on upstream failure', async () => {
    const t = await generateSessionTitle('anything', makeErrorClient());
    expect(t).toBeNull();
  });

  test('returns null for empty prompt', async () => {
    const t = await generateSessionTitle('   ', makeClient('whatever'));
    expect(t).toBeNull();
  });

  test('truncates extreme titles with ellipsis', async () => {
    const long = 'X'.repeat(200);
    const t = await generateSessionTitle('p', makeClient(long));
    expect(t!.endsWith('…')).toBe(true);
    expect(t!.length).toBeLessThanOrEqual(80);
  });
});
