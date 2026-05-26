import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
});

type Args = z.infer<typeof argsSchema>;

export interface SshConnectResult {
  readonly reachable: boolean;
  readonly exitCode: number;
}

export const sshConnect: Action<Args, SshConnectResult> = {
  name: 'ssh.connect',
  tier: 'read',
  description:
    'Probe SSH connectivity to an environment by running `true` on the remote host. Returns reachable=true iff exit code is 0.',
  argsSchema,
  buildCommand: (_args, ctx) => {
    const env = requireEnv(ctx);
    return buildSshArgvForEnv(env, ['true']);
  },
  parseResult: (raw) => ({ reachable: raw.exitCode === 0, exitCode: raw.exitCode }),
};
