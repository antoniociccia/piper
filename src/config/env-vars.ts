/**
 * Single source of truth for the names of environment variables PIPER reads.
 *
 * Centralised so a rename or a typo (e.g. `PIPER_PROVIDER` vs `PIPER_PROVIDR`)
 * surfaces as a TypeScript error, not a silent runtime "the env var did
 * nothing" bug. The README's env-vars table is meant to mirror this object —
 * keep them in sync.
 *
 * Only the *names* live here. Parsing, defaults and precedence remain in the
 * call sites — env-var precedence is policy, not just naming.
 */
export const ENV_VARS = {
  /** Provider id override: `openrouter | ollama | lmstudio | llamacpp | vllm | custom`. */
  PROVIDER: 'PIPER_PROVIDER',
  /** Endpoint override; overrides both credentials.json `base_url` and provider default. */
  BASE_URL: 'PIPER_BASE_URL',
  /** API key for the chat model provider. */
  API_KEY: 'PIPER_API_KEY',
  /** Backwards-compat fallback for `API_KEY` when targeting OpenRouter. */
  OPENROUTER_API_KEY: 'OPENROUTER_API_KEY',
  /** Model id (e.g. `deepseek/deepseek-v4-pro`, `qwen2.5-coder:7b`). */
  MODEL: 'PIPER_MODEL',
  /** Hard per-session USD budget. PIPER refuses to make a call that would cross this. */
  MAX_SESSION_COST_USD: 'PIPER_MAX_SESSION_COST_USD',

  /** Embedding backend: `wasm | http | openrouter | none`. */
  EMBEDDING_BACKEND: 'PIPER_EMBEDDING_BACKEND',
  /** Embedding provider id when backend=`http` (otherwise inferred from chat provider). */
  EMBEDDING_PROVIDER: 'PIPER_EMBEDDING_PROVIDER',
  /** Endpoint override for the embedding provider. */
  EMBEDDING_BASE_URL: 'PIPER_EMBEDDING_BASE_URL',
  /** Embedding model id. */
  EMBEDDING_MODEL: 'PIPER_EMBEDDING_MODEL',

  /** Persistent storage root for PGlite + reports. Default: `~/.piper/data`. */
  DATA_DIR: 'PIPER_DATA_DIR',
  /** Set to `'1'` to force in-memory PGlite (sessions die on exit). */
  EPHEMERAL: 'PIPER_EPHEMERAL',
  /** Override credentials.json location. */
  CREDENTIALS_FILE: 'PIPER_CREDENTIALS_FILE',

  /** Set to `'1'` to dump auth-resolution debug info on startup. */
  DEBUG_AUTH: 'PIPER_DEBUG_AUTH',
  /** Set when E2E suite is driving the binary; relaxes some guards. */
  E2E: 'PIPER_E2E',
} as const;

export type PiperEnvVarName = (typeof ENV_VARS)[keyof typeof ENV_VARS];

/** Read an env var by its canonical key — typed lookup, no string typos. */
export function readEnv(key: PiperEnvVarName): string | undefined {
  const v = process.env[key];
  return v !== undefined && v !== '' ? v : undefined;
}
