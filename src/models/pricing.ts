export type Tier = 'featherweight' | 'economy' | 'balanced' | 'premium' | 'local';

export interface ModelPricing {
  readonly modelId: string;
  readonly displayName: string;
  readonly inputUsdPerMtok: number;
  readonly outputUsdPerMtok: number;
  readonly maxContextTokens: number;
  readonly toolCalling: boolean;
  readonly tier: Tier;
  readonly available: boolean;
  readonly note?: string;
}

// Source: live OpenRouter /api/v1/models snapshot, 2026-05.
// Local entries (tier='local') have zero $ cost; we still track usage tokens.
// To update: refresh via `bun run scripts/refresh-pricing.ts` (future script).
const ENTRIES: readonly ModelPricing[] = [
  // ── Featherweight ($) — dev/test, sandbox ────────────────────────────────
  {
    modelId: 'deepseek/deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    inputUsdPerMtok: 0.10,
    outputUsdPerMtok: 0.20,
    maxContextTokens: 1_048_576,
    toolCalling: true,
    tier: 'featherweight',
    available: true,
  },
  {
    modelId: 'google/gemini-3.1-flash-lite',
    displayName: 'Gemini 3.1 Flash Lite',
    inputUsdPerMtok: 0.25,
    outputUsdPerMtok: 1.50,
    maxContextTokens: 1_048_576,
    toolCalling: true,
    tier: 'featherweight',
    available: true,
  },

  // ── Economy ($$) — daily-driver low-cost (DEFAULT for PIPER) ─────────────
  {
    modelId: 'deepseek/deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    inputUsdPerMtok: 0.435,
    outputUsdPerMtok: 0.87,
    maxContextTokens: 1_048_576,
    toolCalling: true,
    tier: 'economy',
    available: true,
  },
  {
    modelId: 'moonshotai/kimi-k2.6',
    displayName: 'Kimi K2.6',
    inputUsdPerMtok: 0.73,
    outputUsdPerMtok: 3.49,
    maxContextTokens: 262_144,
    toolCalling: true,
    tier: 'economy',
    available: true,
    note: 'agentic-tuned, 256K context',
  },
  {
    modelId: '~anthropic/claude-haiku-latest',
    displayName: 'Claude Haiku (latest)',
    inputUsdPerMtok: 1.00,
    outputUsdPerMtok: 5.00,
    maxContextTokens: 200_000,
    toolCalling: true,
    tier: 'economy',
    available: true,
  },
  {
    modelId: '~openai/gpt-mini-latest',
    displayName: 'GPT Mini (latest)',
    inputUsdPerMtok: 0.75,
    outputUsdPerMtok: 4.50,
    maxContextTokens: 400_000,
    toolCalling: true,
    tier: 'economy',
    available: true,
  },
  {
    modelId: 'mistralai/mistral-medium-3.5',
    displayName: 'Mistral Medium 3.5',
    inputUsdPerMtok: 1.50,
    outputUsdPerMtok: 7.50,
    maxContextTokens: 262_144,
    toolCalling: true,
    tier: 'economy',
    available: true,
  },
  {
    modelId: 'x-ai/grok-4.3',
    displayName: 'Grok 4.3',
    inputUsdPerMtok: 1.25,
    outputUsdPerMtok: 2.50,
    maxContextTokens: 1_000_000,
    toolCalling: true,
    tier: 'economy',
    available: true,
  },

  // ── Balanced ($$$) — production-grade ────────────────────────────────────
  {
    modelId: '~anthropic/claude-sonnet-latest',
    displayName: 'Claude Sonnet (latest)',
    inputUsdPerMtok: 3.00,
    outputUsdPerMtok: 15.00,
    maxContextTokens: 1_000_000,
    toolCalling: true,
    tier: 'balanced',
    available: true,
  },
  {
    modelId: 'anthropic/claude-opus-4.7',
    displayName: 'Claude Opus 4.7',
    inputUsdPerMtok: 5.00,
    outputUsdPerMtok: 25.00,
    maxContextTokens: 1_000_000,
    toolCalling: true,
    tier: 'balanced',
    available: true,
    note: 'top-quality at moderate cost',
  },
  {
    modelId: 'openai/gpt-5.5',
    displayName: 'GPT-5.5',
    inputUsdPerMtok: 5.00,
    outputUsdPerMtok: 30.00,
    maxContextTokens: 1_050_000,
    toolCalling: true,
    tier: 'balanced',
    available: true,
  },
  {
    modelId: 'qwen/qwen3.7-max',
    displayName: 'Qwen3.7 Max',
    inputUsdPerMtok: 2.50,
    outputUsdPerMtok: 7.50,
    maxContextTokens: 1_000_000,
    toolCalling: true,
    tier: 'balanced',
    available: true,
  },
  {
    modelId: 'google/gemini-3.5-flash',
    displayName: 'Gemini 3.5 Flash',
    inputUsdPerMtok: 1.50,
    outputUsdPerMtok: 9.00,
    maxContextTokens: 1_048_576,
    toolCalling: true,
    tier: 'balanced',
    available: true,
  },

  // ── Premium ($$$$$) — high-stakes ────────────────────────────────────────
  {
    modelId: 'anthropic/claude-opus-4.7-fast',
    displayName: 'Claude Opus 4.7 (Fast)',
    inputUsdPerMtok: 30.00,
    outputUsdPerMtok: 150.00,
    maxContextTokens: 1_000_000,
    toolCalling: true,
    tier: 'premium',
    available: true,
  },
  {
    modelId: 'openai/gpt-5.4-pro',
    displayName: 'GPT-5.4 Pro',
    inputUsdPerMtok: 30.00,
    outputUsdPerMtok: 180.00,
    maxContextTokens: 1_050_000,
    toolCalling: true,
    tier: 'premium',
    available: true,
  },
  {
    modelId: 'openai/gpt-5.5-pro',
    displayName: 'GPT-5.5 Pro',
    inputUsdPerMtok: 30.00,
    outputUsdPerMtok: 180.00,
    maxContextTokens: 1_050_000,
    toolCalling: true,
    tier: 'premium',
    available: true,
  },

  // ── Local (no $ cost; entries kept for capability metadata) ──────────────
  {
    modelId: 'mistralai/devstral-small-2-24b',
    displayName: 'Devstral-Small-2-24B',
    inputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
    maxContextTokens: 128_000,
    toolCalling: true,
    tier: 'local',
    available: true,
    note: 'agentic-first, native Mistral function-calling',
  },
  {
    modelId: 'openai/gpt-oss-20b',
    displayName: 'gpt-oss-20B',
    inputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
    maxContextTokens: 128_000,
    toolCalling: true,
    tier: 'local',
    available: true,
    note: 'cleanest JSON tool-call adherence',
  },
  {
    modelId: 'qwen/qwen3-coder-30b-a3b',
    displayName: 'Qwen3-Coder-30B-A3B',
    inputUsdPerMtok: 0,
    outputUsdPerMtok: 0,
    maxContextTokens: 256_000,
    toolCalling: true,
    tier: 'local',
    available: true,
    note: 'BFCL 68.2, RL on SWE-Bench',
  },
];

