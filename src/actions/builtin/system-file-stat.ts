import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  path: z.string().min(1),
});

type Args = z.infer<typeof argsSchema>;

export interface FileStat {
  readonly name: string;
  readonly sizeBytes: number;
  readonly mode: string;
  readonly owner: string;
  readonly group: string;
  readonly modified: string;
  readonly raw: string;
}

export const systemFileStat: Action<Args, FileStat | null> = {
  name: 'system.file_stat',
  tier: 'read',
  description:
    'Return metadata for a single path on the remote environment (Linux: `stat -c "%n|%s|%a|%U|%G|%y" <path>`). Path is validated by the security path denylist.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    // GNU stat wants `-c`, BSD/macOS stat wants `-f`, and both are asked for
    // the same six pipe-separated fields so parseResult stays format-agnostic.
    //
    // `args.path` is unconstrained user input, so it is passed as the shell's
    // positional `$1` and never interpolated into the script text. `sh -c
    // <script> <argv0> <path>` binds it to $1 without any expansion.
    return buildSshArgvForEnv(env, [
      'sh',
      '-c',
      'stat -c "%n|%s|%a|%U|%G|%y" "$1" 2>/dev/null || stat -f "%N|%z|%Lp|%Su|%Sg|%Sm" "$1"',
      'sh',
      args.path,
    ]);
  },
  parseResult: (raw) => {
    const trimmed = raw.stdout.trim();
    if (trimmed === '' || raw.exitCode !== 0) return null;
    const parts = trimmed.split('|');
    if (parts.length < 6) return null;
    return {
      name: parts[0] ?? '',
      sizeBytes: Number(parts[1] ?? '0') || 0,
      mode: parts[2] ?? '',
      owner: parts[3] ?? '',
      group: parts[4] ?? '',
      modified: parts[5] ?? '',
      raw: trimmed,
    };
  },
};
