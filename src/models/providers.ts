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
    displayName: 'Ollama',
  },
  lmstudio: {
    id: 'lmstudio',
    kind: 'local',
    defaultBaseUrl: 'http://localhost:1234/v1',
    defaultPort: 1234,
    requiresApiKey: false,
    enforcePrivacyDeny: false,
    displayName: 'LM Studio',
  },
  llamacpp: {
    id: 'llamacpp',
    kind: 'local',
    defaultBaseUrl: 'http://localhost:8080/v1',
    defaultPort: 8080,
    requiresApiKey: false,
    enforcePrivacyDeny: false,
    displayName: 'llama.cpp (server)',
  },
  vllm: {
    id: 'vllm',
    kind: 'local',
    defaultBaseUrl: 'http://localhost:8000/v1',
    defaultPort: 8000,
    requiresApiKey: false,
    enforcePrivacyDeny: false,
    displayName: 'vLLM',
  },
  openrouter: {
    id: 'openrouter',
    kind: 'remote',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultPort: null,
    requiresApiKey: true,
    enforcePrivacyDeny: true,
    displayName: 'OpenRouter',
  },
  custom: {
    id: 'custom',
    kind: 'either',
    defaultBaseUrl: null,
    defaultPort: null,
    requiresApiKey: false,
    enforcePrivacyDeny: false,
    displayName: 'Custom OpenAI-compatible',
  },
};

export const LOCAL_PROVIDERS: readonly ProviderId[] = (
  Object.values(PROVIDERS).filter((p) => p.kind === 'local').map((p) => p.id)
);

export function getProvider(id: ProviderId): ProviderConfig {
  return PROVIDERS[id];
}
