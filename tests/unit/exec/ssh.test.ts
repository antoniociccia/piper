import { describe, expect, test } from 'bun:test';

import { buildSshArgv, InvalidSshOptionsError } from '../../../src/exec/ssh.ts';

describe('exec/ssh — buildSshArgv', () => {
  test('basic single-arg command produces expected argv', () => {
    const argv = buildSshArgv({ host: 'user@h', command: ['true'] });
    expect(argv).toEqual([
      'ssh',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=5',
      'user@h',
      'true',
    ]);
  });

  test('multi-arg command is shell-quoted into a single remote string', () => {
    const argv = buildSshArgv({ host: 'h', command: ['tail', '-n', '100', '/var/log/app.log'] });
    expect(argv[argv.length - 1]).toBe('tail -n 100 /var/log/app.log');
  });

  test('args with spaces get single-quoted', () => {
    const argv = buildSshArgv({ host: 'h', command: ['cat', '/var/log/my app/log.txt'] });
    expect(argv[argv.length - 1]).toBe(`cat '/var/log/my app/log.txt'`);
  });

  test('args with single quotes get escaped using POSIX standard', () => {
    const argv = buildSshArgv({ host: 'h', command: ['echo', "it's"] });
    expect(argv[argv.length - 1]).toBe(`echo 'it'\\''s'`);
  });

  test('args with shell metacharacters get fully quoted', () => {
    const argv = buildSshArgv({ host: 'h', command: ['grep', 'foo|bar; rm -rf /'] });
    expect(argv[argv.length - 1]).toContain(`'foo|bar; rm -rf /'`);
  });

  test('custom connectTimeoutSec replaces the default', () => {
    const argv = buildSshArgv({ host: 'h', command: ['true'], connectTimeoutSec: 10 });
    expect(argv).toContain('ConnectTimeout=10');
    expect(argv).not.toContain('ConnectTimeout=5');
  });

  test('port adds -p flag', () => {
    const argv = buildSshArgv({ host: 'h', command: ['true'], port: 2222 });
    const portIndex = argv.indexOf('-p');
    expect(portIndex).toBeGreaterThanOrEqual(0);
    expect(argv[portIndex + 1]).toBe('2222');
  });

  test('port is absent when not specified', () => {
    const argv = buildSshArgv({ host: 'h', command: ['true'] });
    expect(argv).not.toContain('-p');
  });

  test('BatchMode=yes is always present — no password prompts can occur', () => {
    const argv = buildSshArgv({ host: 'h', command: ['true'] });
    expect(argv).toContain('BatchMode=yes');
  });

  test('StrictHostKeyChecking=accept-new is always present', () => {
    const argv = buildSshArgv({ host: 'h', command: ['true'] });
    expect(argv).toContain('StrictHostKeyChecking=accept-new');
  });

  test('the host appears before the remote command', () => {
    const argv = buildSshArgv({ host: 'myhost', command: ['echo', 'x'] });
    const hostIdx = argv.indexOf('myhost');
    const lastIdx = argv.length - 1;
    expect(hostIdx).toBeGreaterThan(0);
    expect(hostIdx).toBeLessThan(lastIdx);
  });

  test('user@host is preserved verbatim', () => {
    const argv = buildSshArgv({ host: 'deploy@prod-1.internal', command: ['true'] });
    expect(argv).toContain('deploy@prod-1.internal');
  });

  test('empty command throws InvalidSshOptionsError', () => {
    expect(() => buildSshArgv({ host: 'h', command: [] })).toThrow(InvalidSshOptionsError);
  });

  test('empty host throws', () => {
    expect(() => buildSshArgv({ host: '', command: ['true'] })).toThrow(InvalidSshOptionsError);
  });

  test('whitespace-only host throws', () => {
    expect(() => buildSshArgv({ host: '   ', command: ['true'] })).toThrow(InvalidSshOptionsError);
  });

  test('non-positive connectTimeoutSec throws', () => {
    expect(() => buildSshArgv({ host: 'h', command: ['true'], connectTimeoutSec: 0 })).toThrow(
      InvalidSshOptionsError,
    );
    expect(() => buildSshArgv({ host: 'h', command: ['true'], connectTimeoutSec: -1 })).toThrow(
      InvalidSshOptionsError,
    );
  });

  test('port out of range throws', () => {
    expect(() => buildSshArgv({ host: 'h', command: ['true'], port: 0 })).toThrow(
      InvalidSshOptionsError,
    );
    expect(() => buildSshArgv({ host: 'h', command: ['true'], port: 70000 })).toThrow(
      InvalidSshOptionsError,
    );
    expect(() => buildSshArgv({ host: 'h', command: ['true'], port: 2222.5 })).toThrow(
      InvalidSshOptionsError,
    );
  });
});
