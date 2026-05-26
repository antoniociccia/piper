import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { defaultCredentialsPath } from './credentials.ts';

export interface ModelChoice {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl?: string;
}

/**
 * Read the credentials file as raw JSON, set/overwrite a few keys, then write
 * it back with mode 0600. Preserves every other key already in the file.
 * Used by both `persistModelChoice` and `persistEmbeddingBackend`.
 *
 * Throws on filesystem I/O errors so the caller can surface the failure.
 */
async function updateCredentialKeys(
  updates: Readonly<Record<string, string | number | boolean>>,
): Promise<string> {
  const path = defaultCredentialsPath();
  const file = Bun.file(path);
  let raw: Record<string, unknown> = {};
  if (await file.exists()) {
    try {
      raw = (await file.json()) as Record<string, unknown>;
    } catch {
      // start from empty if file is corrupt — Bun.write will overwrite
      raw = {};
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    raw[k] = v;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await Bun.write(path, `${JSON.stringify(raw, null, 2)}\n`);
  // Match writeCredentials' hardening — the file may contain api keys.
  await chmod(path, 0o600);
  return path;
}

/**
 * Persist the user's currently selected model into ~/.piper/credentials.json
 * (or PIPER_CREDENTIALS_FILE). Preserves all other keys.
 */
export async function persistModelChoice(choice: ModelChoice): Promise<string> {
  const updates: Record<string, string> = {
    default_provider: choice.provider,
    default_model: choice.model,
  };
  if (choice.baseUrl !== undefined) updates['base_url'] = choice.baseUrl;
  return updateCredentialKeys(updates);
}

/**
 * Persist the user's chosen embedding backend ('wasm' | 'http' | 'openrouter' | 'none')
 * into the credentials file. Preserves all other keys.
 */
export async function persistEmbeddingBackend(
  backend: 'wasm' | 'http' | 'openrouter' | 'none',
): Promise<string> {
  return updateCredentialKeys({ embedding_backend: backend });
}
