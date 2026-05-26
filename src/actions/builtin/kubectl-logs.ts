import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const SAFE_TOKEN = /^[A-Za-z0-9_.-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  pod: z.string().regex(SAFE_TOKEN, 'pod must be a safe k8s name'),
  namespace: z.string().regex(SAFE_TOKEN, 'namespace must be a safe k8s name').optional(),
  container: z.string().regex(SAFE_TOKEN, 'container must be a safe k8s name').optional(),
  lines: z.number().int().positive().max(5000).optional(),
  since: z
    .string()
    .regex(/^[0-9]+[smhd]$/, 'since must be a duration like 5m, 2h, 1d')
    .optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface KubectlLogsResult {
  readonly lines: readonly string[];
}

export const kubectlLogs: Action<Args, KubectlLogsResult> = {
  name: 'kubectl.logs',
  tier: 'read',
  description:
    'Run `kubectl logs <pod> [-c <container>] --tail N [--since 5m]` on the remote environment. Returns the most recent log lines from a single pod.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['kubectl', 'logs'];
    if (args.namespace !== undefined) argv.push('-n', args.namespace);
    if (args.container !== undefined) argv.push('-c', args.container);
    argv.push('--tail', String(args.lines ?? 200));
    if (args.since !== undefined) argv.push('--since', args.since);
    argv.push(args.pod);
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({
    lines: `${raw.stdout}\n${raw.stderr}`.split('\n').filter((l) => l !== ''),
  }),
};
