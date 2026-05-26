import { useCallback, useEffect, useReducer, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';

import { defaultCredentialsPath } from '../config/credentials.ts';
import { detectLocalProviders, listModelsFor, type DetectedProvider } from '../config/detect.ts';
import { writeCredentials } from '../config/write-credentials.ts';
import { DEFAULT_MODEL_BY_TIER, type Tier } from '../models/pricing.ts';
import { PROVIDERS, type ProviderId } from '../models/providers.ts';

interface BackendChoice {
  readonly providerId: ProviderId;
  readonly baseUrl: string;
  readonly displayName: string;
}

type Step =
  | { kind: 'detect' }
  | { kind: 'backend'; detected: readonly DetectedProvider[] }
  | { kind: 'api-key'; chosen: BackendChoice }
  | { kind: 'tier'; chosen: BackendChoice; apiKey: string }
  | { kind: 'local-model'; chosen: BackendChoice; models: readonly string[] }
  | { kind: 'budget'; chosen: BackendChoice; apiKey?: string; tier?: Tier; model: string }
  | { kind: 'env-prompt'; ctx: AssembledConfig }
  | { kind: 'env-name'; ctx: AssembledConfig }
  | { kind: 'env-target'; ctx: AssembledConfig; envName: string }
  | { kind: 'env-key'; ctx: AssembledConfig; envName: string; sshUser: string; host: string; port?: number }
  | { kind: 'confirm'; ctx: AssembledConfig }
  | { kind: 'writing'; ctx: AssembledConfig }
  | { kind: 'done'; path: string }
  | { kind: 'error'; message: string };

interface AssembledConfig {
  readonly providerId: ProviderId;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly tier?: Tier;
  readonly model: string;
  readonly maxSessionCostUsd?: number;
  readonly environment?: {
    readonly name: string;
    readonly sshUser: string;
    readonly host: string;
    readonly port?: number;
    readonly identityFile?: string;
  };
}

interface State {
  step: Step;
  input: string;
  errors: readonly string[];
}

type Action =
  | { type: 'set-step'; step: Step }
  | { type: 'append-input'; ch: string }
  | { type: 'backspace' }
  | { type: 'clear-input' }
  | { type: 'set-error'; messages: readonly string[] };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'set-step':
      return { ...state, step: action.step, input: '', errors: [] };
    case 'append-input':
      return { ...state, input: state.input + action.ch };
    case 'backspace':
      return { ...state, input: state.input.slice(0, -1) };
    case 'clear-input':
      return { ...state, input: '' };
    case 'set-error':
      return { ...state, errors: action.messages };
    default:
      return state;
  }
}

const TIER_ORDER: readonly Tier[] = ['featherweight', 'economy', 'balanced', 'premium'];

const TIER_LABEL: Readonly<Record<Tier, string>> = {
  featherweight: 'Featherweight ($)    — DeepSeek V4 Flash, $0.10/$0.20 per M tokens',
  economy: 'Economy ($$)         — DeepSeek V4 Pro, $0.44/$0.87 per M (recommended)',
  balanced: 'Balanced ($$$)       — Claude Sonnet, $3.00/$15.00 per M',
  premium: 'Premium ($$$$$)      — Claude Opus 4.7 Fast, $30/$150 per M',
  local: 'Local',
};

const TARGET_PATTERN = /^([A-Za-z0-9_-]+)@([A-Za-z0-9._-]+)(?::(\d+))?$/;
const ENV_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

export interface WizardProps {
  readonly onComplete: (path: string) => void;
}

