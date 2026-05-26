import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  path: z.string().min(1),
  lines: z.number().int().positive().max(10_000).optional(),
  grep: z.string().max(200).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface LogsTailResult {
  readonly lines: readonly string[];
  readonly matched: number;
}

export const logsTail: Action<Args, LogsTailResult> = {
  name: 'logs.tail',
  tier: 'read',
  description:
    'Tail the last N lines of a log file on the remote environment. Optional `grep` filters lines client-side by case-sensitive substring match (no shell interpolation). The path is checked against the security denylist before execution.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const n = args.lines ?? 200;
    return buildSshArgvForEnv(env, ['tail', '-n', String(n), args.path]);
  },
  parseResult: (raw, args) => {
    const allLines = raw.stdout.split('\n').filter((l) => l !== '');
    const grep = args.grep;
    const filtered =
      grep === undefined || grep === ''
        ? allLines
        : allLines.filter((l) => l.includes(grep));
    return { lines: filtered, matched: filtered.length };
  },
};
