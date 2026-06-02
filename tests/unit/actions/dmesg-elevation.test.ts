import { describe, expect, test } from 'bun:test';

import { systemDmesg } from '../../../src/actions/builtin/system-dmesg.ts';
import type { ActionExecContext } from '../../../src/actions/types.ts';
import type { Environment } from '../../../src/environments/types.ts';

const ENV: Environment = {
  name: 'staging',
  host: 'staging.example.com',
  sshUser: 'deploy',
  tags: [],
};

function ctx(elevation: 'none' | 'sudo'): ActionExecContext {
  return { sessionId: 's' as ActionExecContext['sessionId'], environment: ENV, elevation };
}

describe('actions/system-dmesg — elevation via ctx', () => {
  test('defaultElevation is none (dmesg is often readable unprivileged)', () => {
    expect(systemDmesg.defaultElevation).toBe('none');
  });

  test('ctx.elevation=sudo → argv contains sudo -n and dmesg', () => {
    const argv = systemDmesg.buildCommand({ environment: 'staging' }, ctx('sudo'));
    const joined = argv.join(' ');
    expect(argv[0]).toBe('ssh');
    expect(joined).toContain('sudo -n');
    expect(joined).toContain('dmesg');
  });

  test('ctx.elevation=none → no sudo in argv', () => {
    const argv = systemDmesg.buildCommand({ environment: 'staging' }, ctx('none'));
    expect(argv.join(' ')).not.toContain('sudo');
  });

  test('built command does NOT contain 2>/dev/null (must let stderr through for reactive sudo detection)', () => {
    const argv = systemDmesg.buildCommand({ environment: 'staging' }, ctx('none'));
    expect(argv.join(' ')).not.toContain('2>/dev/null');
  });

  test('built command does NOT contain | tail (trimming must happen in parseResult)', () => {
    const argv = systemDmesg.buildCommand({ environment: 'staging' }, ctx('none'));
    expect(argv.join(' ')).not.toContain('| tail');
  });

  test('built command does NOT contain || echo (must let real exit code surface)', () => {
    const argv = systemDmesg.buildCommand({ environment: 'staging' }, ctx('none'));
    expect(argv.join(' ')).not.toContain('|| echo');
  });

  test('parseResult trims to the last N lines when lines arg is specified', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    const result = systemDmesg.parseResult(
      { stdout: lines, stderr: '', exitCode: 0 },
      { environment: 'staging', lines: 3 },
    );
    expect(result.raw).toBe('line8\nline9\nline10');
  });

  test('parseResult uses default 100 lines when lines arg is omitted', () => {
    // 150 lines of output → only last 100 returned
    const allLines = Array.from({ length: 150 }, (_, i) => `line${i + 1}`).join('\n');
    const result = systemDmesg.parseResult(
      { stdout: allLines, stderr: '', exitCode: 0 },
      { environment: 'staging' },
    );
    const returned = result.raw.split('\n');
    expect(returned.length).toBe(100);
    expect(returned[0]).toBe('line51');
    expect(returned[99]).toBe('line150');
  });

  test('parseResult returns all lines when output is fewer than N', () => {
    const lines = 'lineA\nlineB\nlineC';
    const result = systemDmesg.parseResult(
      { stdout: lines, stderr: '', exitCode: 0 },
      { environment: 'staging', lines: 10 },
    );
    expect(result.raw).toBe('lineA\nlineB\nlineC');
  });
});
