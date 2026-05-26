import type { ProviderId } from '../models/providers.ts';

export interface EmbeddingPreset {
  readonly modelId: string;
  readonly dimension: number;
  readonly note: string;
}

/**
 * Sensible embedding-model presets per local backend. Dimension is fixed by
 * the model — must match the `vector(N)` column in the rag_documents schema
 * (currently 768).
 */
export const LOCAL_EMBEDDING_PRESETS: Readonly<Record<ProviderId, EmbeddingPreset | null>> = {
  ollama: {
    modelId: 'nomic-embed-text',
    dimension: 768,
    note: 'Pull with `ollama pull nomic-embed-text`. Fast, ~280 MB.',
  },
  llamacpp: {
    modelId: 'nomic-embed-text-v1.5.Q4_K_M',
    dimension: 768,
    note: 'Start llama-server with --embeddings and the GGUF of nomic-embed-text.',
  },
  vllm: {
    modelId: 'nomic-ai/nomic-embed-text-v1.5',
    dimension: 768,
    note: 'Start vLLM with --task embed.',
  },
  lmstudio: {
    modelId: 'nomic-ai/nomic-embed-text-v1.5-GGUF',
    dimension: 768,
    note: 'Enable embeddings in LM Studio server settings.',
  },
  openrouter: null,
  custom: null,
};

export const DEFAULT_EMBEDDING_DIMENSION = 768;
