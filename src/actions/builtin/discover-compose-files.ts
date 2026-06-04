import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import { elevateRemoteCommand } from '../../security/elevation.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

// Fixed, non-user-supplied search roots. Hard-coded so no path arg can widen
// the scan and no path-denylist bypass is possible.
const SEARCH_ROOTS = ['/opt', '/srv', '/home', '/root'] as const;

const argsSchema = z.object({
  environment: z.string(),
});

type Args = z.infer<typeof argsSchema>;

export interface DiscoverComposeFilesResult {
  readonly files: readonly string[];
}

export const discoverComposeFiles: Action<Args, DiscoverComposeFilesResult> = {
  name: 'discover.compose_files',
  tier: 'read',
  description:
    'Find docker-compose files on disk under standard deployment roots (/opt, /srv, /home, /root) to discover compose projects that may not be currently running. Read-only.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    // find <roots> -maxdepth 4 \( -name docker-compose.yml -o -name docker-compose.yaml \) 2>/dev/null
    const argv: string[] = [
      'find',
      ...SEARCH_ROOTS,
      '-maxdepth',
      '4',
      '(',
      '-name',
      'docker-compose.yml',
      '-o',
      '-name',
      'docker-compose.yaml',
      ')',
    ];
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },
  parseResult: (raw) => {
    const files = raw.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    return { files };
  },
};
