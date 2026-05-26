import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  filter_state: z.enum(['running', 'stopped', 'pending', 'terminated', 'all']).optional(),
  profile: z.string().regex(/^[A-Za-z0-9_\-]+$/).optional(),
  region: z.string().regex(/^[A-Za-z0-9\-]+$/).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface AwsEc2DescribeResult {
  readonly raw: string;
}

export const awsEc2Describe: Action<Args, AwsEc2DescribeResult> = {
  name: 'aws.ec2_describe',
  tier: 'read',
  description:
    'Run `aws ec2 describe-instances` with a compact JMESPath projection (id, type, state, public IP, tags). filter_state restricts by lifecycle state. Uses the host\'s AWS CLI auth.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = [
      'aws', 'ec2', 'describe-instances',
      '--query',
      'Reservations[].Instances[].{Id:InstanceId,Type:InstanceType,State:State.Name,PublicIp:PublicIpAddress,Name:Tags[?Key==`Name`]|[0].Value}',
      '--output', 'table',
    ];
    if (args.filter_state !== undefined && args.filter_state !== 'all') {
      argv.push('--filters', `Name=instance-state-name,Values=${args.filter_state}`);
    }
    if (args.profile !== undefined) argv.push('--profile', args.profile);
    if (args.region !== undefined) argv.push('--region', args.region);
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
