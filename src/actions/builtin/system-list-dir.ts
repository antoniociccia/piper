import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  path: z.string().min(1).default('.'),
  all: z.boolean().optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DirEntry {
  readonly mode: string;
  readonly links: string;
  readonly owner: string;
  readonly group: string;
  readonly size: string;
  readonly modified: string;
  readonly name: string;
}

export const systemListDir: Action<Args, readonly DirEntry[]> = {
  name: 'system.list_dir',
  tier: 'read',
  description:
    'List directory contents on the remote environment with `ls -la`. Set `all: true` to include dotfiles (default true). Path is validated by the security path denylist.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const showHidden = args.all !== false; // default true (matches -la)
    const cmd = showHidden ? ['ls', '-la', args.path] : ['ls', '-l', args.path];
    return buildSshArgvForEnv(env, cmd);
  },
  parseResult: (raw) => {
    const lines = raw.stdout.split('\n').filter((l) => l.trim() !== '');
    const entries: DirEntry[] = [];
    for (const line of lines) {
      if (line.startsWith('total ')) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 9) continue;
      entries.push({
        mode: parts[0] ?? '',
        links: parts[1] ?? '',
        owner: parts[2] ?? '',
        group: parts[3] ?? '',
        size: parts[4] ?? '',
        modified: parts.slice(5, 8).join(' '),
        name: parts.slice(8).join(' '),
      });
    }
    return entries;
  },
};
