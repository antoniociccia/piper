import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import { elevateRemoteCommand } from '../../security/elevation.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

// Fixed, non-user-supplied search roots. Hard-coded for the same reason as
// discover.compose_files: no path arg can widen the scan, so there is nothing
// for a path-denylist bypass to aim at.
const SEARCH_ROOTS = ['/var/log', '/opt', '/srv'] as const;

/** Beyond this the output is noise; the largest and newest files are what matter. */
const MAX_FILES = 40;

const argsSchema = z.object({
  environment: z.string(),
});

type Args = z.infer<typeof argsSchema>;

export interface DiscoveredLogFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly modified: string;
}

export interface DiscoverLogFilesResult {
  readonly files: readonly DiscoveredLogFile[];
  readonly truncated: boolean;
}

/** `ls -la` line: mode links owner group size <date…> path. */
function parseListing(line: string): DiscoveredLogFile | null {
  const cols = line.trim().split(/\s+/);
  if (cols.length < 9) return null;
  const size = Number(cols[4]);
  if (!Number.isFinite(size)) return null;
  return {
    path: cols.slice(8).join(' '),
    sizeBytes: size,
    modified: cols.slice(5, 8).join(' '),
  };
}

export const discoverLogFiles: Action<Args, DiscoverLogFilesResult> = {
  name: 'discover.log_files',
  tier: 'read',
  description:
    'Find log files on disk under standard log roots (/var/log, /opt, /srv), with their size and last-modified time, so an investigation can see WHICH logs exist before deciding which to tail. Returns the largest first. Read-only.',
  argsSchema,
  buildCommand: (_args, ctx) => {
    const env = requireEnv(ctx);
    // `-exec ls -la {} +` rather than GNU `-printf`: BSD/macOS find has no
    // -printf, and PIPER now targets the local machine as well as Linux hosts.
    const argv: string[] = [
      'find',
      ...SEARCH_ROOTS,
      '-maxdepth',
      '4',
      '-type',
      'f',
      '(',
      '-name',
      '*.log',
      '-o',
      '-name',
      '*.err',
      '-o',
      '-name',
      '*.out',
      ')',
      '-exec',
      'ls',
      '-la',
      '{}',
      '+',
    ];
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },
  parseResult: (raw) => {
    const parsed = raw.stdout
      .split('\n')
      .map(parseListing)
      .filter((f): f is DiscoveredLogFile => f !== null);

    // Largest first: an unrotated log is itself an incident, and a big file is
    // usually where the interesting volume of errors lives.
    const sorted = [...parsed].sort((a, b) => b.sizeBytes - a.sizeBytes);
    return {
      files: sorted.slice(0, MAX_FILES),
      truncated: sorted.length > MAX_FILES,
    };
  },
};
