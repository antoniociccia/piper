import { homedir } from 'node:os';
import { join } from 'node:path';

import onnxRuntimeWasmPath from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm' with { type: 'file' };
// `with { type: 'file' }` tells Bun to bundle the .mjs as a static asset and
// return its path. TypeScript can't model that assertion and resolves the .mjs
// as a real JS module with no declarations — suppress that one error narrowly.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- .mjs imported as a file asset, not as a JS module
import onnxRuntimeMjsPath from '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs' with { type: 'file' };

import type { EmbeddingClient } from './embedding-client.ts';
import { createModelFileCache } from './wasm-model-cache.ts';

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

interface OnnxWasmFlags {
  wasmPaths?: string | { wasm?: string; mjs?: string };
  numThreads?: number;
  proxy?: boolean;
}

interface OnnxBackend {
  wasm?: OnnxWasmFlags;
}

interface HFBackends {
  onnx?: OnnxBackend;
}

interface HFEnv {
  cacheDir: string;
  allowRemoteModels: boolean;
  allowLocalModels: boolean;
  useCustomCache: boolean;
  customCache: unknown;
  backends?: HFBackends;
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

  // Import the web build explicitly. The default entry uses conditional
  // exports and, in a Node-like runtime (Bun included), resolves to the build
  // that requires `onnxruntime-node` — a native binding that cannot be
  // embedded in a `bun build --compile` artifact. The web build uses
  // `onnxruntime-web` (WASM), which we ship as bundled assets below.
  //
  // CRITICAL — mask the Node identity during the import. Bun reports
  // `process.release.name === 'node'`, which makes the WEB build take its
  // Node code path: "return a file path from the filesystem cache". But the
  // web build ships with node:fs shimmed out, so that path always fails with
  // "Unable to get model file path or buffer". Masking the release name while
  // the module's top-level environment detection runs makes it treat Bun as a
  // browser-like runtime: models are downloaded into memory buffers, which
  // works everywhere (dev mode and compiled binary).
  const realRelease = process.release;
  Object.defineProperty(process, 'release', {
    value: { ...realRelease, name: 'bun' },
    configurable: true,
  });
  let mod: HFModule;
  try {
    mod = (await import(
      '../../node_modules/@huggingface/transformers/dist/transformers.web.js'
    )) as unknown as HFModule;
  } finally {
    Object.defineProperty(process, 'release', { value: realRelease, configurable: true });
  }
  mod.env.cacheDir = cacheDir;
  mod.env.allowRemoteModels = true;
  // Keep transformers.js from probing its default `localModelPath` (`/models/`)
  // — in the compiled binary that path doesn't exist and the fetch fails with
  // "URL is invalid" before we ever get to the remote fetch.
  mod.env.allowLocalModels = false;
  // The web build has no working cache in Bun (no browser Cache API, no fs).
  // Plug in our filesystem cache so model assets download once, not per boot.
  mod.env.useCustomCache = true;
  mod.env.customCache = createModelFileCache(cacheDir);

  // Point the ONNX WASM runtime at the assets we embedded. Without this the
  // compiled binary would try to fetch them from a CDN at runtime, defeating
  // the offline guarantee.
  const backends = (mod.env.backends ??= {});
  const onnx = (backends.onnx ??= {});
  onnx.wasm = {
    ...(onnx.wasm ?? {}),
    wasmPaths: { wasm: onnxRuntimeWasmPath, mjs: onnxRuntimeMjsPath },
    numThreads: 1,
  };

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
