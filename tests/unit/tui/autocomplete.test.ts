import { describe, expect, test } from 'bun:test';

import { slashCompletions } from '../../../src/tui/commands.ts';

describe('tui/commands — slashCompletions', () => {
  test('empty input returns nothing', () => {
    expect(slashCompletions('')).toEqual([]);
  });

  test('non-slash input returns nothing', () => {
    expect(slashCompletions('verifica memoria')).toEqual([]);
  });

  test('bare slash returns all commands', () => {
    const out = slashCompletions('/');
    expect(out.length).toBeGreaterThan(5);
    expect(out.some((c) => c.command === '/help')).toBe(true);
    expect(out.some((c) => c.command === '/quit')).toBe(true);
  });

  test('"/se" prioritises /session-report', () => {
    const out = slashCompletions('/se');
    expect(out[0]?.command.startsWith('/session-report')).toBe(true);
  });

  test('"/env" lists all env subcommands', () => {
    const out = slashCompletions('/env');
    const names = out.map((c) => c.command);
    expect(names.some((n) => n.startsWith('/env add'))).toBe(true);
    expect(names.some((n) => n.startsWith('/env list'))).toBe(true);
    expect(names.some((n) => n.startsWith('/env remove'))).toBe(true);
  });

  test('"/q" matches /quit', () => {
    const out = slashCompletions('/q');
    expect(out[0]?.command).toBe('/quit');
  });

  test('"/annex" is listed', () => {
    const out = slashCompletions('/an');
    expect(out.some((c) => c.command.startsWith('/annex'))).toBe(true);
  });

  test('"/resume" is listed', () => {
    const out = slashCompletions('/re');
    expect(out.some((c) => c.command === '/resume')).toBe(true);
  });
});
