export type LocalProviderId = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm';

export interface LocalProviderConfig {
  readonly id: LocalProviderId;
  readonly host: string;
  readonly port: number;
}

export interface LocalProviderProbe {
  readonly config: LocalProviderConfig;
  readonly reachable: boolean;
  readonly models: readonly string[];
}

export const DEFAULT_LOCAL_PROVIDERS: readonly LocalProviderConfig[] = [
  { id: 'ollama', host: 'localhost', port: 11434 },
  { id: 'lmstudio', host: 'localhost', port: 1234 },
  { id: 'llamacpp', host: 'localhost', port: 8080 },
  { id: 'vllm', host: 'localhost', port: 8000 },
];

export function baseUrlFor(cfg: LocalProviderConfig): string {
  return `http://${cfg.host}:${cfg.port}/v1`;
}

interface ModelsResponse {
  readonly data?: ReadonlyArray<{ readonly id?: string }>;
}

/**
 * Probe a single local provider's /v1/models endpoint with a short timeout.
 * Returns the (possibly empty) model list on success, or `reachable: false` on
 * timeout / connection refused.
 */
export async function probeLocalProvider(
  cfg: LocalProviderConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 800,
): Promise<LocalProviderProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrlFor(cfg)}/models`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return { config: cfg, reachable: false, models: [] };
    const body = (await res.json()) as ModelsResponse;
    const models = (body.data ?? [])
      .map((x) => x.id)
      .filter((x): x is string => typeof x === 'string' && x !== '');
    return { config: cfg, reachable: true, models };
  } catch {
    return { config: cfg, reachable: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAllLocalProviders(
  configs: readonly LocalProviderConfig[] = DEFAULT_LOCAL_PROVIDERS,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly LocalProviderProbe[]> {
  return Promise.all(configs.map((c) => probeLocalProvider(c, fetchImpl)));
}
