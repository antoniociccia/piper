import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const PATH_PATTERN = /^[A-Za-z0-9_./-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  repo: z
    .string()
    .regex(PATH_PATTERN, 'repo must be a safe absolute or relative path')
    .min(1),
  limit: z.number().int().positive().max(50).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface GitLogResult {
  readonly entries: readonly string[];
}

export const gitLog: Action<Args, GitLogResult> = {
  name: 'git.log',
  tier: 'read',
  description:
    'Run `git log --oneline -<limit>` in a remote repository to see the most recent commits. Useful to identify what changed and when. Default limit 20.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const n = args.limit ?? 20;
    return buildSshArgvForEnv(env, [
      'git',
      '-C',
      args.repo,
      'log',
      '--oneline',
      '--decorate',
      `-${String(n)}`,
    ]);
  },
  parseResult: (raw) => ({
    entries: raw.stdout.split('\n').filter((l) => l.trim() !== ''),
  }),
};
