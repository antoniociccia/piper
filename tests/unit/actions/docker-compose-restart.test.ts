import { describe, expect, test } from 'bun:test';

import { dockerComposeRestart } from '../../../src/actions/builtin/docker-compose-restart.ts';
import type { ActionExecContext } from '../../../src/actions/types.ts';
import type { Environment } from '../../../src/environments/types.ts';

const ENV = { name: 'staging', host: 'h', sshUser: 'deploy', tags: [] } as Environment;
const ctx = (elevation: 'none' | 'sudo'): ActionExecContext =>
  ({ sessionId: 's' as ActionExecContext['sessionId'], environment: ENV, elevation });
const args = { environment: 'staging', project_dir: '/opt/app' };

describe('docker.compose_restart', () => {
  test('is a mutate action that runs `docker compose restart`', () => {
    expect(dockerComposeRestart.tier).toBe('mutate');
    expect(dockerComposeRestart.buildCommand(args, ctx('none')).join(' ')).toContain('restart');
  });
  test('honors ctx.elevation (sudo)', () => {
    expect(dockerComposeRestart.buildCommand(args, ctx('sudo')).join(' ')).toContain('sudo -n');
    expect(dockerComposeRestart.buildCommand(args, ctx('none')).join(' ')).not.toContain('sudo');
  });
  test('snapshot + verify are read-only ps probes; rollback brings the stack back up', () => {
    expect(dockerComposeRestart.buildSnapshotCommand?.(args, ctx('none'))?.join(' ')).toContain('ps');
    expect(dockerComposeRestart.buildVerifyCommand?.(args, ctx('none'))?.join(' ')).toContain('ps');
    expect(dockerComposeRestart.buildRollbackCommand?.(args, ctx('none'), '')?.join(' ')).toContain('up');
  });
  test('restarts a single service when service is set', () => {
    const withSvc = { ...args, service: 'backend' };
    expect(dockerComposeRestart.buildCommand(withSvc, ctx('none')).join(' ')).toContain('backend');
  });
});
