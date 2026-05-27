import { render, Box, Text } from 'ink';

import { registerBuiltins } from './actions/builtin/index.ts';
import { createCatalog } from './actions/catalog.ts';
import { readPiperCredentials, defaultCredentialsPath } from './config/credentials.ts';
import { ENV_VARS, readEnv } from './config/env-vars.ts';
import { createEnvironmentRegistry } from './environments/registry.ts';
import { createExecutor } from './exec/executor.ts';
import type { MutationApprovalCallback } from './exec/types.ts';
import { createLogger } from './logging/logger.ts';
import { createChatHistory } from './memory/chat-history.ts';
import { closeDb, openDb } from './memory/db.ts';
import { createCostTracker } from './models/cost.ts';
import { persistEmbeddingBackend, persistModelChoice } from './config/persist.ts';
import { createOpenAIChatClient } from './models/client.ts';
import type { ModelClient } from './models/types.ts';
import type { ModelSelection } from './tui/ModelPicker.tsx';
import { getPricing } from './models/pricing.ts';
import { getProvider, PROVIDERS, type ProviderId } from './models/providers.ts';
import { createOpenAIEmbeddingClient, type EmbeddingClient } from './rag/embedding-client.ts';
import { ingestRunbooks } from './rag/ingest.ts';
import { LOCAL_EMBEDDING_PRESETS } from './rag/presets.ts';

import { createSessionsRepo } from './memory/sessions.ts';

import { App } from './tui/App.tsx';
import * as bootLoader from './tui/boot-loader-controller.ts';
import {
  EmbeddingBackendPicker,
  type EmbeddingBackendChoice,
} from './tui/EmbeddingBackendPicker.tsx';
import { SessionPicker } from './tui/SessionPicker.tsx';
import { Wizard } from './tui/Wizard.tsx';

interface BootConfig {
  readonly providerId: ProviderId;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly maxSessionCostUsd?: number;
  readonly dataDir?: string;
  readonly credentialsPath: string;
  readonly credentialsLoaded: boolean;
  readonly compactionKeepRecent?: number;
  readonly compactionTriggerPct?: number;
  readonly maxFollowupIterations?: number;
}

function looksLikeApiKey(provider: ProviderId, value: string | undefined): boolean {
  if (value === undefined || value.length < 16) return false;
  // OpenRouter keys are sk-or-v...; OpenAI direct are sk-...; Anthropic sk-ant-...
  // For local/custom providers, we accept anything non-trivial.
  if (provider === 'openrouter') return value.startsWith('sk-or-') || value.startsWith('sk-');
  return true;
}

async function readConfig(): Promise<{
  config: BootConfig;
  preEnvironments: Awaited<ReturnType<typeof readPiperCredentials>>;
  warnings: readonly string[];
}> {
  const warnings: string[] = [];
  const credentialsPath = defaultCredentialsPath();
  let credentials: Awaited<ReturnType<typeof readPiperCredentials>> = null;
  try {
    credentials = await readPiperCredentials();
  } catch {
    credentials = null;
  }

  const providerId = (readEnv(ENV_VARS.PROVIDER) ??
    credentials?.defaultProvider ??
    'openrouter') as ProviderId;
  const provider = getProvider(providerId);
  const baseUrl =
    readEnv(ENV_VARS.BASE_URL) ?? credentials?.baseUrl ?? provider.defaultBaseUrl ?? '';

  const candidates: ReadonlyArray<{ source: string; value: string | undefined }> = [
    { source: `${ENV_VARS.API_KEY} env`, value: readEnv(ENV_VARS.API_KEY) },
    { source: `${ENV_VARS.OPENROUTER_API_KEY} env`, value: readEnv(ENV_VARS.OPENROUTER_API_KEY) },
    { source: 'credentials.json', value: credentials?.openrouterApiKey },
  ];
  let apiKey: string | undefined;
  for (const c of candidates) {
    if (c.value === undefined || c.value === '') continue;
    if (looksLikeApiKey(providerId, c.value)) {
      apiKey = c.value;
      break;
    }
    warnings.push(
      `ignoring ${c.source}: value does not look like a ${providerId} API key ` +
        `(length=${c.value.length}, prefix=${c.value.slice(0, 6)})`,
    );
  }
  const model =
    readEnv(ENV_VARS.MODEL) ??
    credentials?.defaultModel ??
    (provider.kind === 'remote' ? 'deepseek/deepseek-v4-pro' : 'mistralai/devstral-small-2-24b');
  const rawBudget = readEnv(ENV_VARS.MAX_SESSION_COST_USD);
  const maxSessionCostUsd =
    rawBudget !== undefined
      ? Number(rawBudget)
      : credentials?.maxSessionCostUsd;
  const dataDir = readEnv(ENV_VARS.DATA_DIR);

  return {
    config: {
      providerId,
      baseUrl,
      model,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(maxSessionCostUsd === undefined ? {} : { maxSessionCostUsd }),
      ...(dataDir === undefined ? {} : { dataDir }),
      credentialsPath,
      credentialsLoaded: credentials !== null,
      ...(credentials?.compactionKeepRecent === undefined
        ? {}
        : { compactionKeepRecent: credentials.compactionKeepRecent }),
      ...(credentials?.compactionTriggerPct === undefined
        ? {}
        : { compactionTriggerPct: credentials.compactionTriggerPct }),
      ...(credentials?.maxFollowupIterations === undefined
        ? {}
        : { maxFollowupIterations: credentials.maxFollowupIterations }),
    },
    preEnvironments: credentials,
    warnings,
  };
}

