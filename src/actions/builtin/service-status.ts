import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  name: z.string().regex(/^[A-Za-z0-9._@-]+$/, 'service name must be safe (alnum . _ @ -)'),
});

type Args = z.infer<typeof argsSchema>;

export interface ServiceStatus {
  readonly name: string;
  readonly activeState: string;
  readonly subState: string;
  readonly raw: string;
}

export const serviceStatus: Action<Args, ServiceStatus> = {
  name: 'service.status',
  tier: 'read',
  description:
    'Show the systemd unit status on the remote environment (`systemctl status <name> --no-pager`). Linux only. Use `service.journal` for recent log lines.',
  argsSchema,
  buildCommand: (args, ctx) =>
    buildSshArgvForEnv(requireEnv(ctx), ['systemctl', 'status', args.name, '--no-pager']),
  parseResult: (raw, args) => {
    const out: { name: string; activeState: string; subState: string; raw: string } = {
      name: args.name,
      activeState: 'unknown',
      subState: 'unknown',
      raw: raw.stdout,
    };
    const m = /Active:\s+(\w+)\s+\((\w+)\)/.exec(raw.stdout);
    if (m !== null) {
      out.activeState = m[1] ?? 'unknown';
      out.subState = m[2] ?? 'unknown';
    }
    return out;
  },
};
