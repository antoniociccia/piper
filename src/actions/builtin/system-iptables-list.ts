import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({ environment: z.string() });
type Args = z.infer<typeof argsSchema>;

export interface IptablesListResult {
  readonly raw: string;
}

export const systemIptablesList: Action<Args, IptablesListResult> = {
  name: 'system.iptables_list',
  tier: 'read',
  description:
    'Run `sudo iptables -L -n -v --line-numbers` (fallback `sudo nft list ruleset`) to show firewall rules. Requires passwordless sudo on the host. Useful for diagnosing connectivity blocks.',
  argsSchema,
  buildCommand: (_args, ctx) => {
    const env = requireEnv(ctx);
    return buildSshArgvForEnv(env, [
      'sh', '-c',
      'sudo -n iptables -L -n -v --line-numbers 2>/dev/null || sudo -n nft list ruleset 2>/dev/null || echo "no passwordless sudo for iptables/nft"',
    ]);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
