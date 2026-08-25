import { describe, expect, test } from 'bun:test';

import { registerBuiltins } from '../../../src/actions/builtin/index.ts';
import { createCatalog } from '../../../src/actions/catalog.ts';
import type { Action, ActionExecContext } from '../../../src/actions/types.ts';
import { LOCAL_ENVIRONMENT, LOCAL_ENVIRONMENT_NAME } from '../../../src/environments/local.ts';

/**
 * Until the `local` target existed, every action ran over SSH against a Linux
 * box, so Linux-only tooling was invisible. Pointed at the machine PIPER runs
 * on, `free`, `lscpu` and `ss` simply do not exist on macOS — and macOS is what
 * a large share of the people PIPER is for actually use.
 *
 * The fix follows the fallback-chain style the catalog already uses elsewhere
 * (`dpkg-query || rpm || brew || echo`): try the Linux tool first so a real
 * Linux host is unaffected, fall back to the BSD/macOS equivalent. No OS
 * detection, no new abstraction, same command for local and remote.
 */

const catalog = createCatalog();
registerBuiltins(catalog);

function actionNamed(name: string): Action<unknown, unknown> {
  const found = catalog.list().find((a) => a.name === name);
  if (found === undefined) throw new Error(`action not in catalog: ${name}`);
  return found as Action<unknown, unknown>;
}

const localCtx = {
  sessionId: 's' as ActionExecContext['sessionId'],
  environment: LOCAL_ENVIRONMENT,
} as ActionExecContext;

const cmdFor = (name: string, args: Record<string, unknown> = {}): readonly string[] =>
  actionNamed(name).buildCommand({ environment: LOCAL_ENVIRONMENT_NAME, ...args }, localCtx);

describe('core diagnostics degrade to BSD/macOS tooling', () => {
  test('system.memory falls back when `free` is absent', () => {
    const cmd = cmdFor('system.memory').join(' ');
    expect(cmd).toContain('free');
    // Something has to answer on a host without procps.
    expect(cmd).toMatch(/vm_stat|PhysMem/);
  });

  test('system.cpu_info falls back to sysctl', () => {
    const cmd = cmdFor('system.cpu_info').join(' ');
    expect(cmd).toContain('lscpu');
    expect(cmd).toContain('sysctl');
  });

  test('network.connections falls back to netstat', () => {
    const cmd = cmdFor('network.connections').join(' ');
    expect(cmd).toContain('ss ');
    expect(cmd).toContain('netstat');
  });

  test('system.file_stat covers both GNU and BSD stat', () => {
    const cmd = cmdFor('system.file_stat', { path: '/etc/hosts' }).join(' ');
    expect(cmd).toContain('stat -c');
    expect(cmd).toContain('stat -f');
  });

  test('system.process_list already uses a portable ps invocation', () => {
    const cmd = cmdFor('system.process_list');
    expect(cmd).toEqual(['ps', '-eo', 'pid,user,pcpu,pmem,args', '-ww']);
  });
});

describe('the fallback chains never interpolate user input into a script', () => {
  test('system.file_stat passes the path as a positional argument, not inside the script', () => {
    const hostile = '/tmp/x"; rm -rf / #';
    const cmd = cmdFor('system.file_stat', { path: hostile });

    // The path must travel as its own argv element…
    expect(cmd).toContain(hostile);

    // …and must NOT appear inside the `sh -c` script itself.
    const scriptIndex = cmd.indexOf('-c');
    expect(scriptIndex).toBeGreaterThanOrEqual(0);
    const script = cmd[scriptIndex + 1] ?? '';
    expect(script).not.toContain('rm -rf');
    expect(script).not.toContain(hostile);
    // The script refers to the path only through the positional parameter.
    expect(script).toContain('$1');
  });

  test('a path containing a command substitution is still never expanded into the script', () => {
    const hostile = '/tmp/$(id)';
    const cmd = cmdFor('system.file_stat', { path: hostile });
    const scriptIndex = cmd.indexOf('-c');
    const script = cmd[scriptIndex + 1] ?? '';
    expect(script).not.toContain('$(id)');
    expect(cmd).toContain(hostile);
  });
});
