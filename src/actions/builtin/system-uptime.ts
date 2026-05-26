import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
});

type Args = z.infer<typeof argsSchema>;

export interface UptimeResult {
  readonly raw: string;
  readonly summary: string;
}

export const systemUptime: Action<Args, UptimeResult> = {
  name: 'system.uptime',
  tier: 'read',
  description: 'Run `uptime` on the remote environment to inspect load average and time up.',
  argsSchema,
  buildCommand: (_args, ctx) => {
    const env = requireEnv(ctx);
    return buildSshArgvForEnv(env, ['uptime']);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim(), summary: raw.stdout.trim() }),
};
