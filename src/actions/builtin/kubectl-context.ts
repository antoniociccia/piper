import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({ environment: z.string() });
type Args = z.infer<typeof argsSchema>;

export interface KubectlContextResult {
  readonly raw: string;
}

export const kubectlContext: Action<Args, KubectlContextResult> = {
  name: 'kubectl.context_current',
  tier: 'read',
  description:
    'Run `kubectl config current-context` plus `kubectl config view --minify` to see which cluster + namespace + user the host is currently pointing at. Sanity check before any kubectl action.',
  argsSchema,
  buildCommand: (_args, ctx) => {
    const env = requireEnv(ctx);
    return buildSshArgvForEnv(env, ['sh', '-c', 'kubectl config current-context && echo "---" && kubectl config view --minify --flatten=false']);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
