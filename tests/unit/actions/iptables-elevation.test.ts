import { describe, expect, test } from 'bun:test';

import { systemIptablesList } from '../../../src/actions/builtin/system-iptables-list.ts';
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

describe('actions/system-iptables-list — elevation via ctx', () => {
  test('declares sudo as its default elevation (iptables needs root)', () => {
    expect(systemIptablesList.defaultElevation).toBe('sudo');
  });

  test('ctx.elevation=sudo produces a sudo -n inner command inside the ssh argv', () => {
    const argv = systemIptablesList.buildCommand({ environment: 'staging' }, ctx('sudo'));
    const joined = argv.join(' ');
    expect(argv[0]).toBe('ssh');
    expect(joined).toContain('sudo -n');
    expect(joined).toContain('iptables');
  });

  test('ctx.elevation=none produces NO sudo (the gate decides elevation, not the action body)', () => {
    const argv = systemIptablesList.buildCommand({ environment: 'staging' }, ctx('none'));
    expect(argv.join(' ')).not.toContain('sudo');
  });
});
