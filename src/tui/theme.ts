import pkg from '../../package.json';

/**
 * The one place for the TUI's shared visual vocabulary. Components keep using
 * Ink color props directly (the palette is small and semantic enough), but
 * glyphs, the spinner frames, and the version string live here so they stay
 * consistent across every surface instead of being re-declared per file.
 */

export const VERSION: string = pkg.version;

/** Braille spinner frames — single source for every animated indicator. */
export const BRAILLE: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinnerFrame(tick: number | undefined): string {
  const t = tick ?? 0;
  return BRAILLE[t % BRAILLE.length] ?? '⠋';
}

/** Shared glyphs — one symbol per meaning, everywhere. */
export const GLYPH = {
  /** User prompt prefix. */
  prompt: '›',
  /** Active selection marker in pickers/autocomplete. */
  select: '▸',
  /** Step / plan headline marker. */
  plan: '◆',
  /** Successful check. */
  ok: '✓',
  /** Failed check. */
  fail: '✗',
  /** Idle/static step marker (spinner placeholder). */
  idle: '○',
  /** List bullet. */
  bullet: '•',
} as const;

/**
 * Column width for the description field in step/result rows. Discovery-step
 * descriptions are short ("OS / kernel", "compose files on disk"); padding to
 * a fixed width keeps the `· action.name` column aligned across rows that are
 * rendered as independent entries (so no shared layout pass is possible).
 */
export const STEP_DESC_WIDTH = 22;
