/**
 * Downloads a model into a local runtime, so a first run can finish without
 * sending the user off to another terminal.
 *
 * Only Ollama is supported: it is the one local provider with an HTTP pull API.
 * LM Studio, llama.cpp and vLLM all expect the weights to already be on disk,
 * and PIPER says so rather than pretending otherwise.
 */

export interface PullProgress {
  /** Ollama's own status line, e.g. "pulling manifest", "verifying sha256". */
  readonly status: string;
  readonly completedBytes: number;
  readonly totalBytes: number;
  /** 0..1, or null while the download has no known total yet. */
  readonly fraction: number | null;
}

export interface PullOptions {
  /** The provider base URL as PIPER stores it, `/v1` suffix and all. */
  readonly baseUrl: string;
  readonly tag: string;
  readonly onProgress?: (p: PullProgress) => void;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
}

export class ModelPullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelPullError';
  }
}

/**
 * Ollama serves the OpenAI-compatible surface under `/v1` but keeps its own
 * management API at the root, so the `/v1` we store for chat has to come off.
 */
export function toOllamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
}

interface PullLine {
  readonly status?: string;
  readonly error?: string;
  readonly total?: number;
  readonly completed?: number;
}

/**
 * Streams `POST /api/pull`. Resolves once Ollama reports success; rejects with
 * the server's own message otherwise, because "pull failed" on its own gives
 * the user nothing to act on.
 */
export async function pullOllamaModel(opts: PullOptions): Promise<void> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = `${toOllamaRoot(opts.baseUrl)}/api/pull`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: opts.tag, stream: true }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
  } catch (err) {
    throw new ModelPullError(
      `could not reach Ollama at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    throw new ModelPullError(`Ollama refused the pull (HTTP ${response.status})`);
  }
  if (response.body === null) {
    throw new ModelPullError('Ollama returned no response body for the pull');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawSuccess = false;

  const handle = (raw: string): void => {
    const line = raw.trim();
    if (line === '') return;

    let parsed: PullLine;
    try {
      parsed = JSON.parse(line) as PullLine;
    } catch {
      return; // a partial line; the next chunk completes it
    }

    if (parsed.error !== undefined && parsed.error !== '') {
      throw new ModelPullError(parsed.error);
    }

    const total = parsed.total ?? 0;
    const completed = parsed.completed ?? 0;
    opts.onProgress?.({
      status: parsed.status ?? '',
      completedBytes: completed,
      totalBytes: total,
      fraction: total > 0 ? Math.min(1, completed / total) : null,
    });

    if (parsed.status === 'success') sawSuccess = true;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // The last element is whatever came after the final newline — hold it back.
    buffer = lines.pop() ?? '';
    for (const line of lines) handle(line);
  }
  handle(buffer);

  if (!sawSuccess) {
    throw new ModelPullError('the download ended before Ollama reported success');
  }
}
