import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import { elevateRemoteCommand } from '../../security/elevation.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  all: z.boolean().optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DockerComposeLsResult {
  readonly raw: string;
}

export const dockerComposeLs: Action<Args, DockerComposeLsResult> = {
  name: 'docker.compose_ls',
  tier: 'read',
  description:
    'List all docker-compose projects on the host (`docker compose ls`), with their status, to discover what stacks are deployed. Pass all=true to include stopped projects.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['docker', 'compose', 'ls'];
    if (args.all === true) argv.push('--all');
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
