import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  path: z.string().optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DiskUsageEntry {
  readonly filesystem: string;
  readonly size: string;
  readonly used: string;
  readonly available: string;
  readonly percentUsed: string;
  readonly mount: string;
}

export const systemDiskUsage: Action<Args, readonly DiskUsageEntry[]> = {
  name: 'system.disk_usage',
  tier: 'read',
  description:
    'Run `df -h` on the remote environment. Optional `path` narrows the report to a single filesystem.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const cmd = args.path === undefined ? ['df', '-h'] : ['df', '-h', args.path];
    return buildSshArgvForEnv(env, cmd);
  },
  parseResult: (raw) => {
    const lines = raw.stdout.split('\n').slice(1).filter((l) => l.trim() !== '');
    return lines.map((line) => {
      const cols = line.split(/\s+/);
      return {
        filesystem: cols[0] ?? '',
        size: cols[1] ?? '',
        used: cols[2] ?? '',
        available: cols[3] ?? '',
        percentUsed: cols[4] ?? '',
        mount: cols[5] ?? '',
      };
    });
  },
};
