import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  state: z.enum(['active', 'failed', 'inactive', 'all']).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface SystemctlListResult {
  readonly raw: string;
}

export const systemSystemctlList: Action<Args, SystemctlListResult> = {
  name: 'system.systemctl_list',
  tier: 'read',
  description:
    'Run `systemctl list-units --type=service` to enumerate systemd services. state=failed surfaces only failing units (most useful for triage). all=show even inactive units.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['systemctl', 'list-units', '--type=service', '--no-pager'];
    if (args.state === 'failed') argv.push('--state=failed');
    else if (args.state === 'active') argv.push('--state=active');
    else if (args.state === 'inactive') argv.push('--state=inactive');
    else if (args.state === 'all') argv.push('--all');
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
