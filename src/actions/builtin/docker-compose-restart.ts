import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import { elevateRemoteCommand } from '../../security/elevation.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

// docker.compose_restart is the "riavvia"/"bounce the stack" mutate action.
// Unlike docker.compose_up (which RE-CREATES containers whose image/config
// changed, and is therefore a no-op on an already-current stack), this one
// runs `docker compose restart` — a plain stop+start of the running
// containers, no recreation. That is exactly what a user means by "riavvia il
// compose": the containers cycle even when nothing in the compose file moved.
//
//   snapshot  → `docker compose ps --format json --all`  (pre-state + the sudo
//                                                          probe for the
//                                                          reactive-sudo flow)
//   dry-run   → `docker compose ps`                       (what WILL be
//                                                          restarted; restart
//                                                          has no config diff)
//   execute   → `docker compose restart [service]`        (the actual mutation)
//   verify    → `docker compose ps --format json`         (every declared
//                                                          service must be
//                                                          `running` again)
//   rollback  → `docker compose up -d [service]`          (restart has no prior
//                                                          state to restore; if
//                                                          a container is left
//                                                          down, re-bringing it
//                                                          up is the safe floor)

const PATH_PATTERN = /^[A-Za-z0-9_./\-]+$/;
const SERVICE_PATTERN = /^[A-Za-z0-9_.\-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  project_dir: z
    .string()
    .regex(PATH_PATTERN, 'project_dir must be a safe path')
    .min(1),
  /**
   * Optional single service to restart. If omitted, every container in the
   * compose project is restarted. Per-service keeps the blast radius small.
   */
  service: z
    .string()
    .regex(SERVICE_PATTERN, 'service must be a docker-compose service name')
    .min(1)
    .optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DockerComposeRestartResult {
  readonly raw: string;
}

function composeBase(args: Args): string[] {
  return ['docker', 'compose', '-f', `${args.project_dir}/docker-compose.yml`];
}

export const dockerComposeRestart: Action<Args, DockerComposeRestartResult> = {
  name: 'docker.compose_restart',
  tier: 'mutate',
  description:
    'Restart the running containers of a docker-compose project (docker compose restart) — stop + start without recreating. Propose this DIRECTLY when the user asks to "riavvia"/"restart"/"bounce" the stack or a service. The mutation flow shows a pre-state snapshot and asks for approval before anything runs.',
  argsSchema,

  buildSnapshotCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv = [...composeBase(args), 'ps', '--format', 'json', '--all'];
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },

  buildDryRunCommand: (args, ctx) => {
    // Restart has no config diff. A plain `ps` shows the user which
    // containers WILL be cycled, which is the closest read-only preview.
    const env = requireEnv(ctx);
    const argv = [...composeBase(args), 'ps'];
    if (args.service !== undefined) argv.push(args.service);
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },

  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv = [...composeBase(args), 'restart'];
    if (args.service !== undefined) argv.push(args.service);
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },

  parseResult: (raw) => ({ raw: raw.stdout.trim() }),

  buildVerifyCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv = [...composeBase(args), 'ps', '--format', 'json'];
    if (args.service !== undefined) argv.push(args.service);
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },

  buildRollbackCommand: (args, ctx, _preState) => {
    // Restart has no "previous state" to restore. If the restart left a
    // container down, the conservative floor is to bring it back up.
    const env = requireEnv(ctx);
    const argv = [...composeBase(args), 'up', '-d'];
    if (args.service !== undefined) argv.push(args.service);
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },
};