const BY_ID: ReadonlyMap<string, ModelPricing> = new Map(
  ENTRIES.map((e) => [e.modelId, e]),
);

export function getPricing(modelId: string): ModelPricing | null {
  return BY_ID.get(modelId) ?? null;
}

export function listByTier(tier: Tier): readonly ModelPricing[] {
  return ENTRIES.filter((e) => e.tier === tier && e.available);
}

export function allAvailable(): readonly ModelPricing[] {
  return ENTRIES.filter((e) => e.available);
}

export function isAvailable(modelId: string): boolean {
  const entry = BY_ID.get(modelId);
  return entry !== undefined && entry.available;
}

export const DEFAULT_MODEL_BY_TIER: Readonly<Record<Tier, string>> = {
  featherweight: 'deepseek/deepseek-v4-flash',
  economy: 'deepseek/deepseek-v4-pro',
  balanced: '~anthropic/claude-sonnet-latest',
  premium: 'anthropic/claude-opus-4.7-fast',
  local: 'mistralai/devstral-small-2-24b',
};

export interface CostBreakdown {
  readonly inputUsd: number;
  readonly outputUsd: number;
  readonly totalUsd: number;
}

export function computeCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): CostBreakdown {
  const pricing = getPricing(modelId);
  if (pricing === null || pricing.tier === 'local') {
    return { inputUsd: 0, outputUsd: 0, totalUsd: 0 };
  }
  const inputUsd = (inputTokens / 1_000_000) * pricing.inputUsdPerMtok;
  const outputUsd = (outputTokens / 1_000_000) * pricing.outputUsdPerMtok;
  return { inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}
