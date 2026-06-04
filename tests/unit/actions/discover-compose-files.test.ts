import { describe, expect, test } from 'bun:test';

import { discoverComposeFiles } from '../../../src/actions/builtin/discover-compose-files.ts';
import type { ActionExecContext } from '../../../src/actions/types.ts';
import type { Environment } from '../../../src/environments/types.ts';

const ENV = { name: 'demo', host: 'h', sshUser: 'deploy', tags: [] } as Environment;
const ctx = (elevation: 'none' | 'sudo'): ActionExecContext =>
  ({ sessionId: 's' as ActionExecContext['sessionId'], environment: ENV, elevation });

describe('discover.compose_files', () => {
  test('finds compose files under fixed roots', () => {
    const cmd = discoverComposeFiles.buildCommand({ environment: 'demo' }, ctx('none')).join(' ');
    expect(cmd).toContain('find');
    expect(cmd).toContain('/opt');
    expect(cmd).toContain('docker-compose');
    expect(cmd).toContain('-maxdepth 4');
  });
  test('is read tier and honors elevation', () => {
    expect(discoverComposeFiles.tier).toBe('read');
    expect(discoverComposeFiles.buildCommand({ environment: 'demo' }, ctx('sudo')).join(' ')).toContain('sudo -n');
  });
  test('parseResult splits found paths into a list', () => {
    const r = discoverComposeFiles.parseResult(
      { stdout: '/opt/orderly/docker-compose.yml\n/srv/api/docker-compose.yaml\n', stderr: '', exitCode: 0 },
      { environment: 'demo' },
    );
    expect(r.files).toEqual(['/opt/orderly/docker-compose.yml', '/srv/api/docker-compose.yaml']);
  });
});
