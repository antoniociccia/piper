import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  repo: z.string().regex(/^[A-Za-z0-9_./-]+$/).optional(),
  state: z.enum(['open', 'closed', 'all']).optional(),
  label: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: z.number().int().positive().max(50).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface GithubIssueListResult {
  readonly raw: string;
  readonly count: number;
}

export const githubIssueList: Action<Args, GithubIssueListResult> = {
  name: 'github.issue_list',
  tier: 'read',
  description:
    'Run `gh issue list` to see issues (defaults to open, limit 20). Filter by --label and --state. Useful for backlog triage and finding known incidents.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['gh', 'issue', 'list', '--state', args.state ?? 'open', '--limit', String(args.limit ?? 20)];
    if (args.label !== undefined) argv.push('--label', args.label);
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
