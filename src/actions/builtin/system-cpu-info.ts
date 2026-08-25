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
    // `lscpu` and `/proc/cpuinfo` are both Linux-only; on macOS/BSD the same
    // facts come from sysctl. Linux hosts still hit the first branch.
    return buildSshArgvForEnv(env, [
      'sh',
      '-c',
      'lscpu 2>/dev/null || head -30 /proc/cpuinfo 2>/dev/null || ' +
        'sysctl -a 2>/dev/null | grep -E "machdep.cpu.brand_string|hw.ncpu|hw.physicalcpu|hw.memsize"',
    ]);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
