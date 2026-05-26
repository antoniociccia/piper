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
