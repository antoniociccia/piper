import { describe, expect, test } from 'bun:test';

import {
  ModelPullError,
  pullOllamaModel,
  toOllamaRoot,
  type PullProgress,
} from '../../../src/config/model-pull.ts';

/** Serves a list of NDJSON lines the way Ollama streams them. */
function streamOf(lines: readonly string[], chunkSize = 9999): typeof fetch {
  const body = lines.join('\n') + '\n';
  return (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const bytes = new TextEncoder().encode(body);
          for (let i = 0; i < bytes.length; i += chunkSize) {
            controller.enqueue(bytes.slice(i, i + chunkSize));
          }
          controller.close();
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
}

describe('toOllamaRoot', () => {
  test('drops the /v1 the chat API needs and the management API does not', () => {
    expect(toOllamaRoot('http://localhost:11434/v1')).toBe('http://localhost:11434');
    expect(toOllamaRoot('http://localhost:11434/v1/')).toBe('http://localhost:11434');
    expect(toOllamaRoot('http://localhost:11434')).toBe('http://localhost:11434');
  });

  test('leaves a path that merely contains v1 alone', () => {
    expect(toOllamaRoot('http://host/v1/proxy')).toBe('http://host/v1/proxy');
  });
});

describe('pullOllamaModel', () => {
  test('reports progress and resolves on success', async () => {
    const seen: PullProgress[] = [];
    await pullOllamaModel({
      baseUrl: 'http://localhost:11434/v1',
      tag: 'qwen3.5:4b',
      onProgress: (p) => seen.push(p),
      fetch: streamOf([
        '{"status":"pulling manifest"}',
        '{"status":"pulling abc","total":100,"completed":25}',
        '{"status":"pulling abc","total":100,"completed":100}',
        '{"status":"success"}',
      ]),
    });

    expect(seen.length).toBe(4);
    expect(seen[0]?.fraction).toBeNull();
    expect(seen[1]?.fraction).toBeCloseTo(0.25);
    expect(seen[2]?.fraction).toBeCloseTo(1);
  });

  test('a line split across chunks is not lost or double-counted', async () => {
    const seen: PullProgress[] = [];
    await pullOllamaModel({
      baseUrl: 'http://localhost:11434/v1',
      tag: 'qwen3.5:4b',
      onProgress: (p) => seen.push(p),
      // One byte at a time: every line arrives in fragments.
      fetch: streamOf(
        ['{"status":"pulling manifest"}', '{"status":"pulling x","total":8,"completed":4}', '{"status":"success"}'],
        1,
      ),
    });
    expect(seen.length).toBe(3);
    expect(seen[1]?.fraction).toBeCloseTo(0.5);
  });

  test("surfaces Ollama's own error rather than a generic failure", async () => {
    await expect(
      pullOllamaModel({
        baseUrl: 'http://localhost:11434/v1',
        tag: 'nope:1b',
        fetch: streamOf(['{"error":"model \'nope:1b\' not found"}']),
      }),
    ).rejects.toThrow(/not found/);
  });

  test('a stream that stops before success is a failure, not a silent no-op', async () => {
    await expect(
      pullOllamaModel({
        baseUrl: 'http://localhost:11434/v1',
        tag: 'qwen3.5:4b',
        fetch: streamOf(['{"status":"pulling manifest"}']),
      }),
    ).rejects.toThrow(ModelPullError);
  });

  test('an unreachable daemon names the URL it tried', async () => {
    await expect(
      pullOllamaModel({
        baseUrl: 'http://localhost:11434/v1',
        tag: 'qwen3.5:4b',
        fetch: (async () => {
          throw new Error('connection refused');
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/localhost:11434\/api\/pull/);
  });

  test('an HTTP error is reported with its status', async () => {
    await expect(
      pullOllamaModel({
        baseUrl: 'http://localhost:11434/v1',
        tag: 'qwen3.5:4b',
        fetch: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/500/);
  });
});