export function Wizard({ onComplete }: WizardProps): JSX.Element {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, {
    step: { kind: 'detect' },
    input: '',
    errors: [],
  });
  const [, setTick] = useState(0);

  // Initial detection
  useEffect(() => {
    void (async () => {
      const detected = await detectLocalProviders();
      dispatch({ type: 'set-step', step: { kind: 'backend', detected } });
    })();
  }, []);

  // Animation tick
  useEffect(() => {
    if (state.step.kind !== 'detect' && state.step.kind !== 'writing') return;
    const interval = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(interval);
  }, [state.step.kind]);

  const handleEnter = useCallback(async (): Promise<void> => {
    const text = state.input.trim();

    switch (state.step.kind) {
      case 'backend': {
        const n = Number(text);
        const detected = state.step.detected;
        const total = detected.length + 2; // +OpenRouter + Custom
        if (!Number.isInteger(n) || n < 1 || n > total) {
          dispatch({ type: 'set-error', messages: [`pick a number 1..${total}`] });
          return;
        }
        if (n <= detected.length) {
          const item = detected[n - 1];
          if (item === undefined) return;
          dispatch({
            type: 'set-step',
            step: {
              kind: 'local-model',
              chosen: { providerId: item.id, baseUrl: item.baseUrl, displayName: item.displayName },
              models: await listModelsFor(item.baseUrl),
            },
          });
        } else if (n === detected.length + 1) {
          dispatch({
            type: 'set-step',
            step: {
              kind: 'api-key',
              chosen: {
                providerId: 'openrouter',
                baseUrl: PROVIDERS.openrouter.defaultBaseUrl ?? '',
                displayName: PROVIDERS.openrouter.displayName,
              },
            },
          });
        } else {
          dispatch({ type: 'set-error', messages: ['custom endpoint setup not yet supported via wizard; edit ~/.piper/credentials.json directly'] });
        }
        return;
      }
      case 'api-key': {
        if (!text.startsWith('sk-')) {
          dispatch({ type: 'set-error', messages: ['OpenRouter API keys start with sk-or-... — try again'] });
          return;
        }
        dispatch({
          type: 'set-step',
          step: { kind: 'tier', chosen: state.step.chosen, apiKey: text },
        });
        return;
      }
      case 'tier': {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1 || n > TIER_ORDER.length) {
          dispatch({ type: 'set-error', messages: [`pick a number 1..${TIER_ORDER.length}`] });
          return;
        }
        const tier = TIER_ORDER[n - 1];
        if (tier === undefined) return;
        dispatch({
          type: 'set-step',
          step: {
            kind: 'budget',
            chosen: state.step.chosen,
            apiKey: state.step.apiKey,
            tier,
            model: DEFAULT_MODEL_BY_TIER[tier],
          },
        });
        return;
      }
      case 'local-model': {
        if (state.step.models.length === 0) {
          dispatch({ type: 'set-error', messages: ['no models available from this backend; install one and re-run'] });
          return;
        }
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1 || n > state.step.models.length) {
          dispatch({ type: 'set-error', messages: [`pick a number 1..${state.step.models.length}`] });
          return;
        }
        const model = state.step.models[n - 1];
        if (model === undefined) return;
        dispatch({
          type: 'set-step',
          step: {
            kind: 'budget',
            chosen: state.step.chosen,
            model,
          },
        });
        return;
      }
      case 'budget': {
        let max: number | undefined;
        if (text === '' || text.toLowerCase() === 'default') {
          max = 0.5;
        } else if (text.toLowerCase() === 'none' || text.toLowerCase() === 'unlimited') {
          max = undefined;
        } else {
          const n = Number(text);
          if (!Number.isFinite(n) || n <= 0) {
            dispatch({ type: 'set-error', messages: ['enter a positive number, or "none" for unlimited'] });
            return;
          }
          max = n;
        }
        const baseCtx: AssembledConfig = {
          providerId: state.step.chosen.providerId,
          baseUrl: state.step.chosen.baseUrl,
          model: state.step.model,
          ...(state.step.apiKey === undefined ? {} : { apiKey: state.step.apiKey }),
          ...(state.step.tier === undefined ? {} : { tier: state.step.tier }),
          ...(max === undefined ? {} : { maxSessionCostUsd: max }),
        };
        dispatch({ type: 'set-step', step: { kind: 'env-prompt', ctx: baseCtx } });
        return;
      }
      case 'env-prompt': {
        const t = text.toLowerCase();
        if (t === '' || t === 'n' || t === 'no') {
          dispatch({ type: 'set-step', step: { kind: 'confirm', ctx: state.step.ctx } });
          return;
        }
        if (t === 'y' || t === 'yes') {
          dispatch({ type: 'set-step', step: { kind: 'env-name', ctx: state.step.ctx } });
          return;
        }
        dispatch({ type: 'set-error', messages: ['answer y or n'] });
        return;
      }
      case 'env-name': {
        if (!ENV_NAME_PATTERN.test(text)) {
          dispatch({ type: 'set-error', messages: ['invalid name — use letters, digits, _ or - (must start with a letter)'] });
          return;
        }
        dispatch({ type: 'set-step', step: { kind: 'env-target', ctx: state.step.ctx, envName: text } });
        return;
      }
      case 'env-target': {
        const m = TARGET_PATTERN.exec(text);
        if (m === null) {
          dispatch({ type: 'set-error', messages: ['expected user@host or user@host:port'] });
          return;
        }
        const sshUser = m[1] ?? '';
        const host = m[2] ?? '';
        const port = m[3] === undefined ? undefined : Number(m[3]);
        dispatch({
          type: 'set-step',
          step: {
            kind: 'env-key',
            ctx: state.step.ctx,
            envName: state.step.envName,
            sshUser,
            host,
            ...(port === undefined ? {} : { port }),
          },
        });
        return;
      }
      case 'env-key': {
        const identity = text === '' ? undefined : text;
        const envFull = {
          name: state.step.envName,
          sshUser: state.step.sshUser,
          host: state.step.host,
          ...(state.step.port === undefined ? {} : { port: state.step.port }),
          ...(identity === undefined ? {} : { identityFile: identity }),
        };
        const ctx: AssembledConfig = { ...state.step.ctx, environment: envFull };
        dispatch({ type: 'set-step', step: { kind: 'confirm', ctx } });
        return;
      }
      case 'confirm': {
        const t = text.toLowerCase();
        if (t === '' || t === 'y' || t === 'yes') {
          dispatch({ type: 'set-step', step: { kind: 'writing', ctx: state.step.ctx } });
          const ctx = state.step.ctx;
          try {
            const path = defaultCredentialsPath();
            await writeCredentials(path, {
              ...(ctx.apiKey === undefined ? {} : { openrouterApiKey: ctx.apiKey }),
              defaultProvider: ctx.providerId,
              defaultModel: ctx.model,
              ...(ctx.maxSessionCostUsd === undefined ? {} : { maxSessionCostUsd: ctx.maxSessionCostUsd }),
              ...(ctx.environment === undefined ? {} : { environments: [ctx.environment] }),
            });
            dispatch({ type: 'set-step', step: { kind: 'done', path } });
            setTimeout(() => {
              exit();
              onComplete(path);
            }, 600);
          } catch (err) {
            dispatch({
              type: 'set-step',
              step: { kind: 'error', message: err instanceof Error ? err.message : String(err) },
            });
          }
          return;
        }
        if (t === 'n' || t === 'no' || t === 'q') {
          exit();
          return;
        }
        dispatch({ type: 'set-error', messages: ['answer y or n'] });
        return;
      }
      default:
        return;
    }
  }, [state.step, state.input, exit, onComplete]);

  useInput((input, key) => {
    if (state.step.kind === 'detect' || state.step.kind === 'writing' || state.step.kind === 'done') {
      return;
    }
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    if (key.return) {
      void handleEnter();
      return;
    }
    if (key.backspace || key.delete) {
      dispatch({ type: 'backspace' });
      return;
    }
    if (input !== '' && !key.ctrl && !key.meta) {
      dispatch({ type: 'append-input', ch: input });
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold color="cyan">PIPER · first-run setup</Text>
      </Box>
      <Text dimColor>──────────────────────────────────────────────────────────────</Text>
      <Box marginTop={1} flexDirection="column">
        <StepView step={state.step} input={state.input} />
        {state.errors.map((err, i) => (
          <Text key={i} color="red">  ! {err}</Text>
        ))}
      </Box>
    </Box>
  );
}

function StepView({ step, input }: { step: Step; input: string }): JSX.Element {
  switch (step.kind) {
    case 'detect':
      return <Text color="yellow">scanning local LLM endpoints…</Text>;
    case 'backend': {
      const total = step.detected.length + 2;
      return (
        <Box flexDirection="column">
          <Text>Choose a backend:</Text>
          {step.detected.map((d, i) => (
            <Text key={d.id}>{`  [${i + 1}] ${d.displayName} (${d.modelCount} models on ${d.baseUrl})`}</Text>
          ))}
          <Text>{`  [${step.detected.length + 1}] OpenRouter (remote, needs API key)`}</Text>
          <Text>{`  [${step.detected.length + 2}] Custom OpenAI-compatible endpoint`}</Text>
          <Prompt input={input} hint={`pick 1..${total}`} />
        </Box>
      );
    }
    case 'api-key':
      return (
        <Box flexDirection="column">
          <Text>Paste your OpenRouter API key (starts with sk-or-):</Text>
          <Prompt input={maskSensitive(input)} hint="paste and press Enter" />
        </Box>
      );
    case 'tier':
      return (
        <Box flexDirection="column">
          <Text>Choose a cost tier (you can change later in ~/.piper/credentials.json):</Text>
          {TIER_ORDER.map((t, i) => (
            <Text key={t}>{`  [${i + 1}] ${TIER_LABEL[t]}`}</Text>
          ))}
          <Prompt input={input} hint="pick 1..4" />
        </Box>
      );
    case 'local-model': {
      const max = step.models.length;
      if (max === 0) {
        return (
          <Box flexDirection="column">
            <Text color="yellow">No models available from {step.chosen.displayName}. Pull one (e.g. `ollama pull qwen3-coder:30b`) and re-run.</Text>
            <Prompt input={input} hint="Ctrl+C to quit" />
          </Box>
        );
      }
      return (
        <Box flexDirection="column">
          <Text>Choose a default model on {step.chosen.displayName}:</Text>
          {step.models.slice(0, 20).map((m, i) => (
            <Text key={m}>{`  [${i + 1}] ${m}`}</Text>
          ))}
          {step.models.length > 20 && (
            <Text dimColor>  ... {step.models.length - 20} more — edit credentials.json to use them</Text>
          )}
          <Prompt input={input} hint={`pick 1..${Math.min(max, 20)}`} />
        </Box>
      );
    }
    case 'budget':
      return (
        <Box flexDirection="column">
          <Text>Max session cost in USD (hard cap on this run's LLM spend).</Text>
          <Text dimColor>Defaults to 0.50 if you press Enter. Type a number, or "none" for unlimited.</Text>
          <Prompt input={input} hint="Enter / number / none" />
        </Box>
      );
    case 'env-prompt':
      return (
        <Box flexDirection="column">
          <Text>Add an SSH environment now? You can add more later with /env add inside PIPER.</Text>
          <Prompt input={input} hint="y / n (Enter = no)" />
        </Box>
      );
    case 'env-name':
      return (
        <Box flexDirection="column">
          <Text>Environment name (short identifier, e.g. "staging" or "prod-web"):</Text>
          <Prompt input={input} hint="letters/digits/_/-, must start with letter" />
        </Box>
      );
    case 'env-target':
      return (
        <Box flexDirection="column">
          <Text>SSH target as user@host or user@host:port (e.g. deploy@10.0.0.5:2222):</Text>
          <Prompt input={input} hint="user@host[:port]" />
        </Box>
      );
    case 'env-key':
      return (
        <Box flexDirection="column">
          <Text>Path to SSH identity file (private key), or Enter for system default (~/.ssh/id_* + ssh-agent):</Text>
          <Prompt input={input} hint="/path/to/key  or  Enter" />
        </Box>
      );
    case 'confirm':
      return (
        <Box flexDirection="column">
          <Text bold>Summary:</Text>
          <Text>{`  backend:  ${step.ctx.providerId} (${step.ctx.baseUrl})`}</Text>
          <Text>{`  model:    ${step.ctx.model}`}</Text>
          {step.ctx.tier !== undefined && <Text>{`  tier:     ${step.ctx.tier}`}</Text>}
          {step.ctx.apiKey !== undefined && <Text>{`  api key:  ${step.ctx.apiKey.slice(0, 12)}…(${step.ctx.apiKey.length} chars)`}</Text>}
          {step.ctx.maxSessionCostUsd !== undefined && <Text>{`  budget:   $${step.ctx.maxSessionCostUsd.toFixed(2)} per session`}</Text>}
          {step.ctx.maxSessionCostUsd === undefined && <Text>{`  budget:   unlimited`}</Text>}
          {step.ctx.environment !== undefined && (
            <Text>
              {`  env:      ${step.ctx.environment.name} → ${step.ctx.environment.sshUser}@${step.ctx.environment.host}`}
              {step.ctx.environment.port === undefined ? '' : `:${step.ctx.environment.port}`}
              {step.ctx.environment.identityFile === undefined ? '' : `  -i ${step.ctx.environment.identityFile}`}
            </Text>
          )}
          <Box marginTop={1}>
            <Text>Write to ~/.piper/credentials.json?</Text>
          </Box>
          <Prompt input={input} hint="y / n (Enter = yes)" />
        </Box>
      );
    case 'writing':
      return <Text color="yellow">writing credentials file…</Text>;
    case 'done':
      return (
        <Box flexDirection="column">
          <Text color="green">✓ Saved to {step.path} (mode 600)</Text>
          <Text dimColor>launching PIPER…</Text>
        </Box>
      );
    case 'error':
      return <Text color="red">! wizard failed: {step.message}</Text>;
    default:
      return <Text> </Text>;
  }
}

function Prompt({ input, hint }: { input: string; hint: string }): JSX.Element {
  return (
    <Box marginTop={1}>
      <Text color="cyan">{'› '}</Text>
      <Text>{input}</Text>
      <Text inverse> </Text>
      <Text dimColor>  {hint}</Text>
    </Box>
  );
}

function maskSensitive(input: string): string {
  if (input.length <= 12) return input;
  return `${input.slice(0, 12)}${'•'.repeat(input.length - 12)}`;
}
