import { describe, expect, test } from 'bun:test';

import { createOpenAIChatClient, stripReasoning } from '../../../src/models/client.ts';

/**
 * Reasoning ("thinking") models are the norm for the small local weights PIPER
 * is meant to run on, and they break the OpenAI response contract in two ways
 * that both end with PIPER holding an empty string:
 *
 *   1. Ollama returns the whole answer in a non-standard `reasoning` field and
 *      leaves `content` EMPTY. PIPER reads `content`, sees nothing, and the
 *      verifier reports "synthesizer failed to ground" — blaming the model for
 *      an answer it did produce. Measured with qwen3.5:4b on ollama 0.18.2.
 *   2. With reasoning turned off, the chat template can still emit a stray
 *      `</think>` into `content`, so the text arrives with a thinking preamble
 *      glued to the front. Measured with qwen3.5:9b.
 *
 * `reasoning_effort: "none"` is the knob that works — ollama honours it,
 * llama.cpp accepts it, `think: false` and `enable_thinking: false` are both
 * ignored.
 */

describe('stripReasoning', () => {
  test('removes a complete think block', () => {
    expect(stripReasoning('<think>weighing options</think>the answer')).toBe('the answer');
  });

  test('removes a think block spanning newlines', () => {
    expect(stripReasoning('<think>\nstep 1\nstep 2\n</think>\n\nDisk is at 38% [ev-1]')).toBe(
      'Disk is at 38% [ev-1]',
    );
  });

  test('drops the preamble before an orphan closing tag', () => {
    // qwen3.5:9b via ollama with reasoning_effort=none produces exactly this.
    expect(stripReasoning('hello ev-1\n</think>\n\nhello [ev-1]')).toBe('hello [ev-1]');
  });

  test('leaves ordinary content untouched', () => {
    const report = 'Uptime is 14 days [ev-1]. Memory has headroom [ev-2].';
    expect(stripReasoning(report)).toBe(report);
  });

  test('leaves content untouched when the tag is only mentioned mid-sentence', () => {
    const report = 'The log line contained a literal </think> token [ev-1].';
    expect(stripReasoning(report)).toBe(report);
  });

  test('returns an empty string when the model produced only thinking', () => {
    expect(stripReasoning('<think>still deciding</think>')).toBe('');
  });
});

describe('reasoning-only responses are recovered, not silently dropped', () => {
  function clientWith(body: unknown) {
    return createOpenAIChatClient({
      id: 'test/local',
      baseUrl: 'http://localhost:1/v1',
      defaultModel: 'qwen3.5:4b',
      capabilities: { toolCalling: true, maxContextTokens: 32000, streaming: true },
      isLocal: true,
      reasoningEffort: 'none',
      fetch: async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
  }

  test('content is used when present', async () => {
    const client = clientWith({
      choices: [{ message: { role: 'assistant', content: 'Disk at 38% [ev-1]' } }],
    });
    const out = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(out.content).toBe('Disk at 38% [ev-1]');
  });

  test('a think block leaking into content is stripped', async () => {
    const client = clientWith({
      choices: [
        { message: { role: 'assistant', content: '<think>hmm</think>Disk at 38% [ev-1]' } },
      ],
    });
    const out = await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(out.content).toBe('Disk at 38% [ev-1]');
  });

  test('an empty content with a truncated reasoning field reports the real cause', async () => {
    const client = clientWith({
      choices: [
        {
          finish_reason: 'length',
          message: { role: 'assistant', content: '', reasoning: 'Thinking Process:\n1. ...' },
        },
      ],
    });
    await expect(
      client.complete({ messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/reasoning/i);
  });
});

describe('reasoning_effort is sent when configured', () => {
  test('the request body carries reasoning_effort', async () => {
    let sent: Record<string, unknown> = {};
    const client = createOpenAIChatClient({
      id: 'test/local',
      baseUrl: 'http://localhost:1/v1',
      defaultModel: 'qwen3.5:4b',
      capabilities: { toolCalling: true, maxContextTokens: 32000, streaming: true },
      isLocal: true,
      reasoningEffort: 'none',
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(sent['reasoning_effort']).toBe('none');
  });

  test('the field is omitted when not configured', async () => {
    let sent: Record<string, unknown> = {};
    const client = createOpenAIChatClient({
      id: 'test/remote',
      baseUrl: 'http://localhost:1/v1',
      defaultModel: 'gpt-x',
      capabilities: { toolCalling: true, maxContextTokens: 32000, streaming: true },
      isLocal: false,
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    await client.complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect('reasoning_effort' in sent).toBe(false);
  });
});
