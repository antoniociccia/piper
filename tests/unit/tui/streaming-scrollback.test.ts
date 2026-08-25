import { describe, expect, test } from 'bun:test';

import { INITIAL_STATE, reducer, type State } from '../../../src/tui/App.tsx';
import type { ChatEntry } from '../../../src/tui/types.ts';

/**
 * A streamed report used to accumulate in the DYNAMIC region and only land in
 * scrollback once verification decided its fate. That let a rejected draft
 * disappear cleanly — but it also meant Ink repainted the entire growing report
 * on every token, which is the flicker the terminal shows while PIPER writes.
 *
 * Lines now go into scrollback as they complete, append-only, the way the rest
 * of the transcript already works. Only the in-flight partial line stays live.
 * A rejected draft therefore stays on screen, and is labelled as rejected
 * rather than silently vanishing — the reader sees what the model said AND that
 * the gate refused it.
 */

const kinds = (entries: readonly ChatEntry[]): string[] => entries.map((e) => e.kind);

function streamOf(lines: readonly string[]): State {
  let state = reducer(INITIAL_STATE, { type: 'stream-begin' });
  for (const line of lines) {
    state = reducer(state, { type: 'stream-line-complete', line });
  }
  return state;
}

describe('streamed reports append to scrollback', () => {
  test('a completed line lands in scrollback immediately', () => {
    const state = streamOf(['Disk is at 38% [ev-1].']);
    expect(kinds(state.entries)).toEqual(['report-start', 'report-line']);
    const line = state.entries[1];
    expect(line?.kind === 'report-line' && line.text).toBe('Disk is at 38% [ev-1].');
  });

  test('completed lines reach scrollback while the partial stays separate', () => {
    let state = streamOf(['first line of the report', 'second line of the report']);
    state = reducer(state, { type: 'stream-set-partial', partial: 'third line so' });

    // Both completed lines are already permanent…
    const texts = state.entries
      .filter((e): e is Extract<ChatEntry, { kind: 'report-line' }> => e.kind === 'report-line')
      .map((e) => e.text);
    expect(texts).toEqual(['first line of the report', 'second line of the report']);

    // …and the in-flight line is the only thing left to repaint.
    expect(state.streamingPartial).toBe('third line so');

    // `streamingLines` survives purely to assemble the markdown on commit; it
    // is deliberately not what the view renders.
    expect(state.streamingLines.length).toBe(2);
  });

  test('commit closes the block without re-emitting the report', () => {
    let state = streamOf(['Redis exited 137 [ev-8].']);
    state = reducer(state, { type: 'stream-commit', verified: true });

    expect(kinds(state.entries)).toEqual(['report-start', 'report-line', 'report-end']);
    // A `report` entry here would print the whole thing a second time.
    expect(kinds(state.entries)).not.toContain('report');
    expect(state.streamingActive).toBe(false);
    expect(state.streamingPartial).toBe('');
  });

  test('the closing entry carries the full markdown so /save still works', () => {
    let state = streamOf(['line one', 'line two']);
    state = reducer(state, { type: 'stream-commit', verified: true });

    const end = state.entries.at(-1);
    expect(end?.kind).toBe('report-end');
    expect(end?.kind === 'report-end' && end.markdown).toBe('line one\nline two');
    expect(end?.kind === 'report-end' && end.verified).toBe(true);
  });

  test('an unverified final answer is still committed, and marked', () => {
    let state = streamOf(['a claim with no citation at all']);
    state = reducer(state, { type: 'stream-commit', verified: false });

    const end = state.entries.at(-1);
    expect(end?.kind === 'report-end' && end.verified).toBe(false);
  });
});

describe('a rejected draft is labelled, not erased', () => {
  test('discard leaves the lines and appends a marker', () => {
    let state = streamOf(['an ungrounded claim about the host']);
    const beforeDiscard = state.entries.length;
    state = reducer(state, { type: 'stream-discard' });

    // The lines are already in scrollback and Ink's Static contract forbids
    // removing them, so the honest move is to say what happened.
    expect(state.entries.length).toBeGreaterThan(beforeDiscard);
    const marker = state.entries.at(-1);
    expect(marker?.kind).toBe('info');
    expect(marker?.kind === 'info' && marker.text.toLowerCase()).toMatch(/reject|ungrounded|rewrit/);
  });

  test('discard ends the stream so the retry starts a fresh block', () => {
    let state = streamOf(['an ungrounded claim about the host']);
    state = reducer(state, { type: 'stream-discard' });
    expect(state.streamingActive).toBe(false);
    expect(state.streamingPartial).toBe('');

    state = reducer(state, { type: 'stream-begin' });
    expect(state.streamingActive).toBe(true);
    expect(state.entries.at(-1)?.kind).toBe('report-start');
  });
});

/**
 * A markdown table is re-rendered as an aligned box, and the column widths
 * depend on every row — so unlike prose it cannot be emitted a row at a time.
 * Rows are held back until the table ends, then land as one entry.
 */
describe('tables are buffered until they can be aligned', () => {
  const rows = [
    '| Container | Status |',
    '|---|---|',
    '| orderly-redis-1 | Exited (137) |',
  ];

  test('rows produce no entries while the table is still arriving', () => {
    let state = reducer(INITIAL_STATE, { type: 'stream-begin' });
    for (const line of rows) {
      state = reducer(state, { type: 'stream-line-complete', line });
    }
    expect(kinds(state.entries)).toEqual(['report-start']);
    expect(state.pendingTable.length).toBe(3);
  });

  test('the table lands as one aligned entry when prose follows', () => {
    let state = reducer(INITIAL_STATE, { type: 'stream-begin' });
    for (const line of rows) {
      state = reducer(state, { type: 'stream-line-complete', line });
    }
    state = reducer(state, { type: 'stream-line-complete', line: 'Redis was OOM-killed [ev-8].' });

    expect(kinds(state.entries)).toEqual(['report-start', 'report-table', 'report-line']);
    const table = state.entries[1];
    expect(table?.kind === 'report-table' && table.lines.some((l) => l.includes('│'))).toBe(true);
    expect(state.pendingTable.length).toBe(0);
  });

  test('a table that ends the report is flushed on commit', () => {
    let state = reducer(INITIAL_STATE, { type: 'stream-begin' });
    for (const line of rows) {
      state = reducer(state, { type: 'stream-line-complete', line });
    }
    state = reducer(state, { type: 'stream-commit', verified: true });

    expect(kinds(state.entries)).toEqual(['report-start', 'report-table', 'report-end']);
  });

  test('rows that never formed a valid table are still shown, not swallowed', () => {
    let state = reducer(INITIAL_STATE, { type: 'stream-begin' });
    state = reducer(state, { type: 'stream-line-complete', line: '| a stray pipe line' });
    state = reducer(state, { type: 'stream-commit', verified: true });

    const texts = state.entries
      .filter((e): e is Extract<ChatEntry, { kind: 'report-line' }> => e.kind === 'report-line')
      .map((e) => e.text);
    expect(texts).toEqual(['| a stray pipe line']);
  });

  test('the saved markdown keeps the original rows, not the aligned box', () => {
    let state = reducer(INITIAL_STATE, { type: 'stream-begin' });
    for (const line of rows) {
      state = reducer(state, { type: 'stream-line-complete', line });
    }
    state = reducer(state, { type: 'stream-commit', verified: true });

    const end = state.entries.at(-1);
    expect(end?.kind === 'report-end' && end.markdown).toBe(rows.join('\n'));
  });
});
