import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readPiperCredentials } from '../../../src/config/credentials.ts';

let tmpDir: string;
let credentialsPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piper-cred-'));
  credentialsPath = join(tmpDir, 'credentials.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('config/credentials — file presence', () => {
  test('returns null when file does not exist', async () => {
    const result = await readPiperCredentials(join(tmpDir, 'nope.json'));
    expect(result).toBeNull();
  });

  test('throws on malformed JSON', async () => {
    writeFileSync(credentialsPath, '{ not valid json');
    await expect(readPiperCredentials(credentialsPath)).rejects.toThrow();
  });

  test('returns empty object envs when file is empty JSON object', async () => {
    writeFileSync(credentialsPath, '{}');
    const result = await readPiperCredentials(credentialsPath);
    expect(result).not.toBeNull();
    expect(result?.openrouterApiKey).toBeUndefined();
    expect(result?.environments).toEqual([]);
  });
});

describe('config/credentials — fields', () => {
  test('reads openrouter_api_key and other scalars', async () => {
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        openrouter_api_key: 'sk-or-test',
        default_model: 'deepseek/deepseek-v4-pro',
        default_provider: 'openrouter',
        max_session_cost_usd: 0.5,
      }),
    );
    const result = await readPiperCredentials(credentialsPath);
    expect(result?.openrouterApiKey).toBe('sk-or-test');
    expect(result?.defaultModel).toBe('deepseek/deepseek-v4-pro');
    expect(result?.defaultProvider).toBe('openrouter');
    expect(result?.maxSessionCostUsd).toBe(0.5);
  });

  test('ignores empty-string values', async () => {
    writeFileSync(
      credentialsPath,
      JSON.stringify({ openrouter_api_key: '', default_model: '' }),
    );
    const result = await readPiperCredentials(credentialsPath);
    expect(result?.openrouterApiKey).toBeUndefined();
    expect(result?.defaultModel).toBeUndefined();
  });
});

describe('config/credentials — environments', () => {
  test('parses environments map into EnvironmentInput[]', async () => {
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        environments: {
          prod: {
            host: 'prod.example.com',
            ssh_user: 'deploy',
            port: 22,
            identity_file: '/home/dev/.ssh/id_ed25519_prod',
            description: 'production web tier',
            tags: ['prod', 'web'],
          },
          staging: {
            host: '10.0.0.5',
            ssh_user: 'ubuntu',
          },
        },
      }),
    );
    const result = await readPiperCredentials(credentialsPath);
    expect(result?.environments).toHaveLength(2);
    const sh = result?.environments.find((e) => e.name === 'prod');
    expect(sh?.host).toBe('prod.example.com');
    expect(sh?.sshUser).toBe('deploy');
    expect(sh?.port).toBe(22);
    expect(sh?.identityFile).toBe('/home/dev/.ssh/id_ed25519_prod');
    expect(sh?.description).toBe('production web tier');
    expect(sh?.tags).toEqual(['prod', 'web']);
    const staging = result?.environments.find((e) => e.name === 'staging');
    expect(staging?.host).toBe('10.0.0.5');
    expect(staging?.port).toBeUndefined();
  });

  test('skips environments missing host or ssh_user', async () => {
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        environments: {
          'missing-user': { host: 'h' },
          'missing-host': { ssh_user: 'u' },
          'ok': { host: 'h', ssh_user: 'u' },
        },
      }),
    );
    const result = await readPiperCredentials(credentialsPath);
    expect(result?.environments.map((e) => e.name)).toEqual(['ok']);
  });
});

describe('config/credentials — path resolution', () => {
  test('PIPER_CREDENTIALS_FILE env var overrides the default path', async () => {
    writeFileSync(credentialsPath, JSON.stringify({ openrouter_api_key: 'sk-or-x' }));
    const prev = process.env['PIPER_CREDENTIALS_FILE'];
    process.env['PIPER_CREDENTIALS_FILE'] = credentialsPath;
    try {
      const result = await readPiperCredentials();
      expect(result?.openrouterApiKey).toBe('sk-or-x');
    } finally {
      if (prev === undefined) delete process.env['PIPER_CREDENTIALS_FILE'];
      else process.env['PIPER_CREDENTIALS_FILE'] = prev;
    }
  });
});
