import { describe, expect, test } from 'bun:test';

import { dockerComposeLs } from '../../../src/actions/builtin/docker-compose-ls.ts';
import type { ActionExecContext } from '../../../src/actions/types.ts';
import type { Environment } from '../../../src/environments/types.ts';

const ENV = { name: 'demo', host: 'h', sshUser: 'deploy', tags: [] } as Environment;
const ctx = (elevation: 'none' | 'sudo'): ActionExecContext =>
  ({ sessionId: 's' as ActionExecContext['sessionId'], environment: ENV, elevation });

describe('docker.compose_ls', () => {
  test('is a read action running `docker compose ls`', () => {
    expect(dockerComposeLs.tier).toBe('read');
    const cmd = dockerComposeLs.buildCommand({ environment: 'demo' }, ctx('none')).join(' ');
    expect(cmd).toContain('docker compose ls');
  });
  test('honors ctx.elevation', () => {
    const cmd = dockerComposeLs.buildCommand({ environment: 'demo' }, ctx('sudo')).join(' ');
    expect(cmd).toContain('sudo -n');
  });
  test('parseResult returns the trimmed raw output', () => {
    const r = dockerComposeLs.parseResult(
      { stdout: 'NAME    STATUS\norderly running(4)\n', stderr: '', exitCode: 0 },
      { environment: 'demo' },
    );
    expect(r.raw).toContain('orderly');
  });
});
