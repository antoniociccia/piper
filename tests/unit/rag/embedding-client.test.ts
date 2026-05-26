import { describe, expect, test } from 'bun:test';

import {
  createOpenAIEmbeddingClient,
  EmbeddingError,
  type FetchLike,
  vectorLiteral,
} from '../../../src/rag/embedding-client.ts';

interface CapturedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function makeFetchMock(handler: (req: CapturedRequest) => Response): {
  fetch: FetchLike;
  captured: CapturedRequest[];
} {
  const captured: CapturedRequest[] = [];
  const fetchImpl: FetchLike = (async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const headersIn = (init?.headers ?? {}) as Record<string, string>;
    const entry: CapturedRequest = {
      url,
      body: rawBody === '' ? {} : (JSON.parse(rawBody) as Record<string, unknown>),
      headers: headersIn,
    };
    captured.push(entry);
    return handler(entry);
  }) as FetchLike;
  return { fetch: fetchImpl, captured };
}

const baseOpts = {
  id: 'ollama/nomic-embed-text',
  baseUrl: 'http://localhost:11434/v1',
  modelId: 'nomic-embed-text',
  dimension: 4,
  isLocal: true,
};

describe('rag/embedding-client', () => {
  test('posts /embeddings with model + single input string', async () => {
    const { fetch, captured } = makeFetchMock(() =>
      jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }),
    );
    const client = createOpenAIEmbeddingClient({ ...baseOpts, fetch });
    const out = await client.embed('hello');
    expect(out).toBeInstanceOf(Float32Array);
    expect(out).toHaveLength(4);
    const arr = Array.from(out);
    expect(arr[0]).toBeCloseTo(0.1, 5);
    expect(arr[1]).toBeCloseTo(0.2, 5);
    expect(arr[2]).toBeCloseTo(0.3, 5);
    expect(arr[3]).toBeCloseTo(0.4, 5);
    expect(captured[0]?.url).toBe('http://localhost:11434/v1/embeddings');
    expect(captured[0]?.body['model']).toBe('nomic-embed-text');
    expect(captured[0]?.body['input']).toBe('hello');
  });

  test('embedBatch sends an array input and returns N vectors', async () => {
    const { fetch, captured } = makeFetchMock(() =>
      jsonResponse({
        data: [
          { embedding: [1, 0, 0, 0] },
          { embedding: [0, 1, 0, 0] },
          { embedding: [0, 0, 1, 0] },
        ],
      }),
    );
    const client = createOpenAIEmbeddingClient({ ...baseOpts, fetch });
    const out = await client.embedBatch(['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    expect(Array.from(out[1] ?? new Float32Array())).toEqual([0, 1, 0, 0]);
    expect(captured[0]?.body['input']).toEqual(['a', 'b', 'c']);
  });

  test('embedBatch on empty input does no HTTP call', async () => {
    const { fetch, captured } = makeFetchMock(() => jsonResponse({ data: [] }));
    const client = createOpenAIEmbeddingClient({ ...baseOpts, fetch });
    const out = await client.embedBatch([]);
    expect(out).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  test('authorization header is added when apiKey is set', async () => {
    const { fetch, captured } = makeFetchMock(() =>
      jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }),
    );
    const client = createOpenAIEmbeddingClient({ ...baseOpts, fetch, apiKey: 'sk-test' });
    await client.embed('x');
    expect(captured[0]?.headers['Authorization']).toBe('Bearer sk-test');
  });

  test('non-2xx response throws EmbeddingError with status + body', async () => {
    const { fetch } = makeFetchMock(() => new Response('upstream busy', { status: 503 }));
    const client = createOpenAIEmbeddingClient({ ...baseOpts, fetch });
    let caught: unknown;
    try {
      await client.embed('x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmbeddingError);
    expect((caught as EmbeddingError).status).toBe(503);
  });

  test('mismatched dimension throws EmbeddingError', async () => {
    const { fetch } = makeFetchMock(() =>
      jsonResponse({ data: [{ embedding: [0.1, 0.2] }] }),
    );
    const client = createOpenAIEmbeddingClient({ ...baseOpts, fetch });
    let caught: unknown;
    try {
      await client.embed('x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EmbeddingError);
    expect((caught as Error).message).toContain('expected 4');
  });

  test('vectorLiteral serializes to postgres `[a,b,c]` form', () => {
    expect(vectorLiteral(Float32Array.from([1, 2.5, -3]))).toBe('[1,2.5,-3]');
  });
});
