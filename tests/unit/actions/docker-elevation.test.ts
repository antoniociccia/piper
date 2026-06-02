import { describe, expect, test } from 'bun:test';

import { dockerComposePs } from '../../../src/actions/builtin/docker-compose-ps.ts';
import { dockerInspect } from '../../../src/actions/builtin/docker-inspect.ts';
import { dockerLogs } from '../../../src/actions/builtin/docker-logs.ts';
import { dockerPs } from '../../../src/actions/builtin/docker-ps.ts';
import type { ActionExecContext } from '../../../src/actions/types.ts';
import type { Environment } from '../../../src/environments/types.ts';

const ENV = { name: 'staging', host: 'h', sshUser: 'deploy', tags: [] } as Environment;
const ctx = (elevation: 'none' | 'sudo'): ActionExecContext =>
  ({ sessionId: 's' as ActionExecContext['sessionId'], environment: ENV, elevation });

describe('docker actions honor ctx.elevation', () => {
  test('compose_ps with elevation=sudo carries sudo -n; with none it does not', () => {
    const args = { environment: 'staging', project_dir: '/opt/app' };
    const sudo = dockerComposePs.buildCommand(args, ctx('sudo')).join(' ');
    expect(sudo).toContain('sudo -n');
    expect(sudo).toContain('docker compose');
    const none = dockerComposePs.buildCommand(args, ctx('none')).join(' ');
    expect(none).not.toContain('sudo');
  });

  test('ps with elevation=sudo carries sudo -n; with none it does not', () => {
    const args = { environment: 'staging' };
    expect(dockerPs.buildCommand(args, ctx('sudo')).join(' ')).toContain('sudo -n');
    expect(dockerPs.buildCommand(args, ctx('none')).join(' ')).not.toContain('sudo');
  });

  test('logs with elevation=sudo carries sudo -n; with none it does not', () => {
    const args = { environment: 'staging', container: 'web' };
    expect(dockerLogs.buildCommand(args, ctx('sudo')).join(' ')).toContain('sudo -n');
    expect(dockerLogs.buildCommand(args, ctx('none')).join(' ')).not.toContain('sudo');
  });

  test('inspect with elevation=sudo carries sudo -n; with none it does not', () => {
    const args = { environment: 'staging', container: 'web' };
    expect(dockerInspect.buildCommand(args, ctx('sudo')).join(' ')).toContain('sudo -n');
    expect(dockerInspect.buildCommand(args, ctx('none')).join(' ')).not.toContain('sudo');
  });
});
