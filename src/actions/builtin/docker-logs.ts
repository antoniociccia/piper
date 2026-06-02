import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import { elevateRemoteCommand } from '../../security/elevation.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  container: z.string().regex(/^[A-Za-z0-9_.-]+$/, 'container must be a safe id or name'),
  lines: z.number().int().positive().max(5000).optional(),
  since: z.string().regex(/^[A-Za-z0-9 :+\-T,]+$/, 'since must be a safe time spec').optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DockerLogsResult {
  readonly lines: readonly string[];
}

export const dockerLogs: Action<Args, DockerLogsResult> = {
  name: 'docker.logs',
  tier: 'read',
  description:
    'Read the tail of a Docker container log on the remote environment (`docker logs --tail N <container> [--since X]`). Container is identified by name or id.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const n = args.lines ?? 200;
    const argv: string[] = ['docker', 'logs', '--tail', String(n)];
    if (args.since !== undefined && args.since !== '') {
      argv.push('--since', args.since);
    }
    argv.push(args.container);
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },
  parseResult: (raw) => {
    const merged = `${raw.stdout}\n${raw.stderr}`;
    return { lines: merged.split('\n').filter((l) => l !== '') };
  },
};
