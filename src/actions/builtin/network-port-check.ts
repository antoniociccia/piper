import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  target: z.string().regex(/^[A-Za-z0-9._-]+$/, 'target must be a hostname or IP'),
  port: z.number().int().positive().max(65535),
  timeoutSec: z.number().int().positive().max(60).optional(),
});

type Args = z.infer<typeof argsSchema>;

export type PortStatus = 'open' | 'closed' | 'refused' | 'timeout' | 'unknown';

export interface PortCheckResult {
  readonly status: PortStatus;
  readonly target: string;
  readonly port: number;
  readonly rawStderr: string;
}

export const networkPortCheck: Action<Args, PortCheckResult> = {
  name: 'network.port_check',
  tier: 'read',
  description:
    'Use `nc -zv` from the remote environment to test TCP reachability to `target:port`. Returns open / refused / timeout / unknown.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const timeout = args.timeoutSec ?? 3;
    return buildSshArgvForEnv(env, [
      'nc',
      '-zv',
      '-w',
      String(timeout),
      args.target,
      String(args.port),
    ]);
  },
  parseResult: (raw, args) => {
    const combined = `${raw.stdout}\n${raw.stderr}`.toLowerCase();
    let status: PortStatus;
    if (raw.exitCode === 0 || combined.includes('succeeded') || combined.includes('open')) {
      status = 'open';
    } else if (combined.includes('refused')) {
      status = 'refused';
    } else if (combined.includes('timed out') || combined.includes('timeout')) {
      status = 'timeout';
    } else if (raw.exitCode !== 0) {
      status = 'closed';
    } else {
      status = 'unknown';
    }
    return { status, target: args.target, port: args.port, rawStderr: raw.stderr };
  },
};
