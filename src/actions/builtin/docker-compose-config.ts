import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import { elevateRemoteCommand } from '../../security/elevation.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const PATH_PATTERN = /^[A-Za-z0-9_./-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  project_dir: z
    .string()
    .regex(PATH_PATTERN, 'project_dir must be a safe path')
    .min(1)
    .refine((p) => p.startsWith('/'), { message: 'project_dir must be an absolute path' })
    .refine((p) => !p.split('/').includes('..'), { message: 'project_dir must not contain .. segments' }),
});

type Args = z.infer<typeof argsSchema>;

export interface DockerComposeConfigResult {
  readonly raw: string;
}

export const dockerComposeConfig: Action<Args, DockerComposeConfigResult> = {
  name: 'docker.compose_config',
  tier: 'read',
  description:
    'Run `docker compose config` in a project directory to render the fully-merged compose configuration. Use this to inspect `depends_on` conditions (e.g. `service_healthy`) and declared healthchecks — essential for diagnosing dependency-ordering issues where a service starts before its dependencies are healthy.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['docker', 'compose', '-f', `${args.project_dir}/docker-compose.yml`, 'config'];
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },
  parseResult: (raw) => ({
    raw: raw.stdout.trim(),
  }),
};
