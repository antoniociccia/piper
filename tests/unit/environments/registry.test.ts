import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';

import { createEnvironmentRegistry, type EnvironmentRegistry } from '../../../src/environments/registry.ts';
import { InvalidEnvironmentError } from '../../../src/environments/types.ts';
import { closeDb, openDb } from '../../../src/memory/db.ts';

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

describe('environments/registry — upsert and get', () => {
  test('upsert returns the persisted row', async () => {
    const env = await registry.upsert({
      name: 'staging',
      host: '10.0.0.5',
      sshUser: 'deploy',
      port: 2222,
      description: 'staging webapp',
      tags: ['staging', 'web'],
    });
    expect(env.name).toBe('staging');
    expect(env.host).toBe('10.0.0.5');
    expect(env.sshUser).toBe('deploy');
    expect(env.port).toBe(2222);
    expect(env.description).toBe('staging webapp');
    expect(env.tags).toEqual(['staging', 'web']);
  });

  test('get returns null for unknown name', async () => {
    const result = await registry.get('nope');
    expect(result).toBeNull();
  });

  test('get returns the row after upsert', async () => {
    await registry.upsert({ name: 'prod', host: 'prod.example.com', sshUser: 'deploy' });
    const env = await registry.get('prod');
    expect(env?.name).toBe('prod');
    expect(env?.host).toBe('prod.example.com');
    expect(env?.sshUser).toBe('deploy');
    expect(env?.port).toBeUndefined();
    expect(env?.tags).toEqual([]);
  });

  test('upsert overwrites existing on conflict', async () => {
    await registry.upsert({ name: 'db', host: '1.2.3.4', sshUser: 'root' });
    await registry.upsert({ name: 'db', host: '5.6.7.8', sshUser: 'ops', port: 22 });
    const env = await registry.get('db');
    expect(env?.host).toBe('5.6.7.8');
    expect(env?.sshUser).toBe('ops');
    expect(env?.port).toBe(22);
  });
});

describe('environments/registry — remove', () => {
  test('remove returns true when row existed', async () => {
    await registry.upsert({ name: 'tmp', host: 'h', sshUser: 'u' });
    const removed = await registry.remove('tmp');
    expect(removed).toBe(true);
    expect(await registry.get('tmp')).toBeNull();
  });

  test('remove returns false when row did not exist', async () => {
    expect(await registry.remove('ghost')).toBe(false);
  });
});

describe('environments/registry — list', () => {
  test('list returns empty when nothing registered', async () => {
    expect(await registry.list()).toEqual([]);
  });

  test('list returns all environments sorted by name', async () => {
    await registry.upsert({ name: 'c-env', host: 'h1', sshUser: 'u' });
    await registry.upsert({ name: 'a-env', host: 'h2', sshUser: 'u' });
    await registry.upsert({ name: 'b-env', host: 'h3', sshUser: 'u' });
    const all = await registry.list();
    expect(all.map((e) => e.name)).toEqual(['a-env', 'b-env', 'c-env']);
  });

  test('list with tag filter returns only matching', async () => {
    await registry.upsert({ name: 'prod-web', host: 'h', sshUser: 'u', tags: ['prod', 'web'] });
    await registry.upsert({ name: 'staging-web', host: 'h', sshUser: 'u', tags: ['staging', 'web'] });
    await registry.upsert({ name: 'prod-db', host: 'h', sshUser: 'u', tags: ['prod', 'db'] });
    const prods = await registry.list({ tag: 'prod' });
    expect(prods.map((e) => e.name).sort()).toEqual(['prod-db', 'prod-web']);
  });
});

describe('environments/registry — describeForLLM', () => {
  test('describes empty state with guidance', async () => {
    const desc = await registry.describeForLLM();
    expect(desc).toContain('No environments registered');
  });

  test('describes all entries with user@host[:port] [tags] — description', async () => {
    await registry.upsert({
      name: 'prod',
      host: 'prod.example.com',
      sshUser: 'deploy',
      port: 22,
      description: 'production app server',
      tags: ['prod', 'critical'],
    });
    await registry.upsert({
      name: 'staging',
      host: '10.0.0.10',
      sshUser: 'ops',
      tags: ['staging'],
    });
    const desc = await registry.describeForLLM();
    expect(desc).toContain('Available environments (2)');
    expect(desc).toContain('prod: deploy@prod.example.com:22 [prod, critical] — production app server');
    expect(desc).toContain('staging: ops@10.0.0.10 [staging]');
  });
});

describe('environments/registry — validation', () => {
  test('invalid name shape throws InvalidEnvironmentError', async () => {
    await expect(
      registry.upsert({ name: '1bad', host: 'h', sshUser: 'u' }),
    ).rejects.toBeInstanceOf(InvalidEnvironmentError);
    await expect(
      registry.upsert({ name: 'with space', host: 'h', sshUser: 'u' }),
    ).rejects.toBeInstanceOf(InvalidEnvironmentError);
  });

  test('empty host throws', async () => {
    await expect(
      registry.upsert({ name: 'ok', host: '', sshUser: 'u' }),
    ).rejects.toBeInstanceOf(InvalidEnvironmentError);
  });

  test('empty sshUser throws', async () => {
    await expect(
      registry.upsert({ name: 'ok', host: 'h', sshUser: '' }),
    ).rejects.toBeInstanceOf(InvalidEnvironmentError);
  });

  test('out-of-range port throws', async () => {
    await expect(
      registry.upsert({ name: 'ok', host: 'h', sshUser: 'u', port: 70000 }),
    ).rejects.toBeInstanceOf(InvalidEnvironmentError);
  });
});
