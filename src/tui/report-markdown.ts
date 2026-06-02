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

// ── Tables ──────────────────────────────────────────────────────────────────

export interface ParsedTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export type RenderedBlock =
  | { readonly kind: 'line'; readonly raw: string }
  | { readonly kind: 'table'; readonly lines: readonly string[] };

function isTableRowLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.length > 1;
}

function isSeparatorLine(line: string): boolean {
  const t = line.trim();
  // A markdown table separator: only |, -, :, and spaces, with at least one dash.
  return t.startsWith('|') && /^[\s|:-]+$/.test(t) && t.includes('-');
}

function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/**
 * Parse a contiguous block (header, `|---|` separator, then data rows) into a
 * table. Returns null if it is not a real markdown table — which keeps a lone
 * prose line containing a `|` (a shell pipe) from being mistaken for one.
 */
export function parseTableBlock(lines: readonly string[]): ParsedTable | null {
  if (lines.length < 2) return null;
  if (!isTableRowLine(lines[0] ?? '')) return null;
  if (!isSeparatorLine(lines[1] ?? '')) return null;
  const headers = splitCells(lines[0] ?? '');
  const rows = lines
    .slice(2)
    .filter((l) => isTableRowLine(l))
    .map(splitCells);
  return { headers, rows };
}

/**
 * Render a parsed table as box-drawn, column-aligned monospace lines. Markdown
 * tables don't align in a terminal (cell widths differ per row); this pads every
 * column to its widest cell so columns line up and numbers are scannable.
 */
export function renderAlignedTable(table: ParsedTable): string[] {
  const cols = Math.max(table.headers.length, ...table.rows.map((r) => r.length), 1);
  const at = (cells: readonly string[], i: number): string => cells[i] ?? '';
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(at(table.headers, i).length, ...table.rows.map((r) => at(r, i).length), 0),
  );
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));
  const rowLine = (cells: readonly string[]): string =>
    `│ ${widths.map((w, i) => pad(at(cells, i), w)).join(' │ ')} │`;
  const border = (l: string, m: string, r: string): string =>
    l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r;
  return [
    border('┌', '┬', '┐'),
    rowLine(table.headers),
    border('├', '┼', '┤'),
    ...table.rows.map(rowLine),
    border('└', '┴', '┘'),
  ];
}

/**
 * Split answer lines into prose lines and pre-rendered, aligned table blocks.
 * A table is a row line immediately followed by a `|---|` separator; everything
 * else stays a plain line.
 */
export function groupBlocks(lines: readonly string[]): RenderedBlock[] {
  const out: RenderedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i] ?? '';
    if (isTableRowLine(cur) && isSeparatorLine(lines[i + 1] ?? '')) {
      const block: string[] = [cur, lines[i + 1] ?? ''];
      let j = i + 2;
      while (j < lines.length && isTableRowLine(lines[j] ?? '')) {
        block.push(lines[j] ?? '');
        j += 1;
      }
      const parsed = parseTableBlock(block);
      if (parsed !== null) {
        out.push({ kind: 'table', lines: renderAlignedTable(parsed) });
        i = j;
        continue;
      }
    }
    out.push({ kind: 'line', raw: cur });
    i += 1;
  }
  return out;
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
