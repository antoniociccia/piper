export type ProviderId =
  | 'ollama'
  | 'lmstudio'
  | 'llamacpp'
  | 'vllm'
  | 'openrouter'
  | 'custom';

export type ProviderKind = 'local' | 'remote' | 'either';

export interface ProviderConfig {
  readonly id: ProviderId;
  readonly kind: ProviderKind;
  readonly defaultBaseUrl: string | null;
  readonly defaultPort: number | null;
  readonly requiresApiKey: boolean;
  /**
   * Model used when the user names a provider but not a model. Local providers
   * MUST name a tag their own runtime can resolve — a vendor-prefixed
   * aggregator id like `mistralai/devstral-small-2-24b` is not one, and makes
   * the first request of a fresh local setup fail with "model not found".
   * `null` where there is nothing sensible to guess.
   */
  readonly defaultModel: string | null;
  readonly enforcePrivacyDeny: boolean;
  readonly displayName: string;
}

export const PROVIDERS: Readonly<Record<ProviderId, ProviderConfig>> = {
  ollama: {
    id: 'ollama',
    kind: 'local',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultPort: 11434,
    requiresApiKey: false,
    enforcePrivacyDeny: false,
    // Measured against PIPER's own analyze flow on a host with seven planted
    // incidents: qwen3.5 was the only family that produced the grounded
    // citations the verifier requires. 4b is the smallest that works, so it is
    // the default that fits an ordinary laptop.
    defaultModel: 'qwen3.5:4b',
    displayName: 'Ollama',
  },
  lmstudio: {
    id: 'lmstudio',
    kind: 'local',
    defaultBaseUrl: 'http://localhost:1234/v1',
    defaultPort: 1234,
    requiresApiKey: false,
    enforcePrivacyDeny: false,
    defaultModel: 'qwen3.5-4b',
    displayName: 'LM Studio',
  },
  llamacpp: {
    id: 'llamacpp',
    kind: 'local',
    defaultBaseUrl: 'http://localhost:8080/v1',
    defaultPort: 8080,
    requiresApiKey: false,
    enforcePrivacyDeny: false,
    // llama.cpp serves whatever single GGUF it was started with and ignores
    // the field, so this is a label rather than a selector.
    defaultModel: 'local-model',
    displayName: 'llama.cpp (server)',
  },
  vllm: {
    id: 'vllm',
    kind: 'local',
    defaultBaseUrl: 'http://localhost:8000/v1',
    defaultPort: 8000,
    requiresApiKey: false,
    enforcePrivacyDeny: false,
    defaultModel: 'qwen3.5-4b',
    displayName: 'vLLM',
  },
  openrouter: {
    id: 'openrouter',
    kind: 'remote',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultPort: null,
    requiresApiKey: true,
    enforcePrivacyDeny: true,
    defaultModel: 'deepseek/deepseek-v4-pro',
    displayName: 'OpenRouter',
  },
  custom: {
    id: 'custom',
    kind: 'either',
    defaultBaseUrl: null,
    defaultPort: null,
    requiresApiKey: false,
    enforcePrivacyDeny: false,
    defaultModel: null,
    displayName: 'Custom OpenAI-compatible',
  },
};

export const LOCAL_PROVIDERS: readonly ProviderId[] = (
  Object.values(PROVIDERS).filter((p) => p.kind === 'local').map((p) => p.id)
);

export function getProvider(id: ProviderId): ProviderConfig {
  return PROVIDERS[id];
}
