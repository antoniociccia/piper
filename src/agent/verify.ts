import type { EvidenceRef, Verification } from './types.ts';

// Matches a square-bracket group that contains at least one ev-N token.
// Tolerates any non-bracket filler between tokens, so all of these are valid:
//   [ev-1]
//   [ev-1, ev-4]
//   [ev-1; ev-2 and ev-3]
const CITATION_BRACKET_PATTERN = /\[[^\]]*?\bev-\d+\b[^\]]*?\]/g;
const EV_NUMBER_PATTERN = /\bev-(\d+)\b/g;
const CODE_FENCE_PATTERN = /```[\s\S]*?```/g;
const SECTION_HEADING_PATTERN = /^#{1,6}\s+(.+?)\s*$/;

// Sections that describe absence-of-evidence or future actions — lines inside
// them are exempt from the citation requirement by design.
const CITATION_EXEMPT_HEADINGS: ReadonlySet<string> = new Set([
  'gaps',
  'capability gaps',
  'open questions',
  'next steps',
  'recommendations',
  'follow-up',
  'follow up',
  'proposed follow-ups',
  'todo',
  'to do',
  'caveats',
]);

const BULLET_PATTERN = /^\s*[-*+]\s+/;

// Lines that read like a conclusion, summary, disclaimer, or closing offer
// don't introduce new evidence-derived facts — they comment on the facts above
// OR explicitly say "I don't know this" (which is meta, not a claim about
// reality). Skipping the citation requirement matches how a human SRE writes.
const CONCLUSION_LINE_PATTERNS: readonly RegExp[] = [
  // Negations / disclaimers ("I don't have / there's no / nothing")
  /^\s*(non\s+(c'è|ci\s+sono|ho|sono|risulta|abbiamo|posso|riesco|ho\s+ancora|ho\s+visto)|nessun|niente|nessuno|nulla)\b/i,
  /^\s*(there'?s?\s+(no|not)|there\s+are\s+(no|not)|i\s+don'?t\s+have|i\s+haven'?t|no\s+(evidence|data|info|errors|signs|signals|issues|sign\b)|nothing\s+(to|of)\s+)/i,
  // Conclusions ("overall / in summary / in pratica")
  /^\s*(insomma|in\s+sintesi|in\s+conclusione|in\s+pratica|in\s+short|in\s+summary|in\s+conclusion|overall|tutto\s+sommato)\b/i,
  // Closing offers ("if you want / I can / let me know")
  /^\s*(se\s+(vuoi|vuole|preferisci|ti\s+serve|hai\s+bisogno)|posso|puoi|potrei|potresti|fammi\s+sapere|let\s+me\s+know|happy\s+to|i\s+can|feel\s+free)/i,
  // Scope markers ("as for / regarding / beyond this")
  /^\s*(per\s+quanto\s+riguarda|in\s+merito|riguardo|oltre\s+a|al\s+di\s+là|al\s+di\s+fuori|as\s+for|regarding|beyond)/i,
  // Self-references to the current turn ("in this turn / right now")
  /^\s*(in\s+questo\s+giro|in\s+questa\s+iterazione|in\s+questo\s+passaggio|al\s+momento|right\s+now|so\s+far)/i,
  // Preamble / greeting lines (the synth prompt forbids them but cheap models
  // still emit them; we'd rather skip the citation check than retry the whole
  // synth just to strip a "Got it" intro).
  /^\s*(got\s+it|sure|ok|okay|capito|certo|ecco|here'?s\s+(what|the|a)|let\s+me\s+(summari[sz]e|tell)|ok\s*[,:]?\s*here|alright)/i,
];

function isConclusionLine(line: string): boolean {
  return CONCLUSION_LINE_PATTERNS.some((p) => p.test(line));
}

function stripCodeFences(markdown: string): string {
  return markdown.replace(CODE_FENCE_PATTERN, '\n');
}

function isSubstantiveLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  if (trimmed.startsWith('#')) return false;
  if (trimmed.startsWith('|')) return false;
  if (/^[-*+]\s*$/.test(trimmed)) return false;
  if (trimmed.startsWith('---')) return false;
  const words = trimmed.split(/\s+/);
  return words.length >= 5;
}

function headingExempt(headingText: string): boolean {
  return CITATION_EXEMPT_HEADINGS.has(headingText.trim().toLowerCase());
}

/**
 * Collect every ev-N referenced from inside square-bracket citation groups.
 * Tolerates compound forms like `[ev-1, ev-4]` or `[ev-1; ev-2 and ev-3]`.
 */
function collectCitations(text: string): readonly string[] {
  const ids: string[] = [];
  for (const bracket of text.matchAll(CITATION_BRACKET_PATTERN)) {
    const content = bracket[0];
    for (const m of content.matchAll(EV_NUMBER_PATTERN)) {
      const n = m[1];
      if (n !== undefined) ids.push(`ev-${n}`);
    }
  }
  return ids;
}

function lineHasCitation(line: string): boolean {
  return collectCitations(line).length > 0;
}

export interface VerifyOptions {
  readonly markdown: string;
  readonly evidence: readonly EvidenceRef[];
  readonly requireCitationsOnSubstantiveLines?: boolean;
  /**
   * Fraction of substantive lines that must carry a citation for the report to
   * pass verification. Default 0.75 — a handful of conclusion / preamble lines
   * the patterns missed won't fail an otherwise well-grounded report. Set to 1
   * for strict mode (every substantive line must be cited).
   */
  readonly minCitedRatio?: number;
}

export function verifyReport(opts: VerifyOptions): Verification {
  const { markdown, evidence } = opts;
  const requireCitations = opts.requireCitationsOnSubstantiveLines ?? true;
  const minCitedRatio = opts.minCitedRatio ?? 0.75;
  const issues: string[] = [];

  const knownIds = new Set(evidence.map((e) => e.id));
  const stripped = stripCodeFences(markdown);

  const cited = collectCitations(stripped);
  const seenIds = new Set<string>();
  for (const id of cited) {
    seenIds.add(id);
    if (!knownIds.has(id)) {
      issues.push(`unknown citation [${id}] (no such evidence row)`);
    }
  }

  if (requireCitations) {
    const lines = stripped.split('\n');

    // Pre-pass: a bullet that lacks its own citation INHERITS coverage if any
    // line in its contiguous bullet-group (or the paragraph immediately before
    // or after) carries a citation. Matches how humans cite a whole list once.
    const bulletGroupCovered = new Array<boolean>(lines.length).fill(false);
    let groupStart = -1;
    let groupHasCitation = false;
    const closeGroup = (endExclusive: number): void => {
      if (groupStart === -1) return;
      if (groupHasCitation) {
        for (let k = groupStart; k < endExclusive; k += 1) bulletGroupCovered[k] = true;
      }
      groupStart = -1;
      groupHasCitation = false;
    };
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (BULLET_PATTERN.test(line)) {
        if (groupStart === -1) {
          groupStart = i;
          // Also look at the previous non-empty non-bullet line for a citation.
          for (let j = i - 1; j >= 0; j -= 1) {
            const prev = lines[j] ?? '';
            if (prev.trim() === '') continue;
            if (BULLET_PATTERN.test(prev)) break;
            if (lineHasCitation(prev)) groupHasCitation = true;
            break;
          }
        }
        if (lineHasCitation(line)) groupHasCitation = true;
      } else {
        if (groupStart !== -1) {
          // Look ahead one non-empty line for a trailing citation that closes the list.
          if (line.trim() !== '' && lineHasCitation(line)) groupHasCitation = true;
          closeGroup(i);
        }
      }
    }
    closeGroup(lines.length);

    let exemptSection = false;
    let substantiveCount = 0;
    let citedCount = 0;
    const missingLines: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const headingMatch = SECTION_HEADING_PATTERN.exec(line);
      if (headingMatch !== null) {
        exemptSection = headingExempt(headingMatch[1] ?? '');
        continue;
      }
      if (exemptSection) continue;
      if (!isSubstantiveLine(line)) continue;
      substantiveCount += 1;
      if (lineHasCitation(line)) {
        citedCount += 1;
        continue;
      }
      if (bulletGroupCovered[i]) {
        citedCount += 1;
        continue;
      }
      if (isConclusionLine(line)) {
        // Conclusion lines don't count toward substantive total either —
        // they're meta. Skip them from both numerator and denominator.
        substantiveCount -= 1;
        continue;
      }
      missingLines.push(`line ${i + 1} has no citation: ${line.trim().slice(0, 80)}`);
    }
    // Apply threshold: ok if cited ratio >= minCitedRatio AND ≥1 citation exists.
    if (substantiveCount > 0) {
      const ratio = citedCount / substantiveCount;
      if (ratio < minCitedRatio) {
        for (const m of missingLines) issues.push(m);
      }
    }
  }

  if (evidence.length > 0 && seenIds.size === 0) {
    issues.push('report cites no evidence — synthesizer failed to ground');
  }

  return { ok: issues.length === 0, issues };
}
