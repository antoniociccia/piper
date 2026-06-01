import { describe, expect, test } from 'bun:test';

import {
  BUILTIN_ACTIONS,
  dockerComposeUp,
  dockerPs,
  logsTail,
  networkPortCheck,
  notifyDesktop,
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

  test('builtin tier mix: read-only + a small, explicit mutate set', () => {
    // M2 introduces mutate-tier actions one by one. Every entry that lands
    // here must be reviewed for: dry-run hook present, verify hook present,
    // rollback hook present (or documented as unrecoverable). This list is
    // the auditable surface — if a new mutate action shows up in the
    // catalog without being added here, this test fails on purpose.
    const KNOWN_MUTATE: readonly string[] = ['docker.compose_up'];
    const KNOWN_DESTRUCTIVE: readonly string[] = [];

    for (const action of BUILTIN_ACTIONS) {
      if (action.tier === 'read') continue;
      if (action.tier === 'mutate') {
        expect(
          KNOWN_MUTATE.includes(action.name),
          `mutate action "${action.name}" must be added to KNOWN_MUTATE and reviewed for dry-run/verify/rollback hooks`,
        ).toBe(true);
        // Sanity: mutate actions should at least preview before applying.
        expect(action.buildDryRunCommand, `${action.name} should declare a dry-run`).toBeDefined();
        continue;
      }
      if (action.tier === 'destructive') {
        expect(KNOWN_DESTRUCTIVE.includes(action.name)).toBe(true);
        continue;
      }
      throw new Error(`unknown tier on action ${action.name}`);
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

describe('actions/builtin — docker.compose_up (mutate tier)', () => {
  const baseArgs = {
    environment: 'staging',
    project_dir: '/opt/orderly',
  } as const;

  test('declares tier=mutate, not read', () => {
    expect(dockerComposeUp.tier).toBe('mutate');
  });

  test('snapshot command captures current ps JSON (read-only)', () => {
    const argv = dockerComposeUp.buildSnapshotCommand!(baseArgs, ctx);
    expectSshHeader(argv);
    const joined = argv.join(' ');
    expect(joined).toContain('docker compose -f /opt/orderly/docker-compose.yml ps --format json --all');
  });

  test('dry-run command uses `compose config` (universal, read-only)', () => {
    const argv = dockerComposeUp.buildDryRunCommand!(baseArgs, ctx);
    expectSshHeader(argv);
    const joined = argv.join(' ');
    expect(joined).toContain('docker compose -f /opt/orderly/docker-compose.yml config');
  });

  test('execute command uses `up -d --remove-orphans` and stays in detached mode', () => {
    const argv = dockerComposeUp.buildCommand(baseArgs, ctx);
    expectSshHeader(argv);
    const joined = argv.join(' ');
    expect(joined).toContain('docker compose -f /opt/orderly/docker-compose.yml up -d --remove-orphans');
  });

  test('verify command re-reads ps to confirm services are running', () => {
    const argv = dockerComposeUp.buildVerifyCommand!(baseArgs, ctx);
    expectSshHeader(argv);
    const joined = argv.join(' ');
    expect(joined).toContain('docker compose -f /opt/orderly/docker-compose.yml ps --format json');
  });

  test('rollback command brings the project down (conservative MVP)', () => {
    const rollback = dockerComposeUp.buildRollbackCommand!(baseArgs, ctx, '');
    expect(rollback).not.toBeNull();
    const joined = (rollback as readonly string[]).join(' ');
    expect(joined).toContain('docker compose -f /opt/orderly/docker-compose.yml down');
  });

  test('per-service variant scopes every step to that single service', () => {
    const args = { ...baseArgs, service: 'web' };
    expect(dockerComposeUp.buildCommand(args, ctx).join(' ')).toContain(' up -d --remove-orphans web');
    expect(dockerComposeUp.buildVerifyCommand!(args, ctx).join(' ')).toContain(' ps --format json web');
    const rb = dockerComposeUp.buildRollbackCommand!(args, ctx, '');
    expect((rb as readonly string[]).join(' ')).toContain(' down web');
  });

  test('argsSchema rejects project_dir with shell metacharacters', () => {
    expect(dockerComposeUp.argsSchema.safeParse({ ...baseArgs, project_dir: '/opt/orderly; rm -rf /' }).success).toBe(false);
    expect(dockerComposeUp.argsSchema.safeParse({ ...baseArgs, project_dir: '/opt/orderly && reboot' }).success).toBe(false);
  });

  test('argsSchema rejects service names with shell metacharacters', () => {
    expect(dockerComposeUp.argsSchema.safeParse({ ...baseArgs, service: 'web;ls' }).success).toBe(false);
    expect(dockerComposeUp.argsSchema.safeParse({ ...baseArgs, service: 'web bar' }).success).toBe(false);
  });
});

describe('actions/builtin — notify.desktop', () => {
  const ORIGINAL_PLATFORM = process.platform;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  function restorePlatform(): void {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true });
  }

  test('tier is read', () => {
    expect(notifyDesktop.tier).toBe('read');
  });

  test('darwin: argv = [osascript, -e, script] containing display notification', () => {
    setPlatform('darwin');
    try {
      const argv = notifyDesktop.buildCommand({ title: 'PIPER', message: 'hello world' }, ctx);
      expect(argv[0]).toBe('osascript');
      expect(argv[1]).toBe('-e');
      expect(argv).toHaveLength(3);
      const script = argv[2] ?? '';
      expect(script).toContain('display notification');
      expect(script).toContain('with title');
    } finally {
      restorePlatform();
    }
  });

  test('darwin: a message with quotes and backslashes is sanitized in the script', () => {
    setPlatform('darwin');
    try {
      // buildCommand is called directly (bypassing the schema). The Layer-1
      // sanitizer must still neutralize the breakout characters.
      const argv = notifyDesktop.buildCommand(
        { title: 'say "hi"', message: 'path\\to "x"' },
        ctx,
      );
      const script = argv[2] ?? '';
      // The only double quotes allowed are the 4 delimiters around the two
      // sanitized literals: ...notification "<msg>" with title "<title>".
      const quoteCount = (script.match(/"/g) ?? []).length;
      expect(quoteCount).toBe(4);
      // No backslashes survive into the AppleScript.
      expect(script).not.toContain('\\');
    } finally {
      restorePlatform();
    }
  });

  test('darwin: AppleScript injection payload appears only as inert text', () => {
    setPlatform('darwin');
    try {
      const payload = 'x" & (do shell script "touch /tmp/pwned") & "';
      const argv = notifyDesktop.buildCommand({ title: 'PIPER', message: payload }, ctx);
      const script = argv[2] ?? '';
      // The live-code sequence that would break out of the string literal must
      // NOT survive: every double quote from the payload has been replaced.
      expect(script).not.toContain('" & (do shell script');
      expect(script).not.toContain('do shell script "');
      // Exactly the 4 delimiter quotes remain.
      expect((script.match(/"/g) ?? []).length).toBe(4);
    } finally {
      restorePlatform();
    }
  });

  test('schema rejects args containing a double quote', () => {
    expect(notifyDesktop.argsSchema.safeParse({ title: 'ok', message: 'has "quote"' }).success).toBe(false);
    expect(notifyDesktop.argsSchema.safeParse({ title: 'has "quote"', message: 'ok' }).success).toBe(false);
  });

  test('schema rejects args containing a backslash', () => {
    expect(notifyDesktop.argsSchema.safeParse({ title: 'ok', message: 'a\\b' }).success).toBe(false);
  });

  test('schema rejects control characters', () => {
    expect(notifyDesktop.argsSchema.safeParse({ title: 'ok', message: 'line\nbreak' }).success).toBe(false);
  });

  test('schema rejects a title starting with a dash (notify-send flag injection)', () => {
    expect(notifyDesktop.argsSchema.safeParse({ title: '--help', message: 'ok' }).success).toBe(false);
  });

  test('schema accepts plain printable text', () => {
    expect(notifyDesktop.argsSchema.safeParse({ title: 'PIPER Watch', message: 'Check failed on staging' }).success).toBe(true);
  });

  test('linux: argv is notify-send with -- guard then title and message', () => {
    setPlatform('linux');
    try {
      const argv = notifyDesktop.buildCommand({ title: 'PIPER', message: 'hello' }, ctx);
      expect(argv[0]).toBe('notify-send');
      expect(argv).toContain('--');
      expect(argv).toContain('PIPER');
      expect(argv).toContain('hello');
      // -- must come before the title so a dash-leading title is never a flag.
      expect(argv.indexOf('--')).toBeLessThan(argv.indexOf('PIPER'));
    } finally {
      restorePlatform();
    }
  });
});
