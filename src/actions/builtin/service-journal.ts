import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  name: z.string().regex(/^[A-Za-z0-9._@-]+$/, 'service name must be safe (alnum . _ @ -)'),
  lines: z.number().int().positive().max(2000).optional(),
  since: z.string().regex(/^[A-Za-z0-9 :+\-,]+$/, 'since must be a safe relative time, e.g. "10 min ago" or "2024-01-01"').optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface JournalResult {
  readonly lines: readonly string[];
}

export const serviceJournal: Action<Args, JournalResult> = {
  name: 'service.journal',
  tier: 'read',
  description:
    'Tail recent journald logs for a systemd unit on the remote environment (`journalctl -u <name> -n <lines> --no-pager [--since "..."]`). Linux only.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const n = args.lines ?? 100;
    const argv: string[] = ['journalctl', '-u', args.name, '-n', String(n), '--no-pager'];
    if (args.since !== undefined && args.since !== '') {
      argv.push('--since', args.since);
    }
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ lines: raw.stdout.split('\n').filter((l) => l !== '') }),
};
