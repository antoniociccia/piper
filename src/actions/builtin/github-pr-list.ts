import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const PATH_PATTERN = /^[A-Za-z0-9_./\-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  repo: z.string().regex(PATH_PATTERN, 'repo must be a safe path').optional(),
  state: z.enum(['open', 'closed', 'merged', 'all']).optional(),
  limit: z.number().int().positive().max(50).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface GithubPrListResult {
  readonly raw: string;
  readonly count: number;
}

export const githubPrList: Action<Args, GithubPrListResult> = {
  name: 'github.pr_list',
  tier: 'read',
  description:
    'Run `gh pr list` on the remote environment. Uses the existing gh CLI auth on that host (PIPER never sees the token). repo is the working directory of the local checkout; state filters open/closed/merged; default state=open, limit=20.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['gh', 'pr', 'list', '--state', args.state ?? 'open', '--limit', String(args.limit ?? 20)];
    if (args.repo !== undefined) {
      return buildSshArgvForEnv(env, ['sh', '-c', `cd ${args.repo} && ${argv.join(' ')}`]);
    }
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => {
    const text = raw.stdout.trim();
    const count = text === '' ? 0 : text.split('\n').length;
    return { raw: text, count };
  },
};
