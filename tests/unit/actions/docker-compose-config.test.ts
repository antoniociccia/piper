import { describe, expect, test } from 'bun:test';

import { dockerComposeConfig } from '../../../src/actions/builtin/docker-compose-config.ts';
import type { ActionExecContext } from '../../../src/actions/types.ts';
import type { Environment } from '../../../src/environments/types.ts';

const ENV = { name: 'demo', host: 'h', sshUser: 'deploy', tags: [] } as Environment;
const ctx = (elevation: 'none' | 'sudo'): ActionExecContext =>
  ({ sessionId: 's' as ActionExecContext['sessionId'], environment: ENV, elevation });

describe('docker.compose_config', () => {
  test('tier is read', () => {
    expect(dockerComposeConfig.tier).toBe('read');
  });
  test('buildCommand contains docker compose config and project_dir file path', () => {
    const cmd = dockerComposeConfig
      .buildCommand({ environment: 'demo', project_dir: '/opt/orderly' }, ctx('none'))
      .join(' ');
    expect(cmd).toContain('docker compose');
    expect(cmd).toContain('config');
    expect(cmd).toContain('/opt/orderly/docker-compose.yml');
  });
  test('honors ctx.elevation sudo', () => {
    const cmd = dockerComposeConfig
      .buildCommand({ environment: 'demo', project_dir: '/opt/orderly' }, ctx('sudo'))
      .join(' ');
    expect(cmd).toContain('sudo -n');
  });
  test('parseResult returns raw trimmed stdout', () => {
    const r = dockerComposeConfig.parseResult(
      { stdout: 'services:\n  api:\n    image: node:22\n', stderr: '', exitCode: 0 },
      { environment: 'demo', project_dir: '/opt/orderly' },
    );
    expect(r.raw).toBe('services:\n  api:\n    image: node:22');
  });
  test('rejects a relative or traversal project_dir (must be absolute)', () => {
    expect(dockerComposeConfig.argsSchema.safeParse({ environment: 'demo', project_dir: '../../../etc' }).success).toBe(false);
    expect(dockerComposeConfig.argsSchema.safeParse({ environment: 'demo', project_dir: 'relative/path' }).success).toBe(false);
    expect(dockerComposeConfig.argsSchema.safeParse({ environment: 'demo', project_dir: '/opt/orderly' }).success).toBe(true);
  });
});
