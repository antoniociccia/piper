import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const SAFE_TOKEN = /^[A-Za-z0-9_.-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  namespace: z.string().regex(SAFE_TOKEN).optional(),
  all_namespaces: z.boolean().optional(),
  sort_by: z.enum(['cpu', 'memory']).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface KubectlTopPodResult {
  readonly raw: string;
}

export const kubectlTopPod: Action<Args, KubectlTopPodResult> = {
  name: 'kubectl.top_pod',
  tier: 'read',
  description:
    'Run `kubectl top pod` to see current CPU/memory usage per pod. Requires metrics-server in the cluster. sort_by=cpu|memory to find resource hogs.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['kubectl', 'top', 'pod'];
    if (args.all_namespaces === true) argv.push('-A');
    else if (args.namespace !== undefined) argv.push('-n', args.namespace);
    if (args.sort_by !== undefined) argv.push('--sort-by', args.sort_by);
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
