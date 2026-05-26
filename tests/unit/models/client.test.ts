import { describe, expect, test } from 'bun:test';

import {
  createOpenAIChatClient,
  ModelClientError,
  type FetchLike,
} from '../../../src/models/client.ts';
import type { CompleteRequest } from '../../../src/models/types.ts';

interface CapturedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetchMock(handler: (req: CapturedRequest) => Response): {
  fetch: FetchLike;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl: FetchLike = (async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const rawBody =
      typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body as ArrayBuffer);
    const headersIn = (init?.headers ?? {}) as Record<string, string>;
    const captureEntry: CapturedRequest = {
      url,
      body: JSON.parse(rawBody === '' ? '{}' : rawBody) as Record<string, unknown>,
      headers: headersIn,
    };
    captured.push(captureEntry);
    return handler(captureEntry);
  }) as FetchLike;
  return { fetch: fetchImpl, captured };
}

function makeStreamResponse(lines: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const baseClientOptions = {
  id: 'test/sonnet',
  baseUrl: 'https://example.test/api/v1',
  apiKey: 'test-key',
  defaultModel: '~anthropic/claude-sonnet-latest',
  capabilities: { toolCalling: true, maxContextTokens: 200_000, streaming: true },
  isLocal: false,
};

const helloReq: CompleteRequest = {
  messages: [{ role: 'user', content: 'hello' }],
};

describe('models/client — request shape', () => {
  test('hits POST /chat/completions on the base URL', async () => {
    const { fetch, captured } = makeFetchMock(() =>
      jsonResponse({
        id: 'a',
        model: 'm',
        choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const client = createOpenAIChatClient({ ...baseClientOptions, fetch });
    await client.complete(helloReq);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://example.test/api/v1/chat/completions');
  });

  test('Authorization: Bearer header carries the API key', async () => {
    const { fetch, captured } = makeFetchMock(() =>
      jsonResponse({
        id: 'a',
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    const client = createOpenAIChatClient({ ...baseClientOptions, fetch });
    await client.complete(helloReq);
    expect(captured[0]?.headers['Authorization']).toBe('Bearer test-key');
  });

  test('uses defaultModel when req.model is undefined', async () => {
    const { fetch, captured } = makeFetchMock(() =>
      jsonResponse({
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    );
    const client = createOpenAIChatClient({ ...baseClientOptions, fetch });
    await client.complete(helloReq);
    expect(captured[0]?.body['model']).toBe('~anthropic/claude-sonnet-latest');
  });

  test('uses req.model when supplied (overrides default)', async () => {
    const { fetch, captured } = makeFetchMock(() =>
      jsonResponse({
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    );
    const client = createOpenAIChatClient({ ...baseClientOptions, fetch });
    await client.complete({ ...helloReq, model: 'openai/gpt-5.5' });
    expect(captured[0]?.body['model']).toBe('openai/gpt-5.5');
  });
});

describe('models/client — privacy and scrubbing', () => {
  test('enforcePrivacyDeny adds provider.data_collection=deny to body', async () => {
    const { fetch, captured } = makeFetchMock(() =>
      jsonResponse({
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    );
    const client = createOpenAIChatClient({ ...baseClientOptions, fetch, enforcePrivacyDeny: true });
    await client.complete(helloReq);
    const provider = captured[0]?.body['provider'] as { data_collection: string } | undefined;
    expect(provider?.data_collection).toBe('deny');
  });

  test('enforcePrivacyDeny is omitted when not set', async () => {
    const { fetch, captured } = makeFetchMock(() =>
      jsonResponse({
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    );
    const client = createOpenAIChatClient({ ...baseClientOptions, fetch });
    await client.complete(helloReq);
    expect(captured[0]?.body['provider']).toBeUndefined();
  });

  test('message contents are scrubbed before sending to the provider', async () => {
    const { fetch, captured } = makeFetchMock(() =>
      jsonResponse({
        choices: [{ message: { content: 'x' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0 },
      }),
    );
    const client = createOpenAIChatClient({ ...baseClientOptions, fetch });
    await client.complete({
      messages: [
        { role: 'user', content: 'my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA do not share' },
      ],
    });
    const messages = captured[0]?.body['messages'] as Array<{ content: string }>;
    expect(messages[0]?.content).not.toContain('sk-ant-api03');
    expect(messages[0]?.content).toContain('[REDACTED:anthropic-key]');
  });
});

describe('models/client — response parsing', () => {
  test('parses content + finish_reason + usage + cost', async () => {
    const { fetch } = makeFetchMock(() =>
      jsonResponse({
        id: 'resp-1',
        model: '~anthropic/claude-sonnet-latest',
        choices: [{ message: { role: 'assistant', content: 'hello back' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      }),
    );
    const client = createOpenAIChatClient({ ...baseClientOptions, fetch });
    const result = await client.complete(helloReq);
    expect(result.content).toBe('hello back');
    expect(result.finishReason).toBe('stop');
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.usage.outputTokens).toBe(500);
    // Sonnet: 3$/M in + 15$/M out → 1000 * 3e-6 + 500 * 15e-6 = 0.003 + 0.0075 = 0.0105
    expect(result.costUsd).toBeCloseTo(0.0105, 6);
  });

  test('parses tool calls into structured ToolCall[]', async () => {
    const { fetch } = makeFetchMock(() =>
      jsonResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_42',
                  type: 'function',
                  function: {
                    name: 'system.uptime',
                    arguments: JSON.stringify({ environment: 'prod' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const client = createOpenAIChatClient({ ...baseClientOptions, fetch });
    const result = await client.complete(helloReq);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.id).toBe('call_42');
    expect(result.toolCalls[0]?.name).toBe('system.uptime');
    expect(result.toolCalls[0]?.arguments).toEqual({ environment: 'prod' });
    expect(result.finishReason).toBe('tool_calls');
  });

  test('non-2xx response throws ModelClientError with status + body', async () => {
    const { fetch } = makeFetchMock(() => new Response('rate-limited', { status: 429 }));
    const client = createOpenAIChatClient({ ...baseClientOptions, fetch });
    await expect(client.complete(helloReq)).rejects.toBeInstanceOf(ModelClientError);
  });
});

describe('models/client — streaming', () => {
  test('SSE chunks yield content deltas, terminate on [DONE]', async () => {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'hel' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}`,
      'data: [DONE]',
    ];
    const fetchImpl: FetchLike = (async () => makeStreamResponse(lines)) as FetchLike;
    const client = createOpenAIChatClient({ ...baseClientOptions, fetch: fetchImpl });

    const chunks: string[] = [];
    let finish: string | undefined;
    let usageIn: number | undefined;
    for await (const chunk of client.stream(helloReq)) {
      if (chunk.contentDelta !== undefined) chunks.push(chunk.contentDelta);
      if (chunk.finishReason !== undefined) finish = chunk.finishReason;
      if (chunk.usage !== undefined) usageIn = chunk.usage.inputTokens;
    }
    expect(chunks.join('')).toBe('hello');
    expect(finish).toBe('stop');
    expect(usageIn).toBe(4);
  });
});

describe('models/client — cost estimate', () => {
  test('returns {free:true} for local models', () => {
    const client = createOpenAIChatClient({
      ...baseClientOptions,
      isLocal: true,
      defaultModel: 'mistralai/devstral-small-2-24b',
    });
    const est = client.estimateCost({ messages: [{ role: 'user', content: 'hi' }] });
    expect(est).toEqual({ free: true });
  });

  test('returns a [min,max] band for remote models with priced output', () => {
    const client = createOpenAIChatClient({ ...baseClientOptions });
    const est = client.estimateCost({
      messages: [{ role: 'user', content: 'x'.repeat(4000) }],
      maxTokens: 500,
    });
    if (est.free !== false) throw new Error('expected priced estimate');
    expect(est.maxUsd).toBeGreaterThan(est.minUsd);
    expect(est.minUsd).toBeGreaterThan(0);
  });
});
