import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  profile: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  region: z.string().regex(/^[A-Za-z0-9-]+$/).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface AwsRdsDescribeResult {
  readonly raw: string;
}

export const awsRdsDescribe: Action<Args, AwsRdsDescribeResult> = {
  name: 'aws.rds_describe',
  tier: 'read',
  description:
    'Run `aws rds describe-db-instances` with a compact projection (id, engine, status, multi-az, endpoint). Useful for health-checking managed databases.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = [
      'aws', 'rds', 'describe-db-instances',
      '--query',
      'DBInstances[].{Id:DBInstanceIdentifier,Engine:Engine,Status:DBInstanceStatus,MultiAZ:MultiAZ,Endpoint:Endpoint.Address}',
      '--output', 'table',
    ];
    if (args.profile !== undefined) argv.push('--profile', args.profile);
    if (args.region !== undefined) argv.push('--region', args.region);
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
