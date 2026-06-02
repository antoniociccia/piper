import type { Environment } from '../environments/types.ts';
import { argvToShell } from './types.ts';

const DEFAULT_CONNECT_TIMEOUT_SEC = 5;

export interface SshOptions {
  readonly host: string;
  readonly command: readonly string[];
  readonly connectTimeoutSec?: number;
  readonly port?: number;
  readonly identityFile?: string;
}

export class InvalidSshOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSshOptionsError';
  }
}

export function buildSshArgv(opts: SshOptions): readonly string[] {
  if (opts.host.trim() === '') {
    throw new InvalidSshOptionsError('host must not be empty');
  }
  if (opts.command.length === 0) {
    throw new InvalidSshOptionsError('command must not be empty');
  }
  const connectTimeout = opts.connectTimeoutSec ?? DEFAULT_CONNECT_TIMEOUT_SEC;
  if (!Number.isFinite(connectTimeout) || connectTimeout <= 0) {
    throw new InvalidSshOptionsError(`connectTimeoutSec must be > 0, got ${connectTimeout}`);
  }
  if (opts.port !== undefined) {
    if (!Number.isInteger(opts.port) || opts.port <= 0 || opts.port > 65535) {
      throw new InvalidSshOptionsError(`port must be an integer in 1..65535, got ${opts.port}`);
    }
  }

  const argv: string[] = [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${connectTimeout}`,
  ];

  if (opts.port !== undefined) {
    argv.push('-p', String(opts.port));
  }

  if (opts.identityFile !== undefined && opts.identityFile !== '') {
    argv.push('-i', opts.identityFile);
  }

  argv.push(opts.host);
  argv.push(argvToShell(opts.command));

  return argv;
}

export function buildSshArgvForEnv(
  env: Environment,
  command: readonly string[],
  connectTimeoutSec?: number,
): readonly string[] {
  return buildSshArgv({
    host: `${env.sshUser}@${env.host}`,
    command,
    ...(env.port === undefined ? {} : { port: env.port }),
    ...(env.identityFile === undefined ? {} : { identityFile: env.identityFile }),
    ...(connectTimeoutSec === undefined ? {} : { connectTimeoutSec }),
  });
}

/**
 * Deterministically transform an already-built non-interactive `sudo -n` ssh
 * argv into its interactive form, without re-deriving the inner command:
 *   - drop the `-o BatchMode=yes` pair,
 *   - ensure `-tt` is present (insert right after `ssh` if absent),
 *   - replace every `sudo -n ` with `sudo ` (the remote command is one argv
 *     element, so the swap happens inside the quoted string).
 * Pure, no I/O.
 */
export function toInteractive(argv: readonly string[]): readonly string[] {
  // Drop the `-o BatchMode=yes` pair (exact match, so an unrelated `-o <opt>`
  // is never consumed). The `sudo -n` → `sudo` rewrite is applied ONLY to the
  // last element — the remote command string — and only to its FIRST
  // occurrence, so an ssh option value or a remote command that merely mentions
  // "sudo -n " as grep data is left intact.
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const cur = argv[i];
    if (cur === undefined) continue;
    if (cur === '-o' && argv[i + 1] === 'BatchMode=yes') {
      i += 1; // skip the value too
      continue;
    }
    kept.push(cur);
  }
  const lastIdx = kept.length - 1;
  const out = kept.map((el, i) => (i === lastIdx ? el.replace('sudo -n ', 'sudo ') : el));
  if (!out.includes('-tt')) {
    const sshIdx = out.indexOf('ssh');
    if (sshIdx >= 0) out.splice(sshIdx + 1, 0, '-tt');
    else out.unshift('-tt');
  }
  return out;
}