async function maybeRunWizard(): Promise<void> {
  const credentialsExists = await Bun.file(defaultCredentialsPath()).exists();
  if (credentialsExists) return;
  const provider = readEnv(ENV_VARS.PROVIDER);
  const hasMinimumEnv =
    readEnv(ENV_VARS.API_KEY) !== undefined ||
    readEnv(ENV_VARS.OPENROUTER_API_KEY) !== undefined ||
    provider === 'ollama' ||
    provider === 'lmstudio' ||
    provider === 'llamacpp' ||
    provider === 'vllm';
  if (hasMinimumEnv) return;

  await new Promise<void>((resolve) => {
    const instance = render(
      <Wizard
        onComplete={() => {
          instance.unmount();
          resolve();
        }}
      />,
    );
    void instance.waitUntilExit().then(() => resolve());
  });
}

/**
 * One-off picker for the embedding backend, rendered before the App starts.
 * Resolves once the user confirms; the choice is persisted to credentials.json
 * so we don't ask again next time.
 */
async function promptEmbeddingBackend(hasOpenRouterKey: boolean): Promise<EmbeddingBackendChoice> {
  return new Promise<EmbeddingBackendChoice>((resolve) => {
    const inst = render(
      <EmbeddingBackendPicker
        hasOpenRouterKey={hasOpenRouterKey}
        onSelect={(choice) => {
          inst.unmount();
          resolve(choice);
        }}
      />,
    );
  });
}

/**
 * Render a one-off SessionPicker in its own Ink instance and resolve with the
 * picked session id (or null on cancel / no sessions). Used by --resume.
 */
async function pickPreviousSession(
  sessionsRepo: ReturnType<typeof createSessionsRepo>,
  currentSessionId: string,
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const inst = render(
      <SessionPicker
        sessionsRepo={sessionsRepo}
        currentSessionId={currentSessionId}
        onSelect={(id) => {
          inst.unmount();
          resolve(id);
        }}
        onCancel={() => {
          inst.unmount();
          resolve(null);
        }}
      />,
    );
    void inst.waitUntilExit().then(() => resolve(null));
  });
}

