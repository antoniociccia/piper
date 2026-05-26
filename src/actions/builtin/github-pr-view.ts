import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const PATH_PATTERN = /^[A-Za-z0-9_./\-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  pr: z.union([z.number().int().positive(), z.string().regex(/^[A-Za-z0-9_/\-]+$/)]),
  repo: z.string().regex(PATH_PATTERN, 'repo must be a safe path').optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface GithubPrViewResult {
  readonly raw: string;
}

export const githubPrView: Action<Args, GithubPrViewResult> = {
  name: 'github.pr_view',
  tier: 'read',
  description:
    'Run `gh pr view <pr>` to inspect a single pull request (title, status, checks, mergeability, description, last commit). pr can be a number or a branch name. Uses the host\'s gh CLI auth.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['gh', 'pr', 'view', String(args.pr), '--comments'];
    if (args.repo !== undefined) {
      return buildSshArgvForEnv(env, ['sh', '-c', `cd ${args.repo} && ${argv.join(' ')}`]);
    }
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
