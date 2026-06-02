import { homedir } from 'node:os';
import { join } from 'node:path';

import type { EnvironmentInput } from '../environments/types.ts';
import { ENV_VARS } from './env-vars.ts';

interface RawEnvironment {
  readonly host?: unknown;
  readonly ssh_user?: unknown;
  readonly port?: unknown;
  readonly identity_file?: unknown;
  readonly description?: unknown;
  readonly tags?: unknown;
}

interface RawCredentials {
  readonly openrouter_api_key?: unknown;
  readonly default_model?: unknown;
  readonly default_provider?: unknown;
  readonly base_url?: unknown;
  readonly max_session_cost_usd?: unknown;
  readonly embedding_backend?: unknown; // 'wasm' | 'http' | 'openrouter'
  readonly embedding_provider?: unknown;
  readonly embedding_base_url?: unknown;
  readonly embedding_model?: unknown;
  readonly embedding_dimension?: unknown;
  readonly compaction_keep_recent?: unknown;
  readonly compaction_trigger_pct?: unknown;
  readonly max_followup_iterations?: unknown;
  readonly sudo_double_confirm_mutate?: unknown;
  readonly watch_webhooks?: unknown;
  readonly environments?: Record<string, RawEnvironment>;
}

export interface WatchWebhook {
  readonly name: string;
  readonly url: string;
}

export interface PiperCredentials {
  readonly path: string;
  readonly openrouterApiKey?: string;
  readonly defaultModel?: string;
  readonly defaultProvider?: string;
  readonly baseUrl?: string;
  readonly maxSessionCostUsd?: number;
  readonly embeddingBackend?: 'wasm' | 'http' | 'openrouter' | 'none';
  readonly embeddingProvider?: string;
  readonly embeddingBaseUrl?: string;
  readonly embeddingModel?: string;
  readonly embeddingDimension?: number;
  readonly compactionKeepRecent?: number;
  readonly compactionTriggerPct?: number;
  readonly maxFollowupIterations?: number;
  /** Mutate+sudo proposals require a second confirmation. Defaults to true. */
  readonly sudoDoubleConfirmMutate: boolean;
  readonly watchWebhooks: readonly WatchWebhook[];
  readonly environments: readonly EnvironmentInput[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asStringArray(v: unknown): readonly string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x !== '');
  return out.length === 0 ? undefined : out;
}

function parseEnvironment(name: string, raw: RawEnvironment): EnvironmentInput | null {
  const host = asString(raw.host);
  const sshUser = asString(raw.ssh_user);
  if (host === undefined || sshUser === undefined) return null;
  const port = asNumber(raw.port);
  const identityFile = asString(raw.identity_file);
  const description = asString(raw.description);
  const tags = asStringArray(raw.tags);

  return {
    name,
    host,
    sshUser,
    ...(port === undefined ? {} : { port }),
    ...(identityFile === undefined ? {} : { identityFile }),
    ...(description === undefined ? {} : { description }),
    ...(tags === undefined ? {} : { tags }),
  };
}

export function defaultCredentialsPath(): string {
  const override = process.env[ENV_VARS.CREDENTIALS_FILE];
  if (override !== undefined && override !== '') return override;
  return join(homedir(), '.piper', 'credentials.json');
}

export async function readPiperCredentials(
  path: string = defaultCredentialsPath(),
): Promise<PiperCredentials | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  let raw: RawCredentials;
  try {
    raw = (await file.json()) as RawCredentials;
  } catch {
    throw new Error(`malformed JSON in credentials file: ${path}`);
  }

  const environments: EnvironmentInput[] = [];
  if (raw.environments !== undefined && typeof raw.environments === 'object') {
    for (const [name, rawEnv] of Object.entries(raw.environments)) {
      const env = parseEnvironment(name, rawEnv);
      if (env !== null) environments.push(env);
    }
  }

  const out: PiperCredentials = {
    path,
    ...(asString(raw.openrouter_api_key) === undefined
      ? {}
      : { openrouterApiKey: raw.openrouter_api_key as string }),
    ...(asString(raw.default_model) === undefined ? {} : { defaultModel: raw.default_model as string }),
    ...(asString(raw.default_provider) === undefined ? {} : { defaultProvider: raw.default_provider as string }),
    ...(asString(raw.base_url) === undefined ? {} : { baseUrl: raw.base_url as string }),
    ...(asNumber(raw.max_session_cost_usd) === undefined
      ? {}
      : { maxSessionCostUsd: raw.max_session_cost_usd as number }),
    ...(asString(raw.embedding_backend) === undefined
      ? {}
      : (() => {
          const v = raw.embedding_backend as string;
          if (v === 'wasm' || v === 'http' || v === 'openrouter' || v === 'none') {
            return { embeddingBackend: v };
          }
          return {};
        })()),
    ...(asString(raw.embedding_provider) === undefined ? {} : { embeddingProvider: raw.embedding_provider as string }),
    ...(asString(raw.embedding_base_url) === undefined ? {} : { embeddingBaseUrl: raw.embedding_base_url as string }),
    ...(asString(raw.embedding_model) === undefined ? {} : { embeddingModel: raw.embedding_model as string }),
    ...(asNumber(raw.embedding_dimension) === undefined ? {} : { embeddingDimension: raw.embedding_dimension as number }),
    ...(asNumber(raw.compaction_keep_recent) === undefined
      ? {}
      : { compactionKeepRecent: raw.compaction_keep_recent as number }),
    ...(asNumber(raw.compaction_trigger_pct) === undefined
      ? {}
      : { compactionTriggerPct: raw.compaction_trigger_pct as number }),
    ...(asNumber(raw.max_followup_iterations) === undefined
      ? {}
      : { maxFollowupIterations: Math.max(0, Math.floor(raw.max_followup_iterations as number)) }),
    sudoDoubleConfirmMutate: raw.sudo_double_confirm_mutate === false ? false : true,
    watchWebhooks: parseWatchWebhooks(raw.watch_webhooks),
    environments,
  };
  return out;
}

function parseWatchWebhooks(raw: unknown): readonly WatchWebhook[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const result: WatchWebhook[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value !== '') {
      // Any non-empty string is accepted here on purpose: https enforcement
      // happens at send time (postWebhook in src/notify/webhook.ts refuses any
      // non-https scheme), so the config layer does not need to re-validate it.
      result.push({ name, url: value });
    }
  }
  return result;
}
