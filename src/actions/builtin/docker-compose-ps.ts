import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import { elevateRemoteCommand } from '../../security/elevation.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const PATH_PATTERN = /^[A-Za-z0-9_./\-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  project_dir: z
    .string()
    .regex(PATH_PATTERN, 'project_dir must be a safe path')
    .min(1)
    .refine((p) => p.startsWith('/'), { message: 'project_dir must be an absolute path' })
    .refine((p) => !p.split('/').includes('..'), { message: 'project_dir must not contain .. segments' }),
  all: z.boolean().optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DockerComposePsResult {
  readonly raw: string;
  readonly servicesCount: number;
}

export const dockerComposePs: Action<Args, DockerComposePsResult> = {
  name: 'docker.compose_ps',
  tier: 'read',
  description:
    'Run `docker compose ps` in a project directory to see the status of declared services (including stopped ones when all=true). Surface mismatches between compose declarations and actually-running containers.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['docker', 'compose', '-f', `${args.project_dir}/docker-compose.yml`, 'ps'];
    if (args.all === true) argv.push('--all');
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },
  parseResult: (raw) => {
    const text = raw.stdout.trim();
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    // First line is the header; remaining lines are service rows.
    const servicesCount = Math.max(0, lines.length - 1);
    return { raw: text, servicesCount };
  },
};
