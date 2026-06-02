import { describe, expect, test } from 'bun:test';

import {
  elevateRemoteCommand,
  detectPermissionDenied,
  detectSudoPasswordRequired,
  type Elevation,
} from '../../../src/security/elevation.ts';

describe('security/elevation — elevateRemoteCommand', () => {
  test('none returns the command unchanged', () => {
    expect(elevateRemoteCommand(['docker', 'ps'], 'none')).toEqual(['docker', 'ps']);
  });

  test('sudo prepends sudo -n (non-interactive)', () => {
    expect(elevateRemoteCommand(['docker', 'ps'], 'sudo')).toEqual(['sudo', '-n', 'docker', 'ps']);
  });

  test('sudo is idempotent — never double-wraps an already-sudo command', () => {
    expect(elevateRemoteCommand(['sudo', '-n', 'docker', 'ps'], 'sudo')).toEqual([
      'sudo', '-n', 'docker', 'ps',
    ]);
    expect(elevateRemoteCommand(['sudo', 'docker', 'ps'], 'sudo')).toEqual(['sudo', 'docker', 'ps']);
  });

  test('an empty command is returned unchanged (caller handles the empty-argv refuse)', () => {
    expect(elevateRemoteCommand([], 'sudo')).toEqual([]);
  });

  test('idempotent against a full-path or upper-case sudo (no double-wrap)', () => {
    expect(elevateRemoteCommand(['/usr/bin/sudo', 'x'], 'sudo')).toEqual(['/usr/bin/sudo', 'x']);
    expect(elevateRemoteCommand(['/bin/sudo', '-n', 'x'], 'sudo')).toEqual(['/bin/sudo', '-n', 'x']);
    expect(elevateRemoteCommand(['SUDO', 'x'], 'sudo')).toEqual(['SUDO', 'x']);
  });

  test('does NOT treat a command merely CONTAINING sudo in its name as elevated', () => {
    // "pseudo" / "sudoku" must still get wrapped — only a real sudo token counts.
    expect(elevateRemoteCommand(['pseudo-tty', 'x'], 'sudo')).toEqual(['sudo', '-n', 'pseudo-tty', 'x']);
    expect(elevateRemoteCommand(['sudoku', 'x'], 'sudo')).toEqual(['sudo', '-n', 'sudoku', 'x']);
  });
});

describe('security/elevation — detectPermissionDenied', () => {
  test('matches common permission-boundary stderr on non-zero exit', () => {
    expect(detectPermissionDenied('permission denied', 1)).toBe(true);
    expect(detectPermissionDenied('Got permission denied while trying to connect to the Docker daemon socket', 1)).toBe(true);
    expect(detectPermissionDenied('must be root to run this', 1)).toBe(true);
    expect(detectPermissionDenied('Operation not permitted', 1)).toBe(true);
    expect(detectPermissionDenied('are you root?', 1)).toBe(true);
  });

  test('does NOT match on a zero exit even if the text appears', () => {
    expect(detectPermissionDenied('permission denied', 0)).toBe(false);
  });

  test('does NOT match unrelated errors', () => {
    expect(detectPermissionDenied('no such file or directory', 1)).toBe(false);
    expect(detectPermissionDenied('', 1)).toBe(false);
  });
});

describe('security/elevation — detectSudoPasswordRequired', () => {
  test('matches the sudo -n "needs a password / tty" signatures', () => {
    expect(detectSudoPasswordRequired('sudo: a password is required')).toBe(true);
    expect(detectSudoPasswordRequired('sudo: a terminal is required to read the password')).toBe(true);
    expect(detectSudoPasswordRequired('sudo: no tty present and no askpass program specified')).toBe(true);
  });

  test('does NOT match a successful or unrelated sudo stderr', () => {
    expect(detectSudoPasswordRequired('')).toBe(false);
    expect(detectSudoPasswordRequired('docker: command not found')).toBe(false);
  });
});
