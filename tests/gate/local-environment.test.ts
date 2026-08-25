import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';

import { registerBuiltins } from '../../src/actions/builtin/index.ts';
import { createCatalog } from '../../src/actions/catalog.ts';
import type { ActionExecContext } from '../../src/actions/types.ts';
import {
  LOCAL_ENVIRONMENT,
  LOCAL_ENVIRONMENT_NAME,
  isLocalEnvironment,
} from '../../src/environments/local.ts';
import { createEnvironmentRegistry, type EnvironmentRegistry } from '../../src/environments/registry.ts';
import { InvalidEnvironmentError } from '../../src/environments/types.ts';
import { buildSshArgvForEnv } from '../../src/exec/ssh.ts';
import { closeDb, openDb } from '../../src/memory/db.ts';

/**
 * `local` is the machine PIPER itself runs on — the only target reachable
 * without an SSH host. It is a RESERVED name: the whole point of the SSH
 * allowlist is that a command cannot reach a host the user never registered,
 * so a user- (or LLM-) supplied environment must never be able to shadow
 * `local` and quietly turn a local command into a remote one, or vice versa.
 */

let db: PGlite | null = null;
let registry: EnvironmentRegistry;

beforeEach(async () => {
  db = await openDb();
  registry = createEnvironmentRegistry(db);
});

afterEach(async () => {
  if (db !== null) {
    await closeDb(db);
    db = null;
  }
});

describe('local environment is reserved', () => {
  test('upsert refuses to register an environment named `local`', async () => {
    await expect(
      registry.upsert({ name: LOCAL_ENVIRONMENT_NAME, host: 'evil.example.com', sshUser: 'root' }),
    ).rejects.toThrow(InvalidEnvironmentError);
  });

  test('the reserved name is matched case-insensitively', async () => {
    await expect(
      registry.upsert({ name: 'LOCAL', host: 'evil.example.com', sshUser: 'root' }),
    ).rejects.toThrow(InvalidEnvironmentError);
  });

  test('get(`local`) resolves to the built-in target even with an empty registry', async () => {
    const env = await registry.get(LOCAL_ENVIRONMENT_NAME);
    expect(env).not.toBeNull();
    expect(isLocalEnvironment(env)).toBe(true);
  });

  test('a registered host cannot be mistaken for the local target', async () => {
    const staging = await registry.upsert({ name: 'staging', host: '10.0.0.5', sshUser: 'deploy' });
    expect(isLocalEnvironment(staging)).toBe(false);
  });
});

describe('local environment is visible to the planner', () => {
  test('describeForLLM lists the local target when no host is registered', async () => {
    const described = await registry.describeForLLM();
    expect(described).toContain(LOCAL_ENVIRONMENT_NAME);
    // The old text told the model there was nothing it could do at all.
    expect(described).not.toContain('No environments registered');
  });

  test('describeForLLM lists the local target alongside registered hosts', async () => {
    await registry.upsert({ name: 'staging', host: '10.0.0.5', sshUser: 'deploy' });
    const described = await registry.describeForLLM();
    expect(described).toContain(LOCAL_ENVIRONMENT_NAME);
    expect(described).toContain('staging');
  });
});

describe('local environment never produces an ssh invocation', () => {
  test('buildSshArgvForEnv returns the bare command for the local target', () => {
    const argv = buildSshArgvForEnv(LOCAL_ENVIRONMENT, ['uptime']);
    expect(argv).toEqual(['uptime']);
  });

  test('buildSshArgvForEnv still builds ssh for a real host', () => {
    const argv = buildSshArgvForEnv(
      { name: 'staging', host: '10.0.0.5', sshUser: 'deploy', tags: [] },
      ['uptime'],
    );
    expect(argv[0]).toBe('ssh');
    expect(argv.join(' ')).toContain('deploy@10.0.0.5');
  });

  test('a catalog action targets the local machine without ssh', () => {
    const catalog = createCatalog();
    registerBuiltins(catalog);
    const uptime = catalog.list().find((a) => a.name === 'system.uptime');
    if (uptime === undefined) throw new Error('system.uptime not in catalog');

    const ctx = {
      sessionId: 's' as ActionExecContext['sessionId'],
      environment: LOCAL_ENVIRONMENT,
    } as ActionExecContext;

    const argv = uptime.buildCommand({ environment: LOCAL_ENVIRONMENT_NAME }, ctx);
    expect(argv).toEqual(['uptime']);
    expect(argv.join(' ')).not.toContain('ssh');
  });
});
