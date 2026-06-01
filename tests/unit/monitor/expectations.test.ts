// tests/unit/monitor/expectations.test.ts
import { describe, expect, test } from 'bun:test';

import { evaluateExpectation } from '../../../src/monitor/expectations.ts';
import { parseIntervalMs, InvalidWatchPlanError, MIN_INTERVAL_MS, watchFrontmatterSchema } from '../../../src/monitor/types.ts';

describe('monitor/types — parseIntervalMs', () => {
  test('parses seconds, minutes, hours', () => {
    expect(parseIntervalMs('30s')).toBe(30_000);
    expect(parseIntervalMs('5m')).toBe(300_000);
    expect(parseIntervalMs('1h')).toBe(3_600_000);
  });

  test('rejects malformed intervals', () => {
    expect(() => parseIntervalMs('abc')).toThrow(InvalidWatchPlanError);
    expect(() => parseIntervalMs('30')).toThrow(InvalidWatchPlanError);
    expect(() => parseIntervalMs('-5s')).toThrow(InvalidWatchPlanError);
  });

  test('rejects intervals below the floor (10s)', () => {
    expect(() => parseIntervalMs('5s')).toThrow(InvalidWatchPlanError);
    expect(parseIntervalMs('10s')).toBe(MIN_INTERVAL_MS);
  });
});

