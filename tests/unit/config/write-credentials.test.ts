import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readPiperCredentials } from '../../../src/config/credentials.ts';
import { writeCredentials } from '../../../src/config/write-credentials.ts';

let tmpDir: string;
let credentialsPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'piper-write-'));
  credentialsPath = join(tmpDir, 'sub', 'credentials.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('config/write-credentials', () => {
  test('writes JSON with snake_case keys and mode 600', async () => {
    await writeCredentials(credentialsPath, {
      openrouterApiKey: 'sk-or-test',
      defaultProvider: 'openrouter',
      defaultModel: 'deepseek/deepseek-v4-pro',
      maxSessionCostUsd: 0.5,
      environments: [
        {
          name: 'staging',
          host: '10.0.0.5',
          sshUser: 'deploy',
          port: 22,
          identityFile: '/Users/me/.ssh/id_ed25519',
          description: 'staging server',
          tags: ['staging'],
        },
      ],
    });

    const stat = statSync(credentialsPath);
    expect((stat.mode & 0o777).toString(8)).toBe('600');

    const text = await Bun.file(credentialsPath).text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['openrouter_api_key']).toBe('sk-or-test');
    expect(parsed['default_provider']).toBe('openrouter');
    expect(parsed['default_model']).toBe('deepseek/deepseek-v4-pro');
    expect(parsed['max_session_cost_usd']).toBe(0.5);
    expect((parsed['environments'] as Record<string, unknown>)['staging']).toEqual({
      host: '10.0.0.5',
      ssh_user: 'deploy',
      port: 22,
      identity_file: '/Users/me/.ssh/id_ed25519',
      description: 'staging server',
      tags: ['staging'],
    });
  });

  test('output is readable by readPiperCredentials', async () => {
    await writeCredentials(credentialsPath, {
      openrouterApiKey: 'sk-or-rt',
      defaultProvider: 'openrouter',
      defaultModel: 'deepseek/deepseek-v4-flash',
      environments: [{ name: 'prod', host: 'h', sshUser: 'u' }],
    });
    const cred = await readPiperCredentials(credentialsPath);
    expect(cred?.openrouterApiKey).toBe('sk-or-rt');
    expect(cred?.defaultProvider).toBe('openrouter');
    expect(cred?.defaultModel).toBe('deepseek/deepseek-v4-flash');
    expect(cred?.environments).toHaveLength(1);
    expect(cred?.environments[0]?.name).toBe('prod');
  });

  test('omits keys not provided', async () => {
    await writeCredentials(credentialsPath, {
      defaultProvider: 'ollama',
      defaultModel: 'qwen3-coder:30b',
    });
    const text = await Bun.file(credentialsPath).text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed['openrouter_api_key']).toBeUndefined();
    expect(parsed['environments']).toBeUndefined();
    expect(parsed['max_session_cost_usd']).toBeUndefined();
  });

  test('creates parent directory if missing', async () => {
    const deep = join(tmpDir, 'a', 'b', 'c', 'credentials.json');
    await writeCredentials(deep, { defaultProvider: 'ollama', defaultModel: 'x' });
    expect(await Bun.file(deep).exists()).toBe(true);
  });
});
