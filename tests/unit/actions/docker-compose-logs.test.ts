import { describe, expect, test } from 'bun:test';

import { dockerComposeLogs } from '../../../src/actions/builtin/docker-compose-logs.ts';
import type { ActionExecContext } from '../../../src/actions/types.ts';
import type { Environment } from '../../../src/environments/types.ts';

const ENV = { name: 'demo', host: 'h', sshUser: 'deploy', tags: [] } as Environment;
const ctx = (elevation: 'none' | 'sudo'): ActionExecContext =>
  ({ sessionId: 's' as ActionExecContext['sessionId'], environment: ENV, elevation });

describe('docker.compose_logs', () => {
  test('tier is read', () => {
    expect(dockerComposeLogs.tier).toBe('read');
  });

  test('buildCommand contains docker compose, logs, --tail, and project_dir file path', () => {
    const cmd = dockerComposeLogs
      .buildCommand({ environment: 'demo', project_dir: '/opt/orderly' }, ctx('none'))
      .join(' ');
    expect(cmd).toContain('docker compose');
    expect(cmd).toContain('logs');
    expect(cmd).toContain('--tail');
    expect(cmd).toContain('/opt/orderly/docker-compose.yml');
  });

  test('default tail is 200 when not specified', () => {
    const cmd = dockerComposeLogs
      .buildCommand({ environment: 'demo', project_dir: '/opt/orderly' }, ctx('none'))
      .join(' ');
    expect(cmd).toContain('--tail 200');
  });

  test('custom tail is honored', () => {
    const cmd = dockerComposeLogs
      .buildCommand({ environment: 'demo', project_dir: '/opt/orderly', tail: 50 }, ctx('none'))
      .join(' ');
    expect(cmd).toContain('--tail 50');
  });

  test('service is appended when provided', () => {
    const cmd = dockerComposeLogs
      .buildCommand({ environment: 'demo', project_dir: '/opt/orderly', service: 'backend' }, ctx('none'))
      .join(' ');
    expect(cmd).toContain('backend');
  });

  test('honors ctx.elevation sudo', () => {
    const cmd = dockerComposeLogs
      .buildCommand({ environment: 'demo', project_dir: '/opt/orderly' }, ctx('sudo'))
      .join(' ');
    expect(cmd).toContain('sudo -n');
  });

  test('rejects a relative or traversal project_dir (must be absolute)', () => {
    expect(dockerComposeLogs.argsSchema.safeParse({ environment: 'demo', project_dir: '../etc' }).success).toBe(false);
    expect(dockerComposeLogs.argsSchema.safeParse({ environment: 'demo', project_dir: 'relative/path' }).success).toBe(false);
    expect(dockerComposeLogs.argsSchema.safeParse({ environment: 'demo', project_dir: '/opt/orderly' }).success).toBe(true);
  });

  test('parseResult returns raw trimmed stdout', () => {
    const r = dockerComposeLogs.parseResult(
      { stdout: 'api  | starting\ndb   | ready\n', stderr: '', exitCode: 0 },
      { environment: 'demo', project_dir: '/opt/orderly' },
    );
    expect(r.raw).toBe('api  | starting\ndb   | ready');
  });
});
