import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({ environment: z.string() });
type Args = z.infer<typeof argsSchema>;

export interface CronListResult {
  readonly raw: string;
}

export const systemCronList: Action<Args, CronListResult> = {
  name: 'system.cron_list',
  tier: 'read',
  description:
    'Run `crontab -l` (current user) plus list system-wide cron drop-ins under /etc/cron.d/. Useful for finding scheduled jobs that may be causing periodic load or failures.',
  argsSchema,
  buildCommand: (_args, ctx) => {
    const env = requireEnv(ctx);
    return buildSshArgvForEnv(env, [
      'sh', '-c',
      'echo "=== crontab -l (current user) ==="; crontab -l 2>/dev/null || echo "(no user crontab)"; echo; echo "=== /etc/cron.d/ ==="; ls -la /etc/cron.d/ 2>/dev/null || true',
    ]);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
