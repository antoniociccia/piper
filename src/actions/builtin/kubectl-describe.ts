import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const SAFE_TOKEN = /^[A-Za-z0-9_.-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  resource: z.string().regex(SAFE_TOKEN),
  name: z.string().regex(SAFE_TOKEN),
  namespace: z.string().regex(SAFE_TOKEN).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface KubectlDescribeResult {
  readonly raw: string;
}

export const kubectlDescribe: Action<Args, KubectlDescribeResult> = {
  name: 'kubectl.describe',
  tier: 'read',
  description:
    'Run `kubectl describe <resource> <name>` to inspect events, conditions, container status, restart count, and recent failures. Pair with kubectl.events for full incident context.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['kubectl', 'describe', args.resource, args.name];
    if (args.namespace !== undefined) argv.push('-n', args.namespace);
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
