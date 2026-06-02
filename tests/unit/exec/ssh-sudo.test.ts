import { describe, expect, test } from 'bun:test';

import { toInteractive } from '../../../src/exec/ssh.ts';

describe('exec/ssh — toInteractive (transform a non-interactive sudo argv into the interactive form)', () => {
  test('swaps -o BatchMode=yes for -tt and sudo -n for sudo in the remote command', () => {
    // A normal sudo -n ssh argv as produced by buildSshArgvForEnv + elevateRemoteCommand.
    const normal = [
      'ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=10', 'deploy@staging.example.com',
      'sh -c \'sudo -n iptables -L\'',
    ];
    const inter = toInteractive(normal);
    expect(inter).toContain('-tt');
    expect(inter.join(' ')).not.toContain('BatchMode=yes');
    expect(inter.join(' ')).toContain('sudo iptables -L'); // sudo -n → sudo
    expect(inter.join(' ')).not.toContain('sudo -n');
  });
  test('is a no-op-safe transform: an argv without BatchMode/sudo -n is returned with -tt added but otherwise intact', () => {
    const argv = ['ssh', 'deploy@host', 'sh -c \'whoami\''];
    const inter = toInteractive(argv);
    expect(inter).toContain('-tt');
    expect(inter.join(' ')).toContain('whoami');
  });

  test('rewrites ONLY the leading sudo -n of the remote command, not "sudo -n " appearing as data', () => {
    // The real invocation is `sudo -n grep …`; the grep PATTERN also contains
    // the literal "sudo -n " — only the leading invocation must be rewritten.
    const argv = [
      'ssh', '-o', 'BatchMode=yes', 'deploy@host',
      "sh -c 'sudo -n grep \"sudo -n \" /var/log/auth.log'",
    ];
    const remote = toInteractive(argv).at(-1) ?? '';
    expect(remote).toContain('sudo grep'); // leading invocation de-escalated
    expect(remote).toContain('"sudo -n "'); // the grep pattern data is preserved
  });

  test('does not touch a "sudo -n " substring living in an ssh OPTION value (only the last element)', () => {
    const argv = ['ssh', '-o', 'SetEnv=NOTE=sudo -n test', 'deploy@host', "sh -c 'whoami'"];
    const inter = toInteractive(argv);
    expect(inter.join(' ')).toContain('SetEnv=NOTE=sudo -n test'); // option untouched
  });
});
