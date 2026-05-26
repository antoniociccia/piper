import { describe, expect, test } from 'bun:test';

import { createLogger, type Level } from '../../../src/logging/logger.ts';

interface CapturedEvent {
  readonly ts: string;
  readonly level: Level;
  readonly msg: string;
  readonly [key: string]: unknown;
}

function makeCapture(): {
  lines: string[];
  events: CapturedEvent[];
  destination: (line: string) => void;
} {
  const lines: string[] = [];
  const events: CapturedEvent[] = [];
  const destination = (line: string): void => {
    lines.push(line);
    const trimmed = line.endsWith('\n') ? line.slice(0, -1) : line;
    events.push(JSON.parse(trimmed) as CapturedEvent);
  };
  return { lines, events, destination };
}

describe('logging/logger — levels', () => {
  test('each level emits with the correct level field', () => {
    const { events, destination } = makeCapture();
    const logger = createLogger({ level: 'debug', destination });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(events.map((e) => e.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });

  test('warn-level logger drops debug and info', () => {
    const { events, destination } = makeCapture();
    const logger = createLogger({ level: 'warn', destination });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(events.map((e) => e.level)).toEqual(['warn', 'error']);
  });

  test('error-level logger only emits error', () => {
    const { events, destination } = makeCapture();
    const logger = createLogger({ level: 'error', destination });
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    expect(events.map((e) => e.level)).toEqual(['error']);
  });
});

describe('logging/logger — scrubbing', () => {
  test('msg is scrubbed before emission', () => {
    const { events, destination } = makeCapture();
    const logger = createLogger({ destination });
    logger.info('leaked sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA token');
    expect(events[0]?.msg).toContain('[REDACTED:anthropic-key]');
    expect(events[0]?.msg).not.toContain('sk-ant-api03');
  });

  test('string values in ctx are scrubbed', () => {
    const { events, destination } = makeCapture();
    const logger = createLogger({ destination });
    logger.info('connecting', { dsn: 'postgresql://alice:hunter2@db:5432/app' });
    expect(events[0]?.dsn).toBe('postgresql://alice:[REDACTED:connection-string]@db:5432/app');
  });

  test('non-string ctx values pass through untouched', () => {
    const { events, destination } = makeCapture();
    const logger = createLogger({ destination });
    logger.info('payload', {
      n: 42,
      b: true,
      o: { nested: 'value' },
      a: [1, 2, 3],
      nil: null,
    });
    expect(events[0]?.n).toBe(42);
    expect(events[0]?.b).toBe(true);
    expect(events[0]?.o).toEqual({ nested: 'value' });
    expect(events[0]?.a).toEqual([1, 2, 3]);
    expect(events[0]?.nil).toBeNull();
  });

  test('scrubUserPatterns is honored', () => {
    const { events, destination } = makeCapture();
    const logger = createLogger({
      destination,
      scrubUserPatterns: [/CASE-\d+/g],
    });
    logger.info('processing CASE-12345 record');
    expect(events[0]?.msg).toBe('processing [REDACTED:user] record');
  });
});

describe('logging/logger — bindings and child', () => {
  test('bindings appear on every event', () => {
    const { events, destination } = makeCapture();
    const logger = createLogger({ destination, bindings: { session_id: 's1' } });
    logger.info('one');
    logger.warn('two');
    expect(events[0]?.session_id).toBe('s1');
    expect(events[1]?.session_id).toBe('s1');
  });

  test('child merges bindings into emitted events', () => {
    const { events, destination } = makeCapture();
    const base = createLogger({ destination, bindings: { session_id: 's1' } });
    const child = base.child({ action_name: 'system.uptime' });
    child.info('starting');
    expect(events[0]?.session_id).toBe('s1');
    expect(events[0]?.action_name).toBe('system.uptime');
  });

  test('nested child(child(...)) composes', () => {
    const { events, destination } = makeCapture();
    const base = createLogger({ destination, bindings: { a: 1 } });
    const c1 = base.child({ b: 2 });
    const c2 = c1.child({ c: 3 });
    c2.info('nested');
    expect(events[0]?.a).toBe(1);
    expect(events[0]?.b).toBe(2);
    expect(events[0]?.c).toBe(3);
  });

  test('child inherits level configuration', () => {
    const { events, destination } = makeCapture();
    const base = createLogger({ destination, level: 'warn' });
    const child = base.child({ tag: 't' });
    child.debug('d');
    child.info('i');
    child.warn('w');
    expect(events.map((e) => e.level)).toEqual(['warn']);
  });

  test('ctx overrides bindings on key collision', () => {
    const { events, destination } = makeCapture();
    const logger = createLogger({ destination, bindings: { phase: 'init' } });
    logger.info('event', { phase: 'gather' });
    expect(events[0]?.phase).toBe('gather');
  });
});

describe('logging/logger — output shape', () => {
  test('ts is a valid ISO 8601 timestamp', () => {
    const { events, destination } = makeCapture();
    const logger = createLogger({ destination });
    logger.info('t');
    const ts = events[0]?.ts ?? '';
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
  });

  test('destination receives one JSON-parsable line per event, newline-terminated', () => {
    const { lines, destination } = makeCapture();
    const logger = createLogger({ destination });
    logger.info('a');
    logger.warn('b');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(line.slice(0, -1))).not.toThrow();
    }
  });

  test('msg, level, and ts always present', () => {
    const { events, destination } = makeCapture();
    const logger = createLogger({ destination });
    logger.info('hello');
    const event = events[0];
    expect(event).toBeDefined();
    expect(event?.msg).toBe('hello');
    expect(event?.level).toBe('info');
    expect(typeof event?.ts).toBe('string');
  });
});
