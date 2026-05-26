export type FetchLike = typeof fetch;

export interface EmbeddingClient {
  readonly id: string;
  readonly modelId: string;
  readonly dimension: number;
  readonly isLocal: boolean;
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: readonly string[]): Promise<Float32Array[]>;
}

export interface OpenAIEmbeddingClientOptions {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly modelId: string;
  readonly dimension: number;
  readonly isLocal: boolean;
  readonly fetch?: FetchLike;
  readonly headers?: Readonly<Record<string, string>>;
}

interface OpenAIEmbeddingResponse {
  readonly data?: ReadonlyArray<{ readonly embedding?: ReadonlyArray<number> }>;
}

export class EmbeddingError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'EmbeddingError';
    this.status = status;
    this.body = body;
  }
}

/**
 * OpenAI-compatible embeddings client. Works against Ollama (preferred default
 * for local), llama.cpp server, vLLM, OpenAI direct, and similar.
 *
 * Endpoint: POST <baseUrl>/embeddings
 * Body: { model, input: string | string[] }
 * Response: { data: [{ embedding: number[] }, ...] }
 */
export function createOpenAIEmbeddingClient(
  opts: OpenAIEmbeddingClientOptions,
): EmbeddingClient {
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    };
    if (opts.apiKey !== undefined && opts.apiKey !== '') {
      h['Authorization'] = `Bearer ${opts.apiKey}`;
    }
    return h;
  }

  async function call(input: readonly string[]): Promise<Float32Array[]> {
    const url = `${opts.baseUrl.replace(/\/+$/, '')}/embeddings`;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: opts.modelId,
        input: input.length === 1 ? input[0] : [...input],
      }),
    });
    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch {
        /* ignore */
      }
      throw new EmbeddingError(
        `${opts.id} embeddings HTTP ${response.status}`,
        response.status,
        body,
      );
    }
    const json = (await response.json()) as OpenAIEmbeddingResponse;
    const data = json.data;
    if (data === undefined) {
      throw new EmbeddingError(`${opts.id} embeddings returned no data`, response.status);
    }
    return data.map((item) => {
      const e = item.embedding ?? [];
      if (e.length !== opts.dimension) {
        throw new EmbeddingError(
          `${opts.id} returned ${e.length}-dim vector, expected ${opts.dimension}`,
        );
      }
      return Float32Array.from(e);
    });
  }

  return {
    id: opts.id,
    modelId: opts.modelId,
    dimension: opts.dimension,
    isLocal: opts.isLocal,
    async embed(text: string): Promise<Float32Array> {
      const out = await call([text]);
      const first = out[0];
      if (first === undefined) {
        throw new EmbeddingError(`${opts.id} returned no embedding`);
      }
      return first;
    },
    async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      return call(texts);
    },
  };
}

/**
 * Serialize a Float32Array to the postgres vector literal `[a,b,c,...]`.
 * Used when binding to a `vector(N)` column with `$N::vector`.
 */
export function vectorLiteral(v: Float32Array): string {
  const parts: string[] = new Array(v.length);
  for (let i = 0; i < v.length; i += 1) {
    parts[i] = String(v[i]);
  }
  return `[${parts.join(',')}]`;
}
