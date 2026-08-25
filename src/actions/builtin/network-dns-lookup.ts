import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const HOSTNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;

const argsSchema = z.object({
  environment: z.string(),
  hostname: z.string().regex(HOSTNAME_PATTERN, 'hostname must be a valid DNS name'),
  record_type: z.enum(['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SRV']).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DnsLookupResult {
  readonly raw: string;
}

export const networkDnsLookup: Action<Args, DnsLookupResult> = {
  name: 'network.dns_lookup',
  tier: 'read',
  description:
    'Resolve a hostname with `dig +short` (fallback to `host`) for a chosen record type (default A). Use to diagnose DNS resolution issues.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const type = args.record_type ?? 'A';
    // Prefer dig; if dig isn't installed, the shell -c chain falls back to `host`.
    // We pass arguments through SSH; remote shell parses them.
    const remoteCmd = `dig +short ${args.hostname} ${type} 2>/dev/null || host -t ${type} ${args.hostname}`;
    return buildSshArgvForEnv(env, ['sh', '-c', remoteCmd]);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
