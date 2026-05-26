import { describe, expect, test } from 'bun:test';

import {
  BUILTIN_ACTIONS,
  dockerPs,
  logsTail,
  networkPortCheck,
  registerBuiltins,
  sshConnect,
  systemDiskUsage,
  systemProcessList,
  systemUptime,
} from '../../../../src/actions/builtin/index.ts';
import { createCatalog } from '../../../../src/actions/catalog.ts';
import type { ActionExecContext } from '../../../../src/actions/types.ts';
import type { Environment } from '../../../../src/environments/types.ts';

const env: Environment = {
  name: 'staging',
  host: '10.0.0.5',
  sshUser: 'deploy',
  port: 2222,
  tags: ['staging'],
};

const ctx: ActionExecContext = {
  sessionId: 'test-session',
  environment: env,
};

function expectSshHeader(argv: readonly string[]): void {
  expect(argv[0]).toBe('ssh');
  expect(argv).toContain('BatchMode=yes');
  expect(argv).toContain('StrictHostKeyChecking=accept-new');
  expect(argv).toContain('-p');
  expect(argv).toContain('2222');
  expect(argv).toContain('deploy@10.0.0.5');
}

describe('actions/builtin — catalog registration', () => {
  test('registerBuiltins registers all builtins', () => {
    const catalog = createCatalog();
    registerBuiltins(catalog);
    expect(catalog.size()).toBe(BUILTIN_ACTIONS.length);
    for (const action of BUILTIN_ACTIONS) {
      expect(catalog.resolve(action.name)).toBeDefined();
    }
  });

  test('every builtin has a unique name', () => {
    const names = BUILTIN_ACTIONS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every builtin action is tier=read', () => {
    for (const action of BUILTIN_ACTIONS) {
      expect(action.tier).toBe('read');
    }
  });
});

describe('actions/builtin — ssh.connect', () => {
  test('builds an ssh-true argv', () => {
    const argv = sshConnect.buildCommand({ environment: 'staging' }, ctx);
    expectSshHeader(argv);
    expect(argv[argv.length - 1]).toBe('true');
  });

  test('parseResult reports reachable=true on exit 0', () => {
    const result = sshConnect.parseResult({ stdout: '', stderr: '', exitCode: 0 }, { environment: 'x' });
    expect(result).toEqual({ reachable: true, exitCode: 0 });
  });

  test('parseResult reports reachable=false on non-zero exit', () => {
    const result = sshConnect.parseResult({ stdout: '', stderr: 'refused', exitCode: 255 }, { environment: 'x' });
    expect(result).toEqual({ reachable: false, exitCode: 255 });
  });
});

describe('actions/builtin — system.uptime', () => {
  test('builds an ssh uptime argv', () => {
    const argv = systemUptime.buildCommand({ environment: 'staging' }, ctx);
    expectSshHeader(argv);
    expect(argv[argv.length - 1]).toBe('uptime');
  });

  test('parseResult trims and surfaces the line', () => {
    const result = systemUptime.parseResult(
      { stdout: '  12:34:56 up 1 day, 3:00, load average: 0.4 \n', stderr: '', exitCode: 0 },
      { environment: 'x' },
    );
    expect(result.raw).toBe('12:34:56 up 1 day, 3:00, load average: 0.4');
    expect(result.summary).toBe('12:34:56 up 1 day, 3:00, load average: 0.4');
  });
});

describe('actions/builtin — system.disk_usage', () => {
  test('df -h without path', () => {
    const argv = systemDiskUsage.buildCommand({ environment: 'staging' }, ctx);
    expectSshHeader(argv);
    expect(argv[argv.length - 1]).toBe('df -h');
  });

  test('df -h with path', () => {
    const argv = systemDiskUsage.buildCommand({ environment: 'staging', path: '/var' }, ctx);
    expect(argv[argv.length - 1]).toBe('df -h /var');
  });

  test('parses df output skipping header', () => {
    const stdout = [
      'Filesystem      Size  Used Avail Use% Mounted on',
      '/dev/sda1        50G   30G   20G  60% /',
      '/dev/sda2       100G   10G   90G  10% /var',
    ].join('\n');
    const entries = systemDiskUsage.parseResult(
      { stdout, stderr: '', exitCode: 0 },
      { environment: 'x' },
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]?.filesystem).toBe('/dev/sda1');
    expect(entries[0]?.percentUsed).toBe('60%');
    expect(entries[1]?.mount).toBe('/var');
  });
});

