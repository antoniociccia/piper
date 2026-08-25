import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  log_group: z.string().regex(/^[A-Za-z0-9_/.-]+$/, 'log_group must be a CloudWatch log group name'),
  since: z.string().regex(/^[0-9]+[smhd]$/, 'since must be a duration like 5m, 2h').optional(),
  filter_pattern: z.string().max(200).optional(),
  profile: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  region: z.string().regex(/^[A-Za-z0-9-]+$/).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface AwsCloudwatchTailResult {
  readonly raw: string;
}

export const awsCloudwatchTail: Action<Args, AwsCloudwatchTailResult> = {
  name: 'aws.cloudwatch_tail',
  tier: 'read',
  description:
    'Run `aws logs tail <log_group>` to stream recent CloudWatch log events. since defaults to 10m. filter_pattern is a literal substring or CloudWatch filter syntax. Useful for triaging Lambda / ECS errors.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['aws', 'logs', 'tail', args.log_group, '--since', args.since ?? '10m', '--format', 'short'];
    if (args.filter_pattern !== undefined) argv.push('--filter-pattern', args.filter_pattern);
    if (args.profile !== undefined) argv.push('--profile', args.profile);
    if (args.region !== undefined) argv.push('--region', args.region);
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
