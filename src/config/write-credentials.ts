import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EnvironmentInput } from '../environments/types.ts';

export interface CredentialsToWrite {
  readonly openrouterApiKey?: string;
  readonly defaultProvider?: string;
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly maxSessionCostUsd?: number;
  readonly environments?: readonly EnvironmentInput[];
}

function toFileShape(c: CredentialsToWrite): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (c.openrouterApiKey !== undefined && c.openrouterApiKey !== '') {
    out['openrouter_api_key'] = c.openrouterApiKey;
  }
  if (c.defaultProvider !== undefined && c.defaultProvider !== '') {
    out['default_provider'] = c.defaultProvider;
  }
  if (c.baseUrl !== undefined && c.baseUrl !== '') {
    out['base_url'] = c.baseUrl;
  }
  if (c.defaultModel !== undefined && c.defaultModel !== '') {
    out['default_model'] = c.defaultModel;
  }
  if (c.maxSessionCostUsd !== undefined) {
    out['max_session_cost_usd'] = c.maxSessionCostUsd;
  }
  if (c.environments !== undefined && c.environments.length > 0) {
    const envs: Record<string, Record<string, unknown>> = {};
    for (const e of c.environments) {
      const entry: Record<string, unknown> = { host: e.host, ssh_user: e.sshUser };
      if (e.port !== undefined) entry['port'] = e.port;
      if (e.identityFile !== undefined) entry['identity_file'] = e.identityFile;
      if (e.description !== undefined) entry['description'] = e.description;
      if (e.tags !== undefined && e.tags.length > 0) entry['tags'] = e.tags;
      envs[e.name] = entry;
    }
    out['environments'] = envs;
  }
  return out;
}

export async function writeCredentials(path: string, credentials: CredentialsToWrite): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const json = `${JSON.stringify(toFileShape(credentials), null, 2)}\n`;
  await Bun.write(path, json);
  await chmod(path, 0o600);
}
