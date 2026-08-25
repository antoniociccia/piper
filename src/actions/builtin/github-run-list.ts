import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const PATH_PATTERN = /^[A-Za-z0-9_./-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  repo: z.string().regex(PATH_PATTERN, 'repo must be a safe path').optional(),
  status: z.enum(['queued', 'in_progress', 'completed', 'failure', 'success']).optional(),
  limit: z.number().int().positive().max(50).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface GithubRunListResult {
  readonly raw: string;
  readonly count: number;
}

export const githubRunList: Action<Args, GithubRunListResult> = {
  name: 'github.run_list',
  tier: 'read',
  description:
    'Run `gh run list` to see recent GitHub Actions workflow runs (status, conclusion, duration, branch). Default shows last 20 across all workflows. Useful for triaging CI failures.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['gh', 'run', 'list', '--limit', String(args.limit ?? 20)];
    if (args.status !== undefined) argv.push('--status', args.status);
    if (args.repo !== undefined) {
      return buildSshArgvForEnv(env, ['sh', '-c', `cd ${args.repo} && ${argv.join(' ')}`]);
    }
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => {
    const text = raw.stdout.trim();
    return { raw: text, count: text === '' ? 0 : text.split('\n').length };
  },
};
