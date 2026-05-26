import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  filter: z.string().min(2).max(500),
  project: z.string().regex(/^[a-z0-9\-]+$/).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface GcloudLoggingTailResult {
  readonly raw: string;
}

export const gcloudLoggingTail: Action<Args, GcloudLoggingTailResult> = {
  name: 'gcloud.logging_read',
  tier: 'read',
  description:
    'Run `gcloud logging read "<filter>"` to fetch recent log entries from Cloud Logging. filter is a Logging filter expression (e.g. `severity>=ERROR resource.type="cloud_run_revision"`). Default limit 50, max 200.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = [
      'gcloud', 'logging', 'read', args.filter,
      '--limit', String(args.limit ?? 50),
      '--format', 'value(timestamp,severity,jsonPayload.message,textPayload)',
    ];
    if (args.project !== undefined) argv.push('--project', args.project);
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
