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

export interface NetworkConnectionsResult {
  /**
   * Verbatim command output. Always present. `ss` and `netstat` lay their
   * columns out differently, so when the fallback runs, `connections` is empty
   * and this is the only trustworthy record — reporting mis-mapped columns as
   * structured data would be worse than reporting none.
   */
  readonly raw: string;
  readonly connections: readonly NetworkConnection[];
}

/** `ss` prints `Netid State Recv-Q Send-Q Local Peer Process`; netstat does not. */
function looksLikeSsOutput(stdout: string): boolean {
  const header = stdout.split('\n')[0] ?? '';
  return /\bState\b/.test(header) && /\bLocal\b/i.test(header);
}

export const networkConnections: Action<Args, NetworkConnectionsResult> = {
  name: 'network.connections',
  tier: 'read',
  description:
    'List TCP/UDP sockets via `ss -tunap`, falling back to `netstat -an` on hosts without iproute2 (macOS/BSD). Set `listening_only: true` to filter to LISTEN sockets only.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    // `ss` is iproute2, Linux-only. macOS/BSD answer with netstat.
    const ssFlags = args.listening_only === true ? '-tunlp' : '-tunap';
    const netstatFlags = args.listening_only === true ? '-an -p tcp' : '-an';
    return buildSshArgvForEnv(env, [
      'sh',
      '-c',
      `ss ${ssFlags} 2>/dev/null || netstat ${netstatFlags}`,
    ]);
  },
  parseResult: (raw) => {
    const stdout = raw.stdout;
    if (!looksLikeSsOutput(stdout)) {
      return { raw: stdout.trim(), connections: [] };
    }
    const lines = stdout.split('\n').slice(1).filter((l) => l.trim() !== '');
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
    return { raw: stdout.trim(), connections: conns };
  },
};
