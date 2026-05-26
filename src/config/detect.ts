import { PROVIDERS, type ProviderId } from '../models/providers.ts';

export interface DetectedProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly modelCount: number;
}

const DETECT_TIMEOUT_MS = 700;

async function probe(baseUrl: string): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) return null;
    return body.data.length;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function detectLocalProviders(): Promise<readonly DetectedProvider[]> {
  const candidates: ProviderId[] = ['ollama', 'lmstudio', 'llamacpp', 'vllm'];
  const results = await Promise.all(
    candidates.map(async (id) => {
      const cfg = PROVIDERS[id];
      if (cfg.defaultBaseUrl === null) return null;
      const count = await probe(cfg.defaultBaseUrl);
      if (count === null) return null;
      return {
        id,
        displayName: cfg.displayName,
        baseUrl: cfg.defaultBaseUrl,
        modelCount: count,
      };
    }),
  );
  return results.filter((r): r is DetectedProvider => r !== null);
}

export async function listModelsFor(baseUrl: string, apiKey?: string): Promise<readonly string[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const headers: Record<string, string> = {};
    if (apiKey !== undefined && apiKey !== '') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return [];
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    if (!Array.isArray(body.data)) return [];
    return body.data
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id !== '');
  } catch {
    return [];
  }
}
