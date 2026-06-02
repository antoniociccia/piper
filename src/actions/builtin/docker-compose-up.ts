import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import { elevateRemoteCommand } from '../../security/elevation.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

// docker.compose_up is the canonical M2 mutate action. It models the full
// HITL flow the executor expects from any mutate-tier entry:
//
//   snapshot  → `docker compose ps --format json`     (capture current state +
//                                                      image tags for rollback)
//   dry-run   → `docker compose config` + `pull --dry-run` when available
//                                                     (renders the merged
//                                                      compose file the user is
//                                                      about to apply)
//   execute   → `docker compose up -d [service]`     (the actual mutation)
//   verify    → `docker compose ps --format json`     (every declared service
//                                                      must be `running`)
//   rollback  → `docker compose down [service] &&    (only fires if verify
//                docker compose up -d [service]`      fails; relies on the
//                with image tags from snapshot        snapshot to restore prior
//                                                      tags via env-var
//                                                      override at re-up time)
//
// The action is intentionally minimal: it does NOT pull new images, does NOT
// modify the compose file, does NOT touch volumes. Those mutations are
// separate catalog entries (future). This one only restarts services with
// whatever the compose file currently declares, which is the most common
// deploy step in the orderly demo and most small-team setups.

const PATH_PATTERN = /^[A-Za-z0-9_./\-]+$/;
const SERVICE_PATTERN = /^[A-Za-z0-9_.\-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  project_dir: z
    .string()
    .regex(PATH_PATTERN, 'project_dir must be a safe path')
    .min(1),
  /**
   * Optional single service to (re)start. If omitted, the whole compose
   * project is brought up. We keep the door open to per-service deploys
   * since that's safer (smaller blast radius) than a full project up.
   */
  service: z
    .string()
    .regex(SERVICE_PATTERN, 'service must be a docker-compose service name')
    .min(1)
    .optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DockerComposeUpResult {
  readonly raw: string;
}

function composeBase(args: Args): string[] {
  return ['docker', 'compose', '-f', `${args.project_dir}/docker-compose.yml`];
}

export const dockerComposeUp: Action<Args, DockerComposeUpResult> = {
  name: 'docker.compose_up',
  tier: 'mutate',
  description:
    'Bring up a docker-compose project (or a single service of it) on the target host. Re-creates containers whose image or config changed since the last up. Use this to apply a redeploy AFTER you have confirmed the compose file is correct via the dry-run preview.',
  argsSchema,

  buildSnapshotCommand: (args, ctx) => {
    // Pre-state: which services are currently up, and on what image tags.
    // The JSON output is what `buildRollbackCommand` parses back to figure
    // out which tags to restore on failure.
    const env = requireEnv(ctx);
    const argv = [...composeBase(args), 'ps', '--format', 'json', '--all'];
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },

  buildDryRunCommand: (args, ctx) => {
    // `docker compose config` renders the resolved compose file (post env
    // var substitution, post profile merging). It's the closest thing
    // docker offers to a "dry-run diff" — the user reads this AS the diff,
    // mentally comparing against what they expect.
    //
    // We deliberately do NOT use `docker compose up --dry-run` (only in
    // Compose v2.22+, still inconsistent across hosts). `config` is
    // universal and read-only.
    const env = requireEnv(ctx);
    const argv = [...composeBase(args), 'config'];
    if (args.service !== undefined) argv.push(args.service);
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },

  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv = [...composeBase(args), 'up', '-d', '--remove-orphans'];
    if (args.service !== undefined) argv.push(args.service);
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },

  parseResult: (raw) => ({ raw: raw.stdout.trim() }),

  buildVerifyCommand: (args, ctx) => {
    // Read every service's state. The executor's verify step expects exit
    // code 0 AND parses the JSON to confirm all declared services are
    // `running`. We let the executor do the parse; the action just emits
    // the right shell.
    const env = requireEnv(ctx);
    const argv = [...composeBase(args), 'ps', '--format', 'json'];
    if (args.service !== undefined) argv.push(args.service);
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },

  buildRollbackCommand: (args, ctx, _preState) => {
    // MVP rollback: bring the project (or service) DOWN. We do NOT yet
    // re-up on the previous image tags — that would need to parse the
    // snapshot JSON and re-inject IMAGE_TAG env vars, which depends on
    // how the compose file references tags. Down-only is the conservative
    // floor: it stops a broken state from compounding.
    //
    // The snapshot is preserved in the audit log so a future
    // `docker.compose_restore` action (or the user by hand) can use it.
    const env = requireEnv(ctx);
    const argv = [...composeBase(args), 'down'];
    if (args.service !== undefined) argv.push(args.service);
    return buildSshArgvForEnv(env, [...elevateRemoteCommand(argv, ctx.elevation ?? 'none')]);
  },
};
