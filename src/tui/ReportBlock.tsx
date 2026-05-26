import { Box, Text } from 'ink';

import { AlienFace } from './AlienFace.tsx';

/**
 * Conversational answer block — used both for the LIVE streaming reply (in
 * App.tsx) and for COMMITTED reports in the scrollback (Report.tsx).
 *
 * Visual rules:
 *   - One `▌` glyph per PARAGRAPH (block of consecutive non-empty lines),
 *     not per line. Looks like an inline pull-quote marker, not a CSV.
 *   - Colour CYCLES through the paragraphs (green → cyan → magenta → yellow)
 *     so adjacent paragraphs are visually distinct.
 *   - When Ink wraps a long paragraph, the wrap continues from column 0 (no
 *     indentation under the ▌ glyph). This is the natural behaviour when the
 *     ▌ + paragraph text are nested children of a SINGLE outer `<Text>`.
 *   - Empty lines between paragraphs become a single `marginBottom={1}` gap.
 *
 * The dynamic→static transition (streaming buffer → committed scrollback)
 * uses the same component, so the layout is character-position-identical.
 */
const PARAGRAPH_COLORS = ['green', 'cyan', 'magenta', 'yellow'] as const;

interface ReportBlockProps {
  readonly lines: readonly string[];
  /** Show the animated alien mascot at the top (used while streaming). */
  readonly withMascot?: boolean;
  /**
   * Lock the mascot + prefix to one colour:
   *   - 'green'  → verified, committed
   *   - 'yellow' → ungrounded but surfaced
   * When undefined, colours cycle (used for the live stream).
   */
  readonly mascotColor?: 'green' | 'yellow';
  /** Append the blinking-cursor block at the end of the last paragraph. */
  readonly withCursor?: boolean;
}

function groupParagraphs(lines: readonly string[]): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') {
      if (current.length > 0) {
        out.push(current.join('\n'));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) out.push(current.join('\n'));
  return out;
}

export function ReportBlock({
  lines,
  withMascot = false,
  mascotColor,
  withCursor = false,
}: ReportBlockProps): JSX.Element {
  const paragraphs = groupParagraphs(lines);
  return (
    <Box flexDirection="column" marginY={1}>
      {withMascot && (
        <Box marginBottom={1}>
          <AlienFace busy={mascotColor === undefined} bold {...(mascotColor === undefined ? {} : { color: mascotColor })} />
        </Box>
      )}
      {paragraphs.map((para, i) => {
        const color = mascotColor ?? PARAGRAPH_COLORS[i % PARAGRAPH_COLORS.length] ?? 'green';
        const isLast = i === paragraphs.length - 1;
        return (
          <Box key={i} marginBottom={isLast ? 0 : 1}>
            {/*
              Both the ▌ marker and the paragraph body live inside a SINGLE
              outer <Text>. That's the trick: Ink treats the whole thing as
              one wrappable string, so the wrap inherits the left edge of
              the outer <Box> (column 0) instead of indenting under the
              prefix. Trying to do this with two sibling <Text>s in a row
              <Box> wraps with a 2-char indent, which the user explicitly
              flagged as ugly.
            */}
            <Text>
              <Text color={color} bold>{'▌ '}</Text>
              {para}
              {withCursor && isLast ? <Text inverse> </Text> : null}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
