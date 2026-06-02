import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import { elevateRemoteCommand } from '../../security/elevation.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  lines: z.number().int().positive().max(500).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DmesgResult {
  readonly raw: string;
}

export const systemDmesg: Action<Args, DmesgResult> = {
  name: 'system.dmesg',
  tier: 'read',
  // dmesg works without root when CAP_SYSLOG is granted (common on modern
  // Linux). defaultElevation is 'none': the Executor proposes a sudo re-run
  // via detectPermissionDenied if the unprivileged attempt fails.
  defaultElevation: 'none',
  description:
    'Run `dmesg --color=never -T | tail -N` to inspect recent kernel ring buffer messages. Default 100 lines. Useful for OOM kills, hardware faults, driver issues.',
  argsSchema,
  buildCommand: (_args, ctx) => {
    const env = requireEnv(ctx);
    const elevation = ctx.elevation ?? 'none';
    // No shell plumbing here: no 2>/dev/null, no pipe, no fallback echo.
    // Letting stderr and exit code reach the Executor unfiltered is what
    // enables the reactive sudo trigger (detectPermissionDenied) to fire
    // when dmesg is restricted by the kernel's CAP_SYSLOG policy.
    // Line trimming is done in parseResult instead of shell `tail`.
    const inner = elevateRemoteCommand(['dmesg', '--color=never', '-T'], elevation);
    return buildSshArgvForEnv(env, inner);
  },
  parseResult: (raw, args) => {
    const n = args.lines ?? 100;
    const allLines = raw.stdout
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    const trimmed = allLines.slice(-n);
    return { raw: trimmed.join('\n') };
  },
};
