import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  resource_group: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface AzVmListResult {
  readonly raw: string;
}

export const azVmList: Action<Args, AzVmListResult> = {
  name: 'az.vm_list',
  tier: 'read',
  description:
    'Run `az vm list` to enumerate Azure virtual machines (name, resource group, location, power state). Uses the host\'s az CLI auth (`az login`).',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = [
      'az', 'vm', 'list', '-d',
      '--query', '[].{Name:name,RG:resourceGroup,Location:location,PowerState:powerState}',
      '-o', 'table',
    ];
    if (args.resource_group !== undefined) {
      argv.push('--resource-group', args.resource_group);
    }
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
