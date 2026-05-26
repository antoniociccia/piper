import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  listening_only: z.boolean().optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface NetworkConnection {
  readonly proto: string;
  readonly state: string;
  readonly local: string;
  readonly peer: string;
  readonly process: string;
}

export const networkConnections: Action<Args, readonly NetworkConnection[]> = {
  name: 'network.connections',
  tier: 'read',
  description:
    'List TCP/UDP sockets on the remote environment via `ss -tunap`. Set `listening_only: true` to filter to LISTEN sockets only.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const flags = args.listening_only === true ? ['-tunlp'] : ['-tunap'];
    return buildSshArgvForEnv(env, ['ss', ...flags]);
  },
  parseResult: (raw) => {
    const lines = raw.stdout.split('\n').slice(1).filter((l) => l.trim() !== '');
    const conns: NetworkConnection[] = [];
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 5) continue;
      conns.push({
        proto: cols[0] ?? '',
        state: cols[1] ?? '',
        local: cols[4] ?? '',
        peer: cols[5] ?? '',
        process: cols.slice(6).join(' '),
      });
    }
    return conns;
  },
};
