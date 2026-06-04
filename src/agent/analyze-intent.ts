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

  // No env named: default only when there is exactly one registered.
  if (environmentNames.length === 1 && environmentNames[0] !== undefined) {
    return { environment: environmentNames[0] };
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
