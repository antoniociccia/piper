export interface AnalyzeIntent {
  readonly environment: string;
}

// Broad-audit verbs in IT + EN. Deterministic (no LLM) — the M1 router only
// needs to recognise an analyze request and resolve the target env. Richer
// scope/skill extraction (LLM) lands in M2.
const ANALYZE_VERB = /\b(analiz|analy[sz]|audit|diagnos|ispezion|inspect)/i;

/**
 * Returns an AnalyzeIntent if `text` is an analyze-class request that resolves
 * to exactly one registered environment, else null (the caller falls back to
 * the free-form planner). Slash commands never match.
 */
export function detectAnalyzeIntent(
  text: string,
  environmentNames: readonly string[],
): AnalyzeIntent | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('/')) return null;
  if (!ANALYZE_VERB.test(trimmed)) return null;

  // Prefer an explicitly named env (whole-word, case-insensitive).
  const named = environmentNames.find((name) =>
    new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i').test(trimmed),
  );
  if (named !== undefined) return { environment: named };

  // Fuzzy fallback: a word in the text that is a prefix (>=4 chars) of exactly
  // one env name resolves to it (e.g. "singularity" -> "singularityhive").
  // Ambiguous prefixes (matching 2+ envs) are left unresolved on purpose.
  const words = (trimmed.toLowerCase().match(/[a-z0-9-]+/g) ?? []).filter((w) => w.length >= 4);
  const prefixMatches = environmentNames.filter((name) =>
    words.some((w) => name.toLowerCase().startsWith(w)),
  );
  if (prefixMatches.length === 1 && prefixMatches[0] !== undefined) {
    return { environment: prefixMatches[0] };
  }

  // No env named: default only when there is exactly one registered.
  if (environmentNames.length === 1 && environmentNames[0] !== undefined) {
    return { environment: environmentNames[0] };
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
