import { describe, expect, test } from 'bun:test';

import {
  countMessagesTokens,
  countTokens,
  formatTokenCount,
  formatTokenLimit,
} from '../../../src/agent/token-counter.ts';

describe('agent/token-counter — countTokens', () => {
  test('empty string is zero', () => {
    expect(countTokens('')).toBe(0);
  });

  test('"hello world" is around 2 tokens', () => {
    expect(countTokens('hello world')).toBeLessThanOrEqual(3);
    expect(countTokens('hello world')).toBeGreaterThan(0);
  });

  test('token count scales (roughly) with text length', () => {
    const short = countTokens('one short sentence.');
    const long = countTokens('one short sentence. '.repeat(20));
    expect(long).toBeGreaterThan(short * 10);
  });

  test('deterministic for the same input', () => {
    expect(countTokens('check uptime on staging')).toBe(countTokens('check uptime on staging'));
  });
});

describe('agent/token-counter — countMessagesTokens', () => {
  test('counts role overhead per message', () => {
    const one = countMessagesTokens([{ role: 'user', content: 'hi' }]);
    const two = countMessagesTokens([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(two).toBeGreaterThan(one);
  });

  test('tool definitions add overhead', () => {
    const noTools = countMessagesTokens([{ role: 'user', content: 'plan' }]);
    const withTools = countMessagesTokens([{ role: 'user', content: 'plan' }], [
      { name: 'foo', description: 'do foo', parameters: { type: 'object', properties: {} } },
      { name: 'bar', description: 'do bar', parameters: { type: 'object', properties: {} } },
    ]);
    expect(withTools).toBeGreaterThan(noTools + 20);
  });

  test('empty inputs return 0', () => {
    expect(countMessagesTokens([])).toBe(0);
  });
});

describe('agent/token-counter — formatters', () => {
  test('formatTokenCount uses raw under 1000', () => {
    expect(formatTokenCount(42)).toBe('42');
    expect(formatTokenCount(999)).toBe('999');
  });

  test('formatTokenCount uses thousands separator 1k..99.9k', () => {
    expect(formatTokenCount(12_345)).toBe('12,345');
  });

  test('formatTokenCount switches to "k" above 100k', () => {
    expect(formatTokenCount(123_456)).toBe('123k');
  });

  test('formatTokenCount switches to "M" above 1M', () => {
    expect(formatTokenCount(2_500_000)).toBe('2.5M');
  });

  test('formatTokenLimit produces "200k" / "1M"', () => {
    expect(formatTokenLimit(200_000)).toBe('200k');
    expect(formatTokenLimit(1_000_000)).toBe('1M');
  });
});
