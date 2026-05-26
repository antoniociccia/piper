import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({ environment: z.string() });
type Args = z.infer<typeof argsSchema>;

export interface CpuInfoResult {
  readonly raw: string;
}

export const systemCpuInfo: Action<Args, CpuInfoResult> = {
  name: 'system.cpu_info',
  tier: 'read',
  description:
    'Run `lscpu` (fallback `cat /proc/cpuinfo | head -30`) to inspect CPU model, cores, threads, virtualization, frequency. Useful to confirm host shape.',
  argsSchema,
  buildCommand: (_args, ctx) => {
    const env = requireEnv(ctx);
    return buildSshArgvForEnv(env, ['sh', '-c', 'lscpu 2>/dev/null || head -30 /proc/cpuinfo']);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