describe('monitor/expectations — evaluateExpectation', () => {
  test('exit_zero passes on 0, fails otherwise', () => {
    expect(evaluateExpectation({ kind: 'exit_zero' }, { stdout: '', stderr: '', exitCode: 0 }).passed).toBe(true);
    const r = evaluateExpectation({ kind: 'exit_zero' }, { stdout: '', stderr: 'boom', exitCode: 1 });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('exit code 1');
  });

  test('all_running passes when every parsed item has state=running', () => {
    const parsed = [
      { name: 'web', state: 'running' },
      { name: 'db', state: 'running' },
    ];
    expect(
      evaluateExpectation({ kind: 'all_running' }, { stdout: '', stderr: '', exitCode: 0, parsed }).passed,
    ).toBe(true);
  });

  test('all_running fails and names the offender', () => {
    const parsed = [
      { name: 'web', state: 'running' },
      { name: 'db', state: 'exited' },
    ];
    const r = evaluateExpectation({ kind: 'all_running' }, { stdout: '', stderr: '', exitCode: 0, parsed });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('db');
    expect(r.detail).toContain('exited');
  });

  test('all_running fails when parsed output is missing or empty', () => {
    expect(
      evaluateExpectation({ kind: 'all_running' }, { stdout: '', stderr: '', exitCode: 0 }).passed,
    ).toBe(false);
    expect(
      evaluateExpectation({ kind: 'all_running' }, { stdout: '', stderr: '', exitCode: 0, parsed: [] }).passed,
    ).toBe(false);
  });

  test('max_percent scans stdout for the highest NN% and compares', () => {
    const stdout = 'Filesystem Use%\n/dev/sda1 42%\n/dev/sdb1 91%\n';
    const fail = evaluateExpectation({ kind: 'max_percent', value: 90 }, { stdout, stderr: '', exitCode: 0 });
    expect(fail.passed).toBe(false);
    expect(fail.detail).toContain('91');
    const pass = evaluateExpectation({ kind: 'max_percent', value: 95 }, { stdout, stderr: '', exitCode: 0 });
    expect(pass.passed).toBe(true);
  });

  test('max_percent fails closed when no percentage is found', () => {
    const r = evaluateExpectation({ kind: 'max_percent', value: 90 }, { stdout: 'no numbers here', stderr: '', exitCode: 0 });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('no percentage');
  });

  test('min_count counts parsed array items', () => {
    const parsed = [1, 2, 3];
    expect(evaluateExpectation({ kind: 'min_count', value: 3 }, { stdout: '', stderr: '', exitCode: 0, parsed }).passed).toBe(true);
    expect(evaluateExpectation({ kind: 'min_count', value: 4 }, { stdout: '', stderr: '', exitCode: 0, parsed }).passed).toBe(false);
  });

  test('min_count falls back to non-empty stdout lines when parsed is not an array', () => {
    const stdout = 'line1\nline2\n\n';
    expect(evaluateExpectation({ kind: 'min_count', value: 2 }, { stdout, stderr: '', exitCode: 0 }).passed).toBe(true);
    expect(evaluateExpectation({ kind: 'min_count', value: 3 }, { stdout, stderr: '', exitCode: 0 }).passed).toBe(false);
  });

  test('regex_match / regex_absent', () => {
    const stdout = 'service healthy\nuptime 4d';
    expect(evaluateExpectation({ kind: 'regex_match', pattern: 'healthy' }, { stdout, stderr: '', exitCode: 0 }).passed).toBe(true);
    expect(evaluateExpectation({ kind: 'regex_match', pattern: 'ERROR' }, { stdout, stderr: '', exitCode: 0 }).passed).toBe(false);
    expect(evaluateExpectation({ kind: 'regex_absent', pattern: 'ERROR' }, { stdout, stderr: '', exitCode: 0 }).passed).toBe(true);
    expect(evaluateExpectation({ kind: 'regex_absent', pattern: 'healthy' }, { stdout, stderr: '', exitCode: 0 }).passed).toBe(false);
  });

  test('regex with invalid pattern fails closed (does not throw)', () => {
    const r = evaluateExpectation({ kind: 'regex_match', pattern: '([unclosed' }, { stdout: 'x', stderr: '', exitCode: 0 });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('invalid pattern');
  });

  test('json_path_eq navigates dot paths into stdout JSON', () => {
    const stdout = JSON.stringify({ status: { healthy: true, replicas: 3 } });
    expect(
      evaluateExpectation({ kind: 'json_path_eq', path: 'status.healthy', value: true }, { stdout, stderr: '', exitCode: 0 }).passed,
    ).toBe(true);
    expect(
      evaluateExpectation({ kind: 'json_path_eq', path: 'status.replicas', value: 4 }, { stdout, stderr: '', exitCode: 0 }).passed,
    ).toBe(false);
  });

  test('json_path_eq fails closed on non-JSON stdout or missing path', () => {
    expect(
      evaluateExpectation({ kind: 'json_path_eq', path: 'a.b', value: 1 }, { stdout: 'not json', stderr: '', exitCode: 0 }).passed,
    ).toBe(false);
    const stdout = JSON.stringify({ a: {} });
    const r = evaluateExpectation({ kind: 'json_path_eq', path: 'a.b', value: 1 }, { stdout, stderr: '', exitCode: 0 });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('path not found');
  });

  test('json_path_eq does not traverse the prototype chain', () => {
    const stdout = JSON.stringify({});
    const proto = evaluateExpectation({ kind: 'json_path_eq', path: '__proto__', value: 'x' }, { stdout, stderr: '', exitCode: 0 });
    expect(proto.passed).toBe(false);
    expect(proto.detail).toContain('path not found');
    const ctor = evaluateExpectation({ kind: 'json_path_eq', path: 'constructor', value: 'x' }, { stdout, stderr: '', exitCode: 0 });
    expect(ctor.passed).toBe(false);
  });
});

describe('monitor/types — frontmatter schema interval floor', () => {
  test('watchFrontmatterSchema rejects sub-floor intervals', () => {
    const result = watchFrontmatterSchema.safeParse({
      name: 'x',
      description: 'd',
      environment: 'staging',
      checks: [{ action: 'a.b', expect: { kind: 'exit_zero' }, every: '5s' }],
    });
    expect(result.success).toBe(false);
  });

  test('watchFrontmatterSchema accepts intervals at or above the floor', () => {
    const result = watchFrontmatterSchema.safeParse({
      name: 'x',
      description: 'd',
      environment: 'staging',
      checks: [{ action: 'a.b', expect: { kind: 'exit_zero' }, every: '10s' }],
    });
    expect(result.success).toBe(true);
  });
});
