import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const SAFE_TOKEN = /^[A-Za-z0-9_.-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  namespace: z.string().regex(SAFE_TOKEN).optional(),
  all_namespaces: z.boolean().optional(),
  field_selector: z.string().regex(/^[A-Za-z0-9=,!._/-]+$/).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface KubectlEventsResult {
  readonly raw: string;
}

export const kubectlEvents: Action<Args, KubectlEventsResult> = {
  name: 'kubectl.events',
  tier: 'read',
  description:
    'Run `kubectl get events --sort-by=.lastTimestamp` for a chronological view of cluster events (pod scheduling, failures, evictions, scaling). field_selector can filter by type=Warning, involvedObject.kind=Pod, etc.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['kubectl', 'get', 'events', '--sort-by=.lastTimestamp'];
    if (args.all_namespaces === true) argv.push('-A');
    else if (args.namespace !== undefined) argv.push('-n', args.namespace);
    if (args.field_selector !== undefined) argv.push('--field-selector', args.field_selector);
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
