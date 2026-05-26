import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  target: z.string().regex(/^[A-Za-z0-9._:-]+$/, 'target must be a hostname or IP'),
  count: z.number().int().positive().max(20).optional(),
  timeoutSec: z.number().int().positive().max(30).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface PingResult {
  readonly target: string;
  readonly transmitted: number;
  readonly received: number;
  readonly lossPercent: number;
  readonly minMs?: number;
  readonly avgMs?: number;
  readonly maxMs?: number;
  readonly raw: string;
}

export const networkPing: Action<Args, PingResult> = {
  name: 'network.ping',
  tier: 'read',
  description:
    'Ping a target FROM the remote environment (`ping -c N -W T <target>`). Probes outbound connectivity from the host you are on.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const count = args.count ?? 3;
    const timeout = args.timeoutSec ?? 2;
    return buildSshArgvForEnv(env, ['ping', '-c', String(count), '-W', String(timeout), args.target]);
  },
  parseResult: (raw, args) => {
    const out: {
      target: string;
      transmitted: number;
      received: number;
      lossPercent: number;
      minMs?: number;
      avgMs?: number;
      maxMs?: number;
      raw: string;
    } = {
      target: args.target,
      transmitted: 0,
      received: 0,
      lossPercent: 100,
      raw: raw.stdout,
    };
    const summary = /(\d+)\s+packets transmitted,\s+(\d+)\s+(?:packets\s+)?received,?\s+(\d+(?:\.\d+)?)%\s+packet loss/.exec(
      raw.stdout,
    );
    if (summary !== null) {
      out.transmitted = Number(summary[1] ?? '0');
      out.received = Number(summary[2] ?? '0');
      out.lossPercent = Number(summary[3] ?? '0');
    }
    const rtt = /(?:rtt|round-trip).*?=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(raw.stdout);
    if (rtt !== null) {
      out.minMs = Number(rtt[1]);
      out.avgMs = Number(rtt[2]);
      out.maxMs = Number(rtt[3]);
    }
    return out;
  },
};
