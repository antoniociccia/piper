import { describe, expect, test } from 'bun:test';

import { classifyLine, splitInline } from '../../../src/tui/report-markdown.ts';

describe('tui/report-markdown — splitInline', () => {
  test('plain text is one plain segment', () => {
    expect(splitInline('hello world')).toEqual([{ kind: 'plain', text: 'hello world' }]);
  });

  test('bold, code, and citations are tagged; surrounding text preserved', () => {
    const segs = splitInline('see **the db** in `docker ps` [ev-3] now');
    expect(segs).toEqual([
      { kind: 'plain', text: 'see ' },
      { kind: 'bold', text: 'the db' },
      { kind: 'plain', text: ' in ' },
      { kind: 'code', text: 'docker ps' },
      { kind: 'plain', text: ' ' },
      { kind: 'citation', text: '[ev-3]' },
      { kind: 'plain', text: ' now' },
    ]);
  });

  test('an unmatched asterisk run stays plain', () => {
    expect(splitInline('2 * 3 = 6')).toEqual([{ kind: 'plain', text: '2 * 3 = 6' }]);
  });

  test('empty string yields no segments', () => {
    expect(splitInline('')).toEqual([]);
  });
});

describe('tui/report-markdown — classifyLine', () => {
  test('blank lines are blank', () => {
    expect(classifyLine('')).toEqual({ kind: 'blank' });
    expect(classifyLine('   ')).toEqual({ kind: 'blank' });
  });

  test('headings strip the hashes and keep inline styling', () => {
    expect(classifyLine('## Diagnosis')).toEqual({
      kind: 'heading',
      segments: [{ kind: 'plain', text: 'Diagnosis' }],
    });
    expect(classifyLine('# **Root cause**')).toEqual({
      kind: 'heading',
      segments: [{ kind: 'bold', text: 'Root cause' }],
    });
  });

  test('four-plus hashes are NOT a heading (markdown caps at h3 here)', () => {
    expect(classifyLine('#### too deep').kind).toBe('text');
  });

  test('dash and star bullets become bullet nodes', () => {
    expect(classifyLine('- first').kind).toBe('bullet');
    expect(classifyLine('  * indented').kind).toBe('bullet');
    expect(classifyLine('- the `db` is down')).toEqual({
      kind: 'bullet',
      segments: [
        { kind: 'plain', text: 'the ' },
        { kind: 'code', text: 'db' },
        { kind: 'plain', text: ' is down' },
      ],
    });
  });

  test('ordered list items stay plain text (not bullets)', () => {
    expect(classifyLine('1. first step').kind).toBe('text');
  });

  test('plain prose is text', () => {
    expect(classifyLine('The container exited.').kind).toBe('text');
  });
});

import { groupBlocks, renderAlignedTable, parseTableBlock } from '../../../src/tui/report-markdown.ts';

describe('tui/report-markdown — table detection & alignment', () => {
  const TABLE = [
    '| Risorsa | Totale | Utilizzato |',
    '|---------|--------|------------|',
    '| Memoria RAM | 7.5Gi | 2.2Gi |',
    '| Disco (/) | 75G | 11G |',
  ];

  test('parseTableBlock parses header + rows, ignoring the separator', () => {
    const t = parseTableBlock(TABLE);
    expect(t).not.toBeNull();
    expect(t?.headers).toEqual(['Risorsa', 'Totale', 'Utilizzato']);
    expect(t?.rows).toEqual([
      ['Memoria RAM', '7.5Gi', '2.2Gi'],
      ['Disco (/)', '75G', '11G'],
    ]);
  });

  test('a block without a separator row is NOT a table', () => {
    expect(parseTableBlock(['| a | b |', '| c | d |'])).toBeNull();
  });

  test('renderAlignedTable pads every column to its widest cell (monospace alignment)', () => {
    const lines = renderAlignedTable(parseTableBlock(TABLE)!);
    // every rendered line must have identical visible width (true alignment)
    const widths = new Set(lines.map((l) => l.length));
    expect(widths.size).toBe(1);
    // the "Memoria RAM" cell (widest in col 0) sets the column width; "Disco (/)" is padded
    const dataLine = lines.find((l) => l.includes('Disco'));
    const ramLine = lines.find((l) => l.includes('Memoria RAM'));
    expect(dataLine?.indexOf('│', 1)).toBe(ramLine?.indexOf('│', 1)); // second column border aligns
    expect(lines[0]).toContain('┌');
    expect(lines.at(-1)).toContain('└');
  });

  test('groupBlocks separates prose lines from a contiguous table block', () => {
    const blocks = groupBlocks([
      'Here are the metrics:',
      ...TABLE,
      'No swap configured.',
    ]);
    expect(blocks[0]).toEqual({ kind: 'line', raw: 'Here are the metrics:' });
    expect(blocks[1]?.kind).toBe('table');
    expect(blocks[2]).toEqual({ kind: 'line', raw: 'No swap configured.' });
  });

  test('groupBlocks leaves a lone pipe-prose line as text (no false table)', () => {
    const blocks = groupBlocks(['use a | b shell pipe here']);
    expect(blocks[0]?.kind).toBe('line');
  });
});
