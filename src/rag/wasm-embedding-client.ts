import { homedir } from 'node:os';
import { join } from 'node:path';

import type { EmbeddingClient } from './embedding-client.ts';

/**
 * Default Hugging Face model for WASM-mode embeddings. multilingual-e5-small
 * gives us ~120 MB int8 + 94 languages. The wrapper is provider-agnostic — you
 * can override the modelId via opts.
 */
export const DEFAULT_WASM_MODEL_ID = 'Xenova/multilingual-e5-small';
export const DEFAULT_WASM_DIMENSION = 384;

export interface WasmEmbeddingClientOptions {
  readonly modelId?: string;
  readonly dimension?: number;
  /** Where to cache the downloaded ONNX. Default: ~/.piper/cache/models */
  readonly cacheDir?: string;
  readonly onProgress?: (progress: WasmEmbeddingProgress) => void;
}

export interface WasmEmbeddingProgress {
  readonly status: 'downloading' | 'loading' | 'ready';
  readonly file?: string;
  readonly loaded?: number;
  readonly total?: number;
}

interface HFExtractor {
  (text: string | readonly string[], opts: { pooling: 'mean'; normalize: true }): Promise<{
    readonly data: Float32Array;
    readonly dims: readonly number[];
  }>;
}

interface HFEnv {
  cacheDir: string;
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
}

interface HFModule {
  pipeline: (
    task: string,
    modelId: string,
    options?: {
      dtype?: string;
      progress_callback?: (progress: unknown) => void;
    },
  ) => Promise<HFExtractor>;
  env: HFEnv;
}

/**
 * In-process embedding client backed by Hugging Face transformers.js (ONNX in
 * WASM). First call downloads the model to the cache dir; subsequent calls are
 * offline. Single binary friendly: no native modules, no daemon.
 */
export async function createWasmEmbeddingClient(
  opts: WasmEmbeddingClientOptions = {},
): Promise<EmbeddingClient> {
  const modelId = opts.modelId ?? DEFAULT_WASM_MODEL_ID;
  const dimension = opts.dimension ?? DEFAULT_WASM_DIMENSION;
  const cacheDir = opts.cacheDir ?? join(homedir(), '.piper', 'cache', 'models');

  // Lazy-load the heavy library so importing this module is cheap when WASM
  // mode isn't actually used.
  const mod = (await import('@huggingface/transformers')) as unknown as HFModule;
  mod.env.cacheDir = cacheDir;
  mod.env.allowRemoteModels = true;
  mod.env.allowLocalModels = true;

  const extractor = await mod.pipeline('feature-extraction', modelId, {
    dtype: 'q8',
    progress_callback: (raw: unknown) => {
      if (opts.onProgress === undefined) return;
      const p = raw as { status?: string; file?: string; loaded?: number; total?: number };
      if (typeof p.status !== 'string') return;
      if (p.status === 'downloading' || p.status === 'progress') {
        opts.onProgress({
          status: 'downloading',
          ...(typeof p.file === 'string' ? { file: p.file } : {}),
          ...(typeof p.loaded === 'number' ? { loaded: p.loaded } : {}),
          ...(typeof p.total === 'number' ? { total: p.total } : {}),
        });
      } else if (p.status === 'initiate' || p.status === 'ready' || p.status === 'done') {
        opts.onProgress({ status: 'loading' });
      }
    },
  });

  opts.onProgress?.({ status: 'ready' });

  async function embedOne(text: string): Promise<Float32Array> {
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    if (out.data.length !== dimension) {
      throw new Error(
        `wasm-embed: model ${modelId} returned ${out.data.length}-dim, expected ${dimension}`,
      );
    }
    return new Float32Array(out.data);
  }

  return {
    id: `wasm:${modelId}`,
    modelId,
    dimension,
    isLocal: true,
    async embed(text: string): Promise<Float32Array> {
      return embedOne(text);
    },
    async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
      // transformers.js supports batching but the API shape differs by version;
      // do sequential calls — RAG batches are small and the latency cost is
      // dominated by the model forward pass, not the dispatcher.
      const out: Float32Array[] = [];
      for (const t of texts) out.push(await embedOne(t));
      return out;
    },
  };
}