describe('actions/builtin — system.process_list', () => {
  test('builds ssh ps argv', () => {
    const argv = systemProcessList.buildCommand({ environment: 'staging' }, ctx);
    expectSshHeader(argv);
    expect(argv[argv.length - 1]).toBe(`ps -eo 'pid,user,pcpu,pmem,args' -ww`);
  });

  test('filter rejects shell metacharacters via zod', () => {
    const result = systemProcessList.argsSchema.safeParse({
      environment: 'x',
      filter: 'foo; rm -rf /',
    });
    expect(result.success).toBe(false);
  });

  test('parseResult parses, sorts by CPU desc, filters by name', () => {
    const stdout = [
      '  PID USER     %CPU %MEM COMMAND',
      '  101 alice     1.5  2.0 node',
      '  102 bob      80.0  4.5 postgres',
      '  103 carol     0.5  1.0 nginx',
    ].join('\n');
    const entries = systemProcessList.parseResult(
      { stdout, stderr: '', exitCode: 0 },
      { environment: 'x' },
    );
    expect(entries.map((p) => p.cmd)).toEqual(['postgres', 'node', 'nginx']);

    const filtered = systemProcessList.parseResult(
      { stdout, stderr: '', exitCode: 0 },
      { environment: 'x', filter: 'node' },
    );
    expect(filtered.map((p) => p.cmd)).toEqual(['node']);
  });

  test('parseResult honors limit', () => {
    const stdout = [
      '  PID USER     %CPU %MEM COMMAND',
      ...Array.from({ length: 10 }).map(
        (_, i) => `  ${100 + i} u  ${(10 - i).toFixed(1)}  1.0 proc${i}`,
      ),
    ].join('\n');
    const top3 = systemProcessList.parseResult(
      { stdout, stderr: '', exitCode: 0 },
      { environment: 'x', limit: 3 },
    );
    expect(top3.map((p) => p.cmd)).toEqual(['proc0', 'proc1', 'proc2']);
  });
});

describe('actions/builtin — network.port_check', () => {
  test('argv constructs nc -zv with timeout', () => {
    const argv = networkPortCheck.buildCommand(
      { environment: 'staging', target: 'db.internal', port: 5432, timeoutSec: 2 },
      ctx,
    );
    expectSshHeader(argv);
    expect(argv[argv.length - 1]).toBe('nc -zv -w 2 db.internal 5432');
  });

  test('rejects target with shell metacharacters', () => {
    const parse = networkPortCheck.argsSchema.safeParse({
      environment: 'x',
      target: 'db; rm -rf /',
      port: 22,
    });
    expect(parse.success).toBe(false);
  });

  test('parseResult classifies open / refused / timeout', () => {
    const args = { environment: 'x', target: 't', port: 22 };
    expect(
      networkPortCheck.parseResult(
        { stdout: '', stderr: 'Connection to t 22 port [tcp/*] succeeded!', exitCode: 0 },
        args,
      ).status,
    ).toBe('open');
    expect(
      networkPortCheck.parseResult(
        { stdout: '', stderr: 'Connection refused', exitCode: 1 },
        args,
      ).status,
    ).toBe('refused');
    expect(
      networkPortCheck.parseResult(
        { stdout: '', stderr: 'nc: connect timed out', exitCode: 1 },
        args,
      ).status,
    ).toBe('timeout');
  });
});

describe('actions/builtin — logs.tail', () => {
  test('builds tail -n N <path> argv', () => {
    const argv = logsTail.buildCommand(
      { environment: 'staging', path: '/var/log/app.log', lines: 50 },
      ctx,
    );
    expectSshHeader(argv);
    expect(argv[argv.length - 1]).toBe('tail -n 50 /var/log/app.log');
  });

  test('default lines is 200 when omitted', () => {
    const argv = logsTail.buildCommand(
      { environment: 'staging', path: '/var/log/app.log' },
      ctx,
    );
    expect(argv[argv.length - 1]).toBe('tail -n 200 /var/log/app.log');
  });

  test('parseResult applies client-side grep filter', () => {
    const stdout = [
      'INFO booting',
      'ERROR connection refused on port 5432',
      'INFO retrying',
      'ERROR connection refused on port 5432',
    ].join('\n');
    const all = logsTail.parseResult({ stdout, stderr: '', exitCode: 0 }, {
      environment: 'x',
      path: '/p',
    });
    expect(all.lines).toHaveLength(4);

    const errors = logsTail.parseResult({ stdout, stderr: '', exitCode: 0 }, {
      environment: 'x',
      path: '/p',
      grep: 'ERROR',
    });
    expect(errors.matched).toBe(2);
    expect(errors.lines.every((l) => l.includes('ERROR'))).toBe(true);
  });
});

describe('actions/builtin — docker.ps', () => {
  test('argv is docker ps --format json by default', () => {
    const argv = dockerPs.buildCommand({ environment: 'staging' }, ctx);
    expectSshHeader(argv);
    expect(argv[argv.length - 1]).toBe('docker ps --format json');
  });

  test('argv includes -a when all=true', () => {
    const argv = dockerPs.buildCommand({ environment: 'staging', all: true }, ctx);
    expect(argv[argv.length - 1]).toBe('docker ps -a --format json');
  });

  test('parseResult parses JSON-lines docker output', () => {
    const stdout = [
      '{"ID":"abc","Image":"nginx","Names":"web","State":"running","Status":"Up 5 minutes"}',
      '{"ID":"def","Image":"postgres","Names":"db","State":"exited","Status":"Exited (0) 1 hour ago"}',
      'not json — skipped',
      '',
    ].join('\n');
    const containers = dockerPs.parseResult({ stdout, stderr: '', exitCode: 0 }, { environment: 'x' });
    expect(containers).toHaveLength(2);
    expect(containers[0]?.id).toBe('abc');
    expect(containers[1]?.state).toBe('exited');
  });
});
