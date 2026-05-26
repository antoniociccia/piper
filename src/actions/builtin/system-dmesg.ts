import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  lines: z.number().int().positive().max(500).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DmesgResult {
  readonly raw: string;
}

export const systemDmesg: Action<Args, DmesgResult> = {
  name: 'system.dmesg',
  tier: 'read',
  description:
    'Run `dmesg --color=never -T | tail -N` to inspect recent kernel ring buffer messages. Default 100 lines. Useful for OOM kills, hardware faults, driver issues.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const n = args.lines ?? 100;
    return buildSshArgvForEnv(env, [
      'sh', '-c',
      `dmesg --color=never -T 2>/dev/null | tail -${n} || sudo -n dmesg --color=never -T 2>/dev/null | tail -${n} || echo "dmesg unavailable (needs root or CAP_SYSLOG)"`,
    ]);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
