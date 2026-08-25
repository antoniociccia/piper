import { Box, Text } from 'ink';
import type { JSX } from 'react';

import { AlienFace } from './AlienFace.tsx';
import { classifyLine, groupBlocks, splitInline, type InlineSegment } from './report-markdown.ts';

/**
 * Conversational answer block — used both for the LIVE streaming reply (in
 * App.tsx) and for COMMITTED reports in the scrollback (Report.tsx).
 *
 * Aesthetic: clean markdown-flavoured prose, NO per-line/per-paragraph vertical
 * bars and NO colour cycling (both read as an ugly alternating-row "table").
 * The answer is set apart only by a one-column left gutter and the mascot at
 * the top. Light inline markdown is honoured (see report-markdown.ts):
 * `#`/`##`/`###` → bold cyan, `- `/`* ` → `• `, `**bold**`, `` `code` `` →
 * yellow, `[ev-N]` citations → dim.
 *
 * The dynamic→static transition (streaming buffer → committed scrollback) uses
 * the same component, so the layout is character-position-identical.
 */

interface ReportBlockProps {
  readonly lines: readonly string[];
  /** Show the animated alien mascot at the top (used while streaming). */
  readonly withMascot?: boolean;
  /**
   * Lock the mascot to one colour:
   *   - 'green'  → verified, committed
   *   - 'yellow' → ungrounded but surfaced
   * When undefined, the mascot colour-cycles (used for the live stream).
   */
  readonly mascotColor?: 'green' | 'yellow';
  /** Append the blinking-cursor block at the end of the last line. */
  readonly withCursor?: boolean;
}

function Inline({ segments }: { segments: readonly InlineSegment[] }): JSX.Element {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'bold') return <Text key={i} bold>{seg.text}</Text>;
        if (seg.kind === 'code') return <Text key={i} color="yellow">{seg.text}</Text>;
        if (seg.kind === 'citation') return <Text key={i} dimColor>{seg.text}</Text>;
        return <Text key={i}>{seg.text}</Text>;
      })}
    </>
  );
}

function Line({ raw, cursor }: { raw: string; cursor: boolean }): JSX.Element {
  const node = classifyLine(raw);
  const tail = cursor ? <Text inverse> </Text> : null;

  if (node.kind === 'blank') return <Text>{tail}</Text>;

  if (node.kind === 'heading') {
    return (
      <Text bold color="cyan">
        <Inline segments={node.segments} />
        {tail}
      </Text>
    );
  }

  if (node.kind === 'bullet') {
    return (
      <Text>
        <Text color="cyan">{'• '}</Text>
        <Inline segments={node.segments} />
        {tail}
      </Text>
    );
  }

  return (
    <Text>
      <Inline segments={node.segments} />
      {tail}
    </Text>
  );
}

/** One line of a box-drawn table. Borders are dim; cell content keeps inline
 *  styling (dimmed [ev-N], bold) while the `│` separators stay dim. */
function TableLine({ raw }: { raw: string }): JSX.Element {
  if (raw.includes('─')) return <Text dimColor>{raw}</Text>; // ┌┬┐ ├┼┤ └┴┘ border
  const parts = raw.split('│');
  return (
    <Text>
      {parts.map((part, i) => (
        <Text key={i}>
          {i > 0 ? <Text dimColor>│</Text> : null}
          <Inline segments={splitInline(part)} />
        </Text>
      ))}
    </Text>
  );
}

/**
 * One committed line of a streamed report. Same typography as {@link ReportBlock}
 * — one-column gutter, inline markdown, dimmed citations — so a report that
 * arrives line by line is character-position-identical to one rendered whole.
 */
export function ReportLine({
  raw,
  cursor = false,
}: {
  raw: string;
  /** Blinking block at the end — used for the one line still being written. */
  cursor?: boolean;
}): JSX.Element {
  return (
    <Box paddingLeft={1}>
      <Line raw={raw} cursor={cursor} />
    </Box>
  );
}

/**
 * A committed table, already aligned by `renderAlignedTable`. Kept separate from
 * {@link ReportLine} because column widths depend on every row, so a table
 * cannot be emitted until its last row has arrived.
 */
export function ReportTable({ lines }: { lines: readonly string[] }): JSX.Element {
  return (
    <Box flexDirection="column" paddingLeft={1}>
      {lines.map((tl, i) => (
        <TableLine key={i} raw={tl} />
      ))}
    </Box>
  );
}

/** The mascot that opens a streamed report block. */
export function ReportMascot(): JSX.Element {
  return (
    <Box marginTop={1}>
      <AlienFace busy bold />
    </Box>
  );
}

export function ReportBlock({
  lines,
  withMascot = false,
  mascotColor,
  withCursor = false,
}: ReportBlockProps): JSX.Element {
  const blocks = groupBlocks(lines);
  const lastBlock = blocks.length - 1;
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={1}>
      {withMascot && (
        <Box marginBottom={1} marginLeft={-1}>
          <AlienFace
            busy={mascotColor === undefined}
            bold
            {...(mascotColor === undefined ? {} : { color: mascotColor })}
          />
        </Box>
      )}
      {blocks.map((block, bi) => {
        if (block.kind === 'table') {
          return (
            <Box key={bi} flexDirection="column">
              {block.lines.map((tl, ti) => (
                <TableLine key={ti} raw={tl} />
              ))}
            </Box>
          );
        }
        // The streaming cursor sits on the last line, only when it's prose.
        const cursor = withCursor && bi === lastBlock;
        return <Line key={bi} raw={block.raw} cursor={cursor} />;
      })}
    </Box>
  );
}
