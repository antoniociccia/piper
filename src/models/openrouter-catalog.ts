export interface OpenRouterModel {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number;
  readonly inputUsdPerMtok: number;
  readonly outputUsdPerMtok: number;
  readonly toolCalling: boolean;
  readonly moderated: boolean;
  readonly description: string;
}

export interface FetchOpenRouterModelsOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

interface RawModel {
  readonly id?: string;
  readonly name?: string;
  readonly context_length?: number;
  readonly pricing?: {
    readonly prompt?: string;
    readonly completion?: string;
  };
  readonly supported_parameters?: readonly string[];
  readonly description?: string;
  readonly top_provider?: {
    readonly is_moderated?: boolean;
  };
}

/**
 * Provider name prefixes (the leading "<org>/" segment of the model id) we
 * exclude from the picker by default — typically because their published
 * privacy / data-handling policy is too permissive for an infra-context CLI
 * that may receive sensitive logs. Conservative list. Users can still set the
 * provider manually in credentials.json.
 */
const PROVIDER_DENYLIST: readonly string[] = [
  'openchat/', // permissive policy
];

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';

function parseUsdPerToken(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch the full OpenRouter model catalog. Free, unauthenticated endpoint.
 * Returns models with tool_calling support inferred from supported_parameters.
 */
export interface FetchOpenRouterModelsResult {
  /** Models accepted by the policy filter (paid, tool-capable, moderated, not denylisted). */
  readonly models: readonly OpenRouterModel[];
  /** Count of raw models returned by the upstream API. */
  readonly total: number;
  /** Count removed by the policy filter. */
  readonly filtered: number;
}

export async function fetchOpenRouterModels(
  opts: FetchOpenRouterModelsOptions = {},
): Promise<readonly OpenRouterModel[]> {
  const r = await fetchOpenRouterModelsWithStats(opts);
  return r.models;
}

export async function fetchOpenRouterModelsWithStats(
  opts: FetchOpenRouterModelsOptions = {},
): Promise<FetchOpenRouterModelsResult> {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  const f = opts.fetch ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.apiKey !== undefined && opts.apiKey !== '') {
    headers['Authorization'] = `Bearer ${opts.apiKey}`;
  }
  const res = await f(`${baseUrl}/models`, { method: 'GET', headers });
  if (!res.ok) {
    throw new Error(`openrouter models fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { readonly data?: readonly RawModel[] };
  const data = body.data ?? [];
  const accepted: OpenRouterModel[] = [];
  let filtered = 0;
  for (const m of data) {
    if (m.id === undefined) continue;
    const inputPerToken = parseUsdPerToken(m.pricing?.prompt);
    const outputPerToken = parseUsdPerToken(m.pricing?.completion);
    const tools = (m.supported_parameters ?? []).includes('tools');
    const moderated = m.top_provider?.is_moderated === true;

    // ── Policy filter ─────────────────────────────────────────────
    // Keep it minimal — the picker should show what the user can actually use:
    //   - no free models (often train on user data + flaky availability)
    //   - no models without tool_calling (the planner can't function)
    //   - drop providers explicitly denylisted
    // We DON'T require `is_moderated`: many high-quality models (Qwen,
    // DeepSeek, Mistral, …) ship `is_moderated=false` because the provider
    // is permissive. Filtering them out artificially shrinks the picker.
    const isFree =
      m.id.endsWith(':free') || m.id.includes(':free') || (inputPerToken === 0 && outputPerToken === 0);
    const denylisted = PROVIDER_DENYLIST.some((p) => m.id!.startsWith(p));
    if (isFree || !tools || denylisted) {
      filtered += 1;
      continue;
    }

    accepted.push({
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length ?? 0,
      inputUsdPerMtok: inputPerToken * 1_000_000,
      outputUsdPerMtok: outputPerToken * 1_000_000,
      toolCalling: tools,
      moderated,
      description: m.description ?? '',
    });
  }
  return { models: accepted, total: data.length, filtered };
}
