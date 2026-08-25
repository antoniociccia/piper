import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const PATH_PATTERN = /^[A-Za-z0-9_./-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  run_id: z.union([z.number().int().positive(), z.string().regex(/^[A-Za-z0-9_-]+$/)]),
  repo: z.string().regex(PATH_PATTERN).optional(),
  log_failed: z.boolean().optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface GithubRunViewResult {
  readonly raw: string;
}

export const githubRunView: Action<Args, GithubRunViewResult> = {
  name: 'github.run_view',
  tier: 'read',
  description:
    'Run `gh run view <run_id>` to drill into a specific GitHub Actions run. Set log_failed=true to also pull the log of the failed step (`--log-failed`). Use after run_list to triage a failing workflow.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['gh', 'run', 'view', String(args.run_id)];
    if (args.log_failed === true) argv.push('--log-failed');
    if (args.repo !== undefined) {
      return buildSshArgvForEnv(env, ['sh', '-c', `cd ${args.repo} && ${argv.join(' ')}`]);
    }
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: `${raw.stdout}\n${raw.stderr}`.trim() }),
};
