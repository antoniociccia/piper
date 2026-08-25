import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  filter: z.string().regex(/^[A-Za-z0-9_+.-]+$/).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface PackageListResult {
  readonly raw: string;
}

export const systemPackageList: Action<Args, PackageListResult> = {
  name: 'system.package_list',
  tier: 'read',
  description:
    'Detect package manager (dpkg/rpm/brew) and list installed packages, optionally filtered by substring. Useful to confirm a dependency is installed at the expected version.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const filter = args.filter !== undefined ? ` | grep -i "${args.filter}"` : '';
    const cmd =
      `dpkg-query -W -f='\${binary:Package}\\t\${Version}\\n' 2>/dev/null${filter} || ` +
      `rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\n' 2>/dev/null${filter} || ` +
      `brew list --versions 2>/dev/null${filter} || ` +
      `echo "no supported package manager detected"`;
    return buildSshArgvForEnv(env, ['sh', '-c', cmd]);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
