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
