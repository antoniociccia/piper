// `local.ts` imports from this file with `import type` only, so this cycle is
// erased at runtime.
import { isLocalEnvironmentName } from './local.ts';

export interface Environment {
  readonly name: string;
  readonly host: string;
  readonly sshUser: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly description?: string;
  readonly tags: readonly string[];
}

export interface EnvironmentInput {
  readonly name: string;
  readonly host: string;
  readonly sshUser: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

export class InvalidEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEnvironmentError';
  }
}

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export function validateEnvironmentInput(input: EnvironmentInput): void {
  if (!NAME_PATTERN.test(input.name)) {
    throw new InvalidEnvironmentError(
      `invalid environment name: ${input.name} (must match ${NAME_PATTERN})`,
    );
  }
  // `local` is the built-in target that runs commands without SSH. Letting a
  // row claim that name would let a registered host masquerade as the local
  // machine — or hide it — so the name is reserved, case-insensitively.
  if (isLocalEnvironmentName(input.name)) {
    throw new InvalidEnvironmentError(
      `environment name '${input.name}' is reserved for the machine PIPER runs on`,
    );
  }
  if (input.host.trim() === '') {
    throw new InvalidEnvironmentError('host must not be empty');
  }
  if (input.sshUser.trim() === '') {
    throw new InvalidEnvironmentError('sshUser must not be empty');
  }
  if (input.port !== undefined) {
    if (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65535) {
      throw new InvalidEnvironmentError(`port must be an integer in 1..65535, got ${input.port}`);
    }
  }
}
