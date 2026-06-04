import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import { elevateRemoteCommand } from '../../security/elevation.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const PATH_PATTERN = /^[A-Za-z0-9_./\-]+$/;
const SERVICE_PATTERN = /^[A-Za-z0-9_.\-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  project_dir: z
    .string()
    .regex(PATH_PATTERN, 'project_dir must be a safe path')
    .min(1)
    .refine((p) => p.startsWith('/'), { message: 'project_dir must be an absolute path' }),
  service: z
    .string()
    .regex(SERVICE_PATTERN, 'service must be a docker-compose service name')
    .min(1)
    .optional(),
  tail: z.number().int().positive().max(5000).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DockerComposeLogsResult {
  readonly raw: string;
}

export const dockerComposeLogs: Action<Args, DockerComposeLogsResult> = {
  name: 'docker.compose_logs',
  tier: 'read',
  description:
    'Tail the recent logs of ALL services in a docker-compose project at once (`docker compose logs --tail N`), interleaved by service. Use this when the user asks for the logs of every container / the whole stack / an overview of per-service logs. Pass service to scope to one service; tail bounds the line count (default 200).',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const tail = args.tail ?? 200;
    const argv: string[] = [
      'docker',
      'compose',
      '-f',
      `${args.project_dir}/docker-compose.yml`,
      'logs',
      '--no-color',
      '--tail',
      String(tail),
    ];
    if (args.service !== undefined) argv.push(args.service);
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
