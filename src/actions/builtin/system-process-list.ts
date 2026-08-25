import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  filter: z.string().regex(/^[A-Za-z0-9._ -]*$/).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface ProcessEntry {
  readonly pid: string;
  readonly user: string;
  readonly cpu: number;
  readonly mem: number;
  readonly cmd: string;
}

export const systemProcessList: Action<Args, readonly ProcessEntry[]> = {
  name: 'system.process_list',
  tier: 'read',
  description:
    'List processes on the remote environment, sorted by CPU usage descending. Uses `ps -eo pid,user,pcpu,pmem,args -ww` so the full command line is shown (not just the binary name). Optional `filter` matches the command line client-side (no shell interpolation). Optional `limit` caps the count (default 50, max 500).',
  argsSchema,
  buildCommand: (_args, ctx) => {
    const env = requireEnv(ctx);
    return buildSshArgvForEnv(env, ['ps', '-eo', 'pid,user,pcpu,pmem,args', '-ww']);
  },
  parseResult: (raw, args) => {
    const limit = args.limit ?? 50;
    const filter = args.filter;

    const lines = raw.stdout.split('\n').slice(1);
    const parsed: ProcessEntry[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      const cols = trimmed.split(/\s+/);
      if (cols.length < 5) continue;
      parsed.push({
        pid: cols[0] ?? '',
        user: cols[1] ?? '',
        cpu: Number(cols[2] ?? '0') || 0,
        mem: Number(cols[3] ?? '0') || 0,
        cmd: cols.slice(4).join(' '),
      });
    }

    parsed.sort((a, b) => b.cpu - a.cpu);

    const filtered =
      filter === undefined || filter === ''
        ? parsed
        : parsed.filter((p) => p.cmd.toLowerCase().includes(filter.toLowerCase()));

    return filtered.slice(0, limit);
  },
};
