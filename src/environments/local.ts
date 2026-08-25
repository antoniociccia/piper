import type { Environment } from './types.ts';

/**
 * The machine PIPER itself runs on.
 *
 * Every other target is an SSH host the user registered on purpose — that
 * allowlist is the boundary that stops a command from reaching a machine
 * nobody authorised. `local` is the one target that needs no host, so it is a
 * RESERVED name: `validateEnvironmentInput` refuses to register it, which is
 * what stops a user- or LLM-supplied environment from shadowing `local` and
 * silently turning a local command into a remote one (or the reverse).
 */
export const LOCAL_ENVIRONMENT_NAME = 'local';

/**
 * Sentinel connection fields. They are never used to connect — `buildSshArgvForEnv`
 * short-circuits on the local target before reading them. They are deliberately
 * not a routable host so that a future code path which forgets to short-circuit
 * fails loudly at `buildSshArgv` instead of quietly connecting somewhere.
 */
export const LOCAL_ENVIRONMENT: Environment = {
  name: LOCAL_ENVIRONMENT_NAME,
  host: '(local)',
  sshUser: '(local)',
  description: 'the machine PIPER is running on — no SSH, commands run as you',
  tags: ['builtin'],
};

/** True when `name` is the reserved local target. Case-insensitive. */
export function isLocalEnvironmentName(name: string): boolean {
  return name.trim().toLowerCase() === LOCAL_ENVIRONMENT_NAME;
}

/** True when this environment is the built-in local target. */
export function isLocalEnvironment(env: Environment | null | undefined): boolean {
  return env !== null && env !== undefined && isLocalEnvironmentName(env.name);
}
