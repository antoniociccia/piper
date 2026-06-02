import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import { elevateRemoteCommand } from '../../security/elevation.ts';
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
  defaultElevation: 'sudo',
  description:
    'Run `iptables -L -n -v --line-numbers` (fallback `nft list ruleset`) to show firewall rules. Requires passwordless sudo on the host when elevated. Useful for diagnosing connectivity blocks.',
  argsSchema,
  buildCommand: (_args, ctx) => {
    const env = requireEnv(ctx);
    const elevation = ctx.elevation ?? 'none';
    const iptablesCmd = elevateRemoteCommand(
      ['iptables', '-L', '-n', '-v', '--line-numbers'],
      elevation,
    );
    const nftCmd = elevateRemoteCommand(['nft', 'list', 'ruleset'], elevation);
    const shellStr =
      `${iptablesCmd.join(' ')} 2>/dev/null || ${nftCmd.join(' ')} 2>/dev/null || echo "iptables/nft: permission denied or not found"`;
    return buildSshArgvForEnv(env, ['sh', '-c', shellStr]);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