async function main(): Promise<void> {
  await maybeRunWizard();

  const { config: cfg, preEnvironments, warnings: configWarnings } = await readConfig();
  // Mutable copy — the boot pipeline below appends late-discovered warnings
  // (failed persist, RAG ingest issues, resume picker bailout) before we
  // flush them all to the scrollback once App takes over the screen.
  const warnings: string[] = [...configWarnings];
  const provider = getProvider(cfg.providerId);

  // Boot loader takes over the screen from here until App mounts. Anything
  // that used to scroll past as a stderr line becomes an update to the
  // bubble. We collect warnings to surface after App mounts (via an
  // initial info entry); we do NOT spam the terminal here.
  bootLoader.show('Booting PIPER…');

  if (cfg.baseUrl === '') {
    bootLoader.hide();
    renderFatal(`no base URL: set PIPER_BASE_URL or pick a provider with a default`);
    return;
  }
  if (provider.requiresApiKey && (cfg.apiKey === undefined || cfg.apiKey === '')) {
    bootLoader.hide();
    renderFatal(
      `provider "${cfg.providerId}" requires an API key.\n` +
        `Set ${ENV_VARS.OPENROUTER_API_KEY} (env) OR add { "openrouter_api_key": "sk-or-..." } to ${cfg.credentialsPath}`,
    );
    return;
  }

  if (process.env[ENV_VARS.DEBUG_AUTH] === '1') {
    const keyPrefix = cfg.apiKey === undefined ? 'NONE' : cfg.apiKey.slice(0, 12);
    const keyLength = cfg.apiKey === undefined ? 0 : cfg.apiKey.length;
    const envHasOpenrouter = readEnv(ENV_VARS.OPENROUTER_API_KEY) !== undefined ? 'YES' : 'no';
    const envHasPiperKey = readEnv(ENV_VARS.API_KEY) !== undefined ? 'YES' : 'no';
    process.stderr.write(
      `[piper:boot] provider=${cfg.providerId} model=${cfg.model} ` +
        `apiKey=${keyPrefix}…(${keyLength}) ` +
        `from=${cfg.credentialsLoaded ? 'credentials.json' : 'env'} ` +
        `${ENV_VARS.OPENROUTER_API_KEY}_in_env=${envHasOpenrouter} ${ENV_VARS.API_KEY}_in_env=${envHasPiperKey} ` +
        `path=${cfg.credentialsPath}\n`,
    );
  }

  const logger = createLogger({ level: 'info' });
  // Persistent storage by default: previous sessions / chat history / RAG
  // remain available across PIPER restarts. PIPER_DATA_DIR overrides the
  // PARENT directory; PGlite gets a dedicated subdir so it can manage its
  // cluster without interference from other PIPER artefacts (reports, etc.).
  // PIPER_EPHEMERAL=1 forces an in-memory DB (useful only for tests).
  const ephemeral = process.env[ENV_VARS.EPHEMERAL] === '1';
  const persistRoot =
    cfg.dataDir !== undefined ? cfg.dataDir : `${process.env['HOME'] ?? '.'}/.piper/data`;
  const pglitePath = `${persistRoot}/pglite`;
  bootLoader.update('Opening local database…');
  const db = await openDb(
    ephemeral ? {} : { storage: { kind: 'file', path: pglitePath } },
  );

  const pricing = getPricing(cfg.model);
  const client = createOpenAIChatClient({
    id: `${cfg.providerId}/${cfg.model}`,
    baseUrl: cfg.baseUrl,
    ...(cfg.apiKey === undefined ? {} : { apiKey: cfg.apiKey }),
    defaultModel: cfg.model,
    capabilities: {
      toolCalling: pricing?.toolCalling ?? true,
      maxContextTokens: pricing?.maxContextTokens ?? 128_000,
      streaming: true,
    },
    isLocal: provider.kind === 'local',
    enforcePrivacyDeny: provider.enforcePrivacyDeny,
  });

  // Factory for runtime model switching via /model.
  // Builds the new ModelClient AND persists the choice to credentials.json so
  // the next session (and /resume) starts on the same model.
  const onSwitchModel = async (sel: ModelSelection): Promise<ModelClient | null> => {
    try {
      let newClient: ModelClient;
      if (sel.kind === 'openrouter') {
        newClient = createOpenAIChatClient({
          id: `openrouter/${sel.model}`,
          baseUrl: 'https://openrouter.ai/api/v1',
          ...(cfg.apiKey === undefined ? {} : { apiKey: cfg.apiKey }),
          defaultModel: sel.model,
          capabilities: {
            toolCalling: sel.toolCalling,
            maxContextTokens: sel.contextLength > 0 ? sel.contextLength : 128_000,
            streaming: true,
          },
          isLocal: false,
          enforcePrivacyDeny: true,
        });
        await persistModelChoice({
          provider: 'openrouter',
          model: sel.model,
          baseUrl: 'https://openrouter.ai/api/v1',
        });
      } else {
        const baseUrl = `http://${sel.host}:${sel.port}/v1`;
        newClient = createOpenAIChatClient({
          id: `${sel.provider}/${sel.model}`,
          baseUrl,
          defaultModel: sel.model,
          capabilities: {
            toolCalling: true,
            maxContextTokens: 32_000,
            streaming: true,
          },
          isLocal: true,
        });
        await persistModelChoice({ provider: sel.provider, model: sel.model, baseUrl });
      }
      return newClient;
    } catch {
      return null;
    }
  };

  const catalog = createCatalog();
  registerBuiltins(catalog);
  const registry = createEnvironmentRegistry(db);
  const chatHistory = createChatHistory(db);

  // Memory backend: ask the user once if the field is missing from credentials,
  // then persist the choice so we don't ask again. Env vars / preset still win.
  let effectiveCreds = preEnvironments;
  const hasBackendChoice =
    readEnv(ENV_VARS.EMBEDDING_BACKEND) !== undefined ||
    (preEnvironments?.embeddingBackend !== undefined);
  if (!hasBackendChoice) {
    // The backend picker is an interactive Ink overlay — hide the boot loader
    // while it's on screen so the two don't fight for the terminal, then
    // restore it after the choice is made.
    bootLoader.hide();
    const choice = await promptEmbeddingBackend(cfg.apiKey !== undefined && cfg.apiKey !== '');
    bootLoader.show('Booting PIPER…');
    try {
      await persistEmbeddingBackend(choice);
    } catch (err) {
      warnings.push(
        `could not persist embedding backend choice: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Reload credentials so the new backend is picked up downstream.
    effectiveCreds =
      preEnvironments === null
        ? ({ path: '', environments: [], embeddingBackend: choice } as unknown as typeof preEnvironments)
        : { ...preEnvironments, embeddingBackend: choice };
  }

  // Optional embedding client + RAG ingest. We tolerate failures silently so a
  // slow/missing local embedder doesn't block the TUI from starting.
  bootLoader.update('Loading the embedder…');
  const embedder = await buildEmbeddingClient(cfg, effectiveCreds);
  if (embedder !== null) {
    try {
      const { ensureRagDimension } = await import('./rag/ensure-schema.ts');
      const { recreated, previousDimension } = await ensureRagDimension(db, embedder.dimension);
      if (recreated) {
        bootLoader.update(
          'Re-indexing the knowledge base…',
          `(embedder changed dimension: ${previousDimension} → ${embedder.dimension})`,
        );
      } else {
        bootLoader.update('Indexing the knowledge base…');
      }
      await ingestRunbooks({ db, embedder, projectRoot: process.cwd() });
    } catch (err) {
      warnings.push(`RAG ingest skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Auto-register environments declared in ~/.piper/credentials.json
  let autoRegistered = 0;
  if (preEnvironments !== null) {
    for (const env of preEnvironments.environments) {
      try {
        await registry.upsert(env);
        autoRegistered += 1;
      } catch {
        // skip invalid; user can /env add manually later
      }
    }
  }

  // Mutation approval bridge. The Executor is created here, before the App
  // mounts. The App's `registerMutationApprover` (called from a useEffect)
  // hands us its own callback, which we slot into this mutable holder. The
  // executor delegates every mutation proposal to that callback. Until the
  // App registers (or after it unmounts), the holder stays null and any
  // mutate/destructive attempt is rejected with a clear message.
  let mutationApprovalCb: MutationApprovalCallback | null = null;

  const executor = createExecutor({
    db,
    catalog,
    registry,
    logger,
    ...(embedder === null ? {} : { embedder }),
    onMutationProposal: async (proposal) => {
      if (mutationApprovalCb === null) {
        return { kind: 'reject', reason: 'TUI not ready to approve mutations' };
      }
      return mutationApprovalCb(proposal);
    },
  });
  const costTracker = createCostTracker({
    db,
    ...(cfg.maxSessionCostUsd === undefined ? {} : { maxSessionCostUsd: cfg.maxSessionCostUsd }),
  });

  const sessionsRepo = createSessionsRepo(db);

  // --resume: pre-app session picker. If the user picks a session, we adopt
  // its id (and don't insert a new sessions row); otherwise we fall through
  // and create a fresh one.
  const wantsResume = process.argv.includes('--resume');
  let resumedSessionId: string | null = null;
  let resumedTitle: string | null = null;
  if (wantsResume) {
    // Session picker is an interactive overlay; tuck the boot bubble away
    // while it's on screen.
    bootLoader.hide();
    const picked = await pickPreviousSession(sessionsRepo, '');
    if (picked !== null) {
      resumedSessionId = picked;
      resumedTitle = await sessionsRepo.getTitle(picked);
    } else {
      warnings.push('no session picked — starting a fresh one');
    }
    bootLoader.show('Booting PIPER…');
  }

  const sessionId = resumedSessionId ?? `tui-${crypto.randomUUID()}`;
  if (resumedSessionId === null) {
    await db.query(
      `INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`,
      [
        sessionId,
        JSON.stringify({
          provider: cfg.providerId,
          model: cfg.model,
          baseUrl: cfg.baseUrl,
          maxSessionCostUsd: cfg.maxSessionCostUsd,
          credentialsLoaded: cfg.credentialsLoaded,
          autoRegisteredEnvironments: autoRegistered,
        }),
      ],
    );
  } else {
    // touch the resumed row so it appears top of /resume next time
    await sessionsRepo.touch(sessionId);
  }

  // Boot done — drop the comic bubble and hand the screen over to App.
  bootLoader.hide();

  // Surface any non-fatal boot warnings now that the screen is ours again.
  // These appear in the terminal scrollback above where App mounts, so the
  // user can scroll up if curious — but they don't dominate the first view.
  for (const w of warnings) {
    process.stderr.write(`[piper] ${w}\n`);
  }

  const instance = render(
    <App
      catalog={catalog}
      registry={registry}
      executor={executor}
      client={client}
      costTracker={costTracker}
      chatHistory={chatHistory}
      sessionsRepo={sessionsRepo}
      db={db}
      logger={logger}
      sessionId={sessionId}
      {...(embedder === null ? {} : { embedder })}
      {...(cfg.maxSessionCostUsd === undefined ? {} : { maxSessionCostUsd: cfg.maxSessionCostUsd })}
      {...(cfg.compactionKeepRecent === undefined
        ? {}
        : { compactionKeepRecent: cfg.compactionKeepRecent })}
      {...(cfg.compactionTriggerPct === undefined
        ? {}
        : { compactionTriggerPct: cfg.compactionTriggerPct })}
      {...(cfg.maxFollowupIterations === undefined
        ? {}
        : { maxFollowupIterations: cfg.maxFollowupIterations })}
      onSwitchModel={onSwitchModel}
      registerMutationApprover={(cb) => {
        mutationApprovalCb = cb;
      }}
      {...(cfg.apiKey === undefined ? {} : { openrouterApiKey: cfg.apiKey })}
      {...(resumedTitle === null ? {} : { initialTitle: resumedTitle })}
    />,
  );

  await instance.waitUntilExit();
  await closeDb(db);
}

type EmbeddingBackend = 'wasm' | 'http' | 'openrouter' | 'none';

async function probeHttp(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { signal: controller.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function buildEmbeddingClient(
  cfg: BootConfig,
  creds: Awaited<ReturnType<typeof readPiperCredentials>>,
): Promise<EmbeddingClient | null> {
  const explicit = (readEnv(ENV_VARS.EMBEDDING_BACKEND) ??
    creds?.embeddingBackend) as EmbeddingBackend | undefined;

  const tryHttp = async (): Promise<EmbeddingClient | null> => {
    const providerId = (readEnv(ENV_VARS.EMBEDDING_PROVIDER) ??
      creds?.embeddingProvider ??
      readEnv(ENV_VARS.PROVIDER) ??
      'ollama') as ProviderId;
    const provider = PROVIDERS[providerId];
    if (provider === undefined) return null;
    const preset = LOCAL_EMBEDDING_PRESETS[providerId];
    if (preset === null && providerId !== 'custom') return null;
    const baseUrl =
      readEnv(ENV_VARS.EMBEDDING_BASE_URL) ??
      creds?.embeddingBaseUrl ??
      provider.defaultBaseUrl ??
      null;
    if (baseUrl === null || baseUrl === '') return null;
    const modelId =
      readEnv(ENV_VARS.EMBEDDING_MODEL) ?? creds?.embeddingModel ?? preset?.modelId;
    if (modelId === undefined || modelId === '') return null;
    if (!(await probeHttp(baseUrl))) return null;
    const dimension = creds?.embeddingDimension ?? preset?.dimension ?? 768;
    return createOpenAIEmbeddingClient({
      id: `${providerId}/${modelId}`,
      baseUrl,
      modelId,
      dimension,
      isLocal: provider.kind === 'local',
      ...(cfg.apiKey === undefined ? {} : { apiKey: cfg.apiKey }),
    });
  };

  const tryOpenRouter = async (): Promise<EmbeddingClient | null> => {
    // OpenRouter exposes embeddings via the same /v1 endpoint. Costs money.
    if (cfg.apiKey === undefined || cfg.apiKey === '') return null;
    const modelId =
      readEnv(ENV_VARS.EMBEDDING_MODEL) ?? creds?.embeddingModel ?? 'openai/text-embedding-3-small';
    return createOpenAIEmbeddingClient({
      id: `openrouter/${modelId}`,
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: cfg.apiKey,
      modelId,
      dimension: creds?.embeddingDimension ?? 1536,
      isLocal: false,
    });
  };

  const tryWasm = async (): Promise<EmbeddingClient | null> => {
    try {
      const { createWasmEmbeddingClient } = await import('./rag/wasm-embedding-client.ts');
      return await createWasmEmbeddingClient({
        ...(creds?.embeddingModel === undefined ? {} : { modelId: creds.embeddingModel }),
        ...(creds?.embeddingDimension === undefined ? {} : { dimension: creds.embeddingDimension }),
        onProgress: (p) => {
          // Route progress into the boot bubble. Downloads are the only step
          // long enough to be worth surfacing per-file; once we hit `ready`
          // the next bootLoader.update from main() will overwrite this.
          if (p.status === 'downloading' && p.file !== undefined) {
            bootLoader.update('Loading the embedder…', `downloading ${p.file}`);
          }
        },
      });
    } catch {
      // Failure is non-fatal — caller falls back to no-RAG. Surfaced to the
      // user via the post-mount warnings panel rather than a stderr blob.
      return null;
    }
  };

  // Explicit choice wins. 'none' disables RAG entirely.
  if (explicit === 'none') return null;
  if (explicit === 'wasm') return tryWasm();
  if (explicit === 'http') return tryHttp();
  if (explicit === 'openrouter') return tryOpenRouter();

  // Auto: prefer local HTTP if reachable, else fall back to WASM. OpenRouter
  // is never picked automatically (costs money + privacy).
  const http = await tryHttp();
  if (http !== null) return http;
  return tryWasm();
}

function renderFatal(message: string): void {
  render(
    <Box flexDirection="column" paddingX={1}>
      <Text color="red" bold>PIPER cannot start</Text>
      <Text>{message}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Credentials file (preferred): ~/.piper/credentials.json</Text>
        <Text dimColor>{'  {'}</Text>
        <Text dimColor>{'    "openrouter_api_key": "sk-or-...",'}</Text>
        <Text dimColor>{'    "default_model": "deepseek/deepseek-v4-pro",'}</Text>
        <Text dimColor>{'    "max_session_cost_usd": 0.5,'}</Text>
        <Text dimColor>{'    "environments": {'}</Text>
        <Text dimColor>{'      "staging-01": { "host": "...", "ssh_user": "deploy", "identity_file": "..." }'}</Text>
        <Text dimColor>{'    }'}</Text>
        <Text dimColor>{'  }'}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>Or environment variables:</Text>
        <Text dimColor>  PIPER_PROVIDER          ollama | lmstudio | llamacpp | vllm | openrouter | custom</Text>
        <Text dimColor>  PIPER_BASE_URL          override the provider's default endpoint</Text>
        <Text dimColor>  PIPER_API_KEY           required for openrouter (or OPENROUTER_API_KEY)</Text>
        <Text dimColor>  PIPER_MODEL             model id (default depends on provider kind)</Text>
        <Text dimColor>  PIPER_MAX_SESSION_COST_USD   hard cap per session</Text>
        <Text dimColor>  PIPER_DATA_DIR          persistent PGlite storage (default: in-memory)</Text>
      </Box>
    </Box>,
  );
}

void main();
