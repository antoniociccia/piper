/**
 * Pure markdown-lite parsing for the conversational answer block. Kept separate
 * from the Ink component so the classification rules are unit-testable without a
 * terminal renderer.
 */

export type InlineSegment =
  | { readonly kind: 'plain'; readonly text: string }
  | { readonly kind: 'bold'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'citation'; readonly text: string };

export type LineKind =
  | { readonly kind: 'blank' }
  | { readonly kind: 'heading'; readonly segments: readonly InlineSegment[] }
  | { readonly kind: 'bullet'; readonly segments: readonly InlineSegment[] }
  | { readonly kind: 'text'; readonly segments: readonly InlineSegment[] };

const HEADING = /^\s{0,3}(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const INLINE_SPLIT = /(\*\*[^*]+\*\*|`[^`]+`|\[ev-[^\]]+\])/g;

/**
 * Split a line into styled inline segments: `**bold**`, `` `code` ``, `[ev-N]`
 * citations, and plain runs. Unmatched text is preserved verbatim; empty
 * segments produced by the split are dropped.
 */
export function splitInline(text: string): readonly InlineSegment[] {
  return text
    .split(INLINE_SPLIT)
    .filter((piece) => piece !== '')
    .map((piece): InlineSegment => {
      if (piece.length >= 4 && piece.startsWith('**') && piece.endsWith('**')) {
        return { kind: 'bold', text: piece.slice(2, -2) };
      }
      if (piece.length >= 2 && piece.startsWith('`') && piece.endsWith('`')) {
        return { kind: 'code', text: piece.slice(1, -1) };
      }
      if (piece.startsWith('[ev-') && piece.endsWith(']')) {
        return { kind: 'citation', text: piece };
      }
      return { kind: 'plain', text: piece };
    });
}

/** Classify one raw line into a heading / bullet / blank / plain text node. */
export function classifyLine(raw: string): LineKind {
  if (raw.trim() === '') return { kind: 'blank' };

  const heading = HEADING.exec(raw);
  if (heading) return { kind: 'heading', segments: splitInline(heading[2] ?? '') };

  const bullet = BULLET.exec(raw);
  if (bullet) return { kind: 'bullet', segments: splitInline(bullet[1] ?? '') };

  return { kind: 'text', segments: splitInline(raw) };
}
