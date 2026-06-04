import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdin } from 'ink';

import type { PGlite } from '@electric-sql/pglite';

import type { Catalog } from '../actions/catalog.ts';
import { archiveReport } from '../agent/report-archiver.ts';
import { createAgentRunner, type AgentRunner } from '../agent/runner.ts';
import { buildSessionReport } from '../agent/session-report.ts';
import { generateSessionTitle } from '../agent/title.ts';
import { trackedComplete } from '../agent/tracked-complete.ts';
import {
  countMessagesTokens,
  formatTokenCount,
  formatTokenLimit,
} from '../agent/token-counter.ts';
import type { AgentEvent, ProposalDecision, ProposedStep } from '../agent/types.ts';
import type { EnvironmentRegistry } from '../environments/registry.ts';
import {
  InvalidEnvironmentError,
} from '../environments/types.ts';
import type { Executor } from '../exec/executor.ts';
import type {
  ElevationApprovalCallback,
  ElevationProposal,
  MutationApprovalCallback,
  MutationDecision,
  MutationProposal,
} from '../exec/types.ts';
import type { Logger } from '../logging/logger.ts';
import type { ChatHistory } from '../memory/chat-history.ts';
import type { SessionsRepo } from '../memory/sessions.ts';
import type { SessionId } from '../memory/types.ts';
import type { CostTracker } from '../models/cost.ts';
import type { ModelClient, RemoteCredit } from '../models/types.ts';
import type { EmbeddingClient } from '../rag/embedding-client.ts';
import { createAnomalyPolicy, DEFAULT_POLICY_CONFIG } from '../monitor/anomaly-policy.ts';
import { runCheck } from '../monitor/check-runner.ts';
import { createWatchDiagnoser } from '../monitor/diagnose.ts';
import {
  compileWatchPlan,
  type CompilerMessage,
} from '../monitor/plan-compiler.ts';
import {
  defaultWatchesDir,
  loadPlansFromDir,
  parseWatchPlan,
  serializeWatchPlan,
  validateAgainstCatalog,
} from '../monitor/plan-loader.ts';
import { runWatch } from '../monitor/scheduler.ts';
import { instantiateStockPlan, STOCK_PLANS } from '../monitor/stock.ts';
import type { CheckOutcome, WatchEvent, WatchPlan } from '../monitor/types.ts';
import { InvalidWatchPlanError } from '../monitor/types.ts';
import { createWatchStore } from '../monitor/watch-store.ts';
import { createNotifier } from '../notify/notifier.ts';
import { loadSkillsFromDir, defaultSkillsDir, parseSkill } from '../skills/loader.ts';
import { STOCK_SKILLS } from '../skills/stock.ts';

import { AgentEventLine } from './AgentEventLine.tsx';
import { AlienFace } from './AlienFace.tsx';
import { ReportBlock } from './ReportBlock.tsx';
import { Banner } from './Banner.tsx';
import { Help } from './Help.tsx';
import { parseSlashCommand, slashCompletions, type SlashCommand } from './commands.ts';
import { MemoryViewer } from './MemoryViewer.tsx';
import { ModelPicker, type ModelSelection } from './ModelPicker.tsx';
import { WatchPanel, type WatchAnomalyView } from './WatchPanel.tsx';
import { ElevationApprovalPanel } from './ElevationApprovalPanel.tsx';
import { MutationApprovalPanel } from './MutationApprovalPanel.tsx';
import { Proposals } from './Proposals.tsx';
import { Report } from './Report.tsx';
import { SessionPicker } from './SessionPicker.tsx';
import { SlashAutocomplete } from './SlashAutocomplete.tsx';
import type { ChatEntry } from './types.ts';

export interface AppDeps {
  readonly catalog: Catalog;
  readonly registry: EnvironmentRegistry;
  readonly executor: Executor;
  readonly client: ModelClient;
  readonly costTracker: CostTracker;
  readonly chatHistory?: ChatHistory;
  readonly sessionsRepo?: SessionsRepo;
  readonly db?: PGlite;
  readonly embedder?: EmbeddingClient;
  readonly logger?: Logger;
  readonly sessionId: SessionId;
  readonly maxSessionCostUsd?: number;
  readonly compactionKeepRecent?: number;
  readonly compactionTriggerPct?: number;
  readonly maxFollowupIterations?: number;
  readonly initialTitle?: string | null;
  /**
   * Optional: invoked when the user picks a different model via /model.
   * The caller is expected to swap the underlying ModelClient (and probably
   * persist the choice in credentials).
   */
  readonly onSwitchModel?: (sel: ModelSelection) => Promise<ModelClient | null>;
  readonly openrouterApiKey?: string;
  /**
   * Called once on mount with a callback the OUTER world (the executor) can
   * use to ask the user to approve a proposed mutation. Wiring lives in
   * src/index.tsx — the executor's `onMutationProposal` dep proxies into
   * this callback so the prompt renders in the TUI.
   */
  readonly registerMutationApprover?: (cb: MutationApprovalCallback) => void;
  /**
   * Like {@link registerMutationApprover} but for privilege elevation (sudo).
   * The executor calls this for any action (read/mutate/destructive) that wants
   * sudo. The callback renders the elevation panel and resolves on a/r/n.
   */
  readonly registerElevationApprover?: (cb: ElevationApprovalCallback) => void;
  /**
   * Registered with a yes/no callback the executor invokes when `sudo -n`
   * needs a password. `true` runs the INTERACTIVE ssh -tt passthrough (the
   * user types the password on their terminal; PIPER never sees it).
   */
  readonly registerSudoPasswordApprover?: (
    cb: (info: {
      readonly actionName: string;
      readonly commandScrubbed: string;
    }) => Promise<boolean>,
  ) => void;
  /** Webhook URLs sourced from ~/.piper/credentials.json watch_webhooks. */
  readonly watchWebhookUrls?: readonly string[];
}

interface PendingApproval {
  readonly proposals: readonly ProposedStep[];
  readonly iteration: number;
  readonly resolve: (decision: ProposalDecision) => void;
}

interface PendingMutation {
  readonly proposal: MutationProposal;
  readonly resolve: (decision: MutationDecision) => void;
}

interface PendingElevation {
  readonly proposal: ElevationProposal;
  readonly resolve: (decision: MutationDecision) => void;
}

interface PendingSudoPassword {
  readonly actionName: string;
  readonly commandScrubbed: string;
  readonly resolve: (allow: boolean) => void;
}

type ExecutionMode = 'human' | 'yolo';

const WATCH_HISTORY_CAP = 20;
const WATCH_ANOMALIES_CAP = 50;

interface WatchUiState {
  readonly plan: WatchPlan;
  readonly lastOutcomes: ReadonlyMap<string, CheckOutcome>;
  readonly history: ReadonlyMap<string, readonly boolean[]>;
  readonly anomalies: readonly WatchAnomalyView[];
  readonly diagnoses: ReadonlyMap<string, string>;
  readonly diagnosing: ReadonlySet<string>;
}

interface State {
  entries: ChatEntry[];
  input: string;
  busy: boolean;
  showHelp: boolean;
  costUsd: number;
  tokensUsed: number;
  autocompleteIndex: number;
  autocompleteDismissed: boolean;
  executionMode: ExecutionMode;
  sessionTitle: string | null;
  remoteCredit: RemoteCredit | null;
  showModelPicker: boolean;
  showSessionPicker: boolean;
  showMemoryViewer: boolean;
  showReasoning: boolean;
  debugMode: boolean;
  /** Coarse-grained agent phase so the "working" indicator can carry a hint
   *  about WHAT the agent is doing right now. The streaming block takes over
   *  during 'synthesizing'. */
  agentPhase: 'idle' | 'planning' | 'gathering' | 'synthesizing';
  /** Pending line currently being typed by the streamer (not yet ended in '\n'). */
  streamingPartial: string;
  /** Completed lines of the current streamed synth (live preview only — NOT
   *  yet committed to scrollback; promoted to a single `report` entry on
   *  verify-passed, or discarded entirely on verify-failed retrying). */
  streamingLines: readonly string[];
  /** True while a stream is active. */
  streamingActive: boolean;
  pendingApproval?: PendingApproval;
  pendingMutation?: PendingMutation;
  pendingElevation?: PendingElevation;
  /** True once the user pressed approve on a double-confirm elevation; a second
   *  `a` then resolves it. Reset to false on each new elevation proposal. */
  elevationConfirmArmed: boolean;
  pendingSudoPassword?: PendingSudoPassword;
  /** Active watch run UI state. null = not watching. */
  watch: WatchUiState | null;
}

type Action =
  | { type: 'set-input'; value: string }
  | { type: 'append-input'; ch: string }
  | { type: 'backspace' }
  | { type: 'clear-input' }
  | { type: 'append-entry'; entry: ChatEntry }
  | { type: 'set-busy'; busy: boolean }
  | { type: 'set-help'; show: boolean }
  | { type: 'stream-begin' }
  | { type: 'stream-line-complete'; line: string }
  | { type: 'stream-set-partial'; partial: string }
  | { type: 'stream-discard' }
  | { type: 'stream-commit'; verified: boolean }
  | { type: 'inc-cost'; usd: number }
  | { type: 'set-tokens'; tokens: number }
  | { type: 'set-autocomplete-index'; index: number }
  | { type: 'dismiss-autocomplete' }
  | { type: 'toggle-mode' }
  | { type: 'set-title'; title: string }
  | { type: 'set-remote-credit'; credit: RemoteCredit | null }
  | { type: 'show-model-picker'; show: boolean }
  | { type: 'show-session-picker'; show: boolean }
  | { type: 'show-memory-viewer'; show: boolean }
  | { type: 'toggle-reasoning' }
  | { type: 'toggle-debug' }
  | { type: 'set-phase'; phase: State['agentPhase'] }
  | { type: 'replace-entries'; entries: ChatEntry[] }
  | { type: 'commit-final-report'; entry: ChatEntry }
  | { type: 'pending-approval'; approval: PendingApproval }
  | { type: 'clear-approval' }
  | { type: 'pending-mutation'; mutation: PendingMutation }
  | { type: 'clear-mutation' }
  | { type: 'pending-elevation'; elevation: PendingElevation }
  | { type: 'arm-elevation-confirm' }
  | { type: 'clear-elevation' }
  | { type: 'pending-sudo-password'; request: PendingSudoPassword }
  | { type: 'clear-sudo-password' }
  | { type: 'watch-start'; plan: WatchPlan }
  | { type: 'watch-event'; event: WatchEvent }
  | { type: 'watch-stop' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'set-input':
      return { ...state, input: action.value, autocompleteIndex: 0, autocompleteDismissed: false };
    case 'append-input':
      return {
        ...state,
        input: state.input + action.ch,
        autocompleteIndex: 0,
        autocompleteDismissed: false,
      };
    case 'backspace':
      return {
        ...state,
        input: state.input.slice(0, -1),
        autocompleteIndex: 0,
        autocompleteDismissed: false,
      };
    case 'clear-input':
      return { ...state, input: '', autocompleteIndex: 0, autocompleteDismissed: false };
    case 'append-entry':
      return { ...state, entries: [...state.entries, action.entry] };
    case 'set-busy':
      // Drive `agentPhase` from `busy` to keep the PhaseIndicator and the
      // dynamic area in sync atomically. Without this, the PhaseIndicator
      // would appear ~1s after the user presses Enter (when the first
      // `plan-started` event arrives) — that mid-wait insertion grows the
      // dynamic block by one row and Ink redraws everything below the last
      // <Static> commit, which asciinema captures as a visible flicker.
      // Setting phase='planning' the instant we become busy means the layout
      // is stable from the first frame of the turn until idle.
      return {
        ...state,
        busy: action.busy,
        agentPhase: action.busy ? 'planning' : 'idle',
      };
    case 'set-help':
      return { ...state, showHelp: action.show };
    case 'stream-begin':
      return { ...state, streamingActive: true, streamingPartial: '', streamingLines: [] };
    case 'stream-line-complete':
      // The line is part of the active stream — keep it in the DYNAMIC
      // buffer, NOT in scrollback yet. Only commit on verify-passed (or final
      // verify-failed); otherwise discard on retry.
      return {
        ...state,
        streamingLines: [...state.streamingLines, action.line],
        streamingPartial: '',
      };
    case 'stream-set-partial':
      return { ...state, streamingPartial: action.partial };
    case 'stream-discard':
      return { ...state, streamingActive: false, streamingPartial: '', streamingLines: [] };
    case 'stream-commit': {
      const markdown = state.streamingLines.join('\n');
      const entry: ChatEntry = {
        kind: 'report',
        id: `e-rep-${state.entries.length}-${Math.random()}`,
        markdown,
        verified: action.verified,
      };
      return {
        ...state,
        entries: [...state.entries, entry],
        streamingActive: false,
        streamingPartial: '',
        streamingLines: [],
      };
    }
    case 'inc-cost':
      return { ...state, costUsd: state.costUsd + action.usd };
    case 'set-tokens':
      return { ...state, tokensUsed: action.tokens };
    case 'set-autocomplete-index':
      return { ...state, autocompleteIndex: action.index };
    case 'dismiss-autocomplete':
      return { ...state, autocompleteDismissed: true };
    case 'toggle-mode':
      return { ...state, executionMode: state.executionMode === 'human' ? 'yolo' : 'human' };
    case 'set-title':
      return { ...state, sessionTitle: action.title };
    case 'set-remote-credit':
      return { ...state, remoteCredit: action.credit };
    case 'show-model-picker':
      return { ...state, showModelPicker: action.show };
    case 'show-session-picker':
      return { ...state, showSessionPicker: action.show };
    case 'show-memory-viewer':
      return { ...state, showMemoryViewer: action.show };
    case 'toggle-reasoning':
      return { ...state, showReasoning: !state.showReasoning };
    case 'toggle-debug':
      return { ...state, debugMode: !state.debugMode };
    case 'set-phase':
      return { ...state, agentPhase: action.phase };
    case 'replace-entries':
      return { ...state, entries: action.entries };
    case 'commit-final-report':
      return { ...state, entries: [...state.entries, action.entry], streamingPartial: '', streamingActive: false };
    case 'pending-approval':
      return { ...state, pendingApproval: action.approval, input: '' };
    case 'clear-approval': {
      // Also wipe the input buffer — the `y`/`n`/`1,3` the user typed to
      // resolve the approval lives in `state.input` (entered via append-input
      // during the approval modal). If we don't clear it, the next normal
      // typing session starts with that stale character in the prompt box.
      const next = { ...state, input: '' };
      delete next.pendingApproval;
      return next;
    }
    case 'pending-mutation':
      return { ...state, pendingMutation: action.mutation, input: '' };
    case 'clear-mutation': {
      const next = { ...state, input: '' };
      delete next.pendingMutation;
      return next;
    }
    case 'pending-elevation':
      return { ...state, pendingElevation: action.elevation, elevationConfirmArmed: false, input: '' };
    case 'arm-elevation-confirm':
      return { ...state, elevationConfirmArmed: true };
    case 'clear-elevation': {
      const next = { ...state, input: '', elevationConfirmArmed: false };
      delete next.pendingElevation;
      return next;
    }
    case 'pending-sudo-password':
      return { ...state, pendingSudoPassword: action.request, input: '' };
    case 'clear-sudo-password': {
      const next = { ...state, input: '' };
      delete next.pendingSudoPassword;
      return next;
    }
    case 'watch-start':
      return {
        ...state,
        watch: {
          plan: action.plan,
          lastOutcomes: new Map(),
          history: new Map(),
          anomalies: [],
          diagnoses: new Map(),
          diagnosing: new Set(),
        },
      };
    case 'watch-event':
      return state.watch === null
        ? state
        : { ...state, watch: foldWatchEvent(state.watch, action.event) };
    case 'watch-stop':
      return { ...state, watch: null };
    default:
      return state;
  }
}

/**
 * Fold a single WatchEvent into the watch UI state. Pure: returns a new
 * WatchUiState with the relevant map/array replaced. Keeps the reducer case
 * mechanical and under the per-function line budget.
 */
function foldWatchEvent(watch: WatchUiState, event: WatchEvent): WatchUiState {
  if (event.type === 'check-result') {
    const { outcome } = event;
    const lastOutcomes = new Map(watch.lastOutcomes).set(outcome.checkName, outcome);
    const prior = watch.history.get(outcome.checkName) ?? [];
    const next = [...prior, outcome.kind === 'pass'].slice(-WATCH_HISTORY_CAP);
    const history = new Map(watch.history).set(outcome.checkName, next);
    return { ...watch, lastOutcomes, history };
  }
  if (event.type === 'anomaly') {
    const view: WatchAnomalyView = {
      checkName: event.checkName,
      consecutiveFailures: event.consecutiveFailures,
      atMs: event.atMs,
    };
    return { ...watch, anomalies: [view, ...watch.anomalies].slice(0, WATCH_ANOMALIES_CAP) };
  }
  if (event.type === 'diagnosis-started') {
    return { ...watch, diagnosing: new Set(watch.diagnosing).add(event.checkName) };
  }
  if (event.type === 'diagnosis-ready') {
    const diagnoses = new Map(watch.diagnoses).set(event.checkName, event.reportMarkdown);
    const diagnosing = new Set(watch.diagnosing);
    diagnosing.delete(event.checkName);
    return { ...watch, diagnoses, diagnosing };
  }
  if (event.type === 'diagnosis-skipped') {
    const diagnosing = new Set(watch.diagnosing);
    diagnosing.delete(event.checkName);
    return { ...watch, diagnosing };
  }
  return watch;
}

let idCounter = 0;
const nextId = (): string => {
  idCounter += 1;
  return `e${idCounter}`;
};

const INITIAL_STATE: State = {
  entries: [],
  input: '',
  busy: false,
  showHelp: false,
  costUsd: 0,
  tokensUsed: 0,
  autocompleteIndex: 0,
  autocompleteDismissed: false,
  executionMode: 'human',
  sessionTitle: null,
  remoteCredit: null,
  showModelPicker: false,
  showSessionPicker: false,
  showMemoryViewer: false,
  showReasoning: true,
  debugMode: false,
  agentPhase: 'idle',
  streamingPartial: '',
  streamingLines: [],
  streamingActive: false,
  elevationConfirmArmed: false,
  watch: null,
};

export function App(deps: AppDeps): JSX.Element {
  const { exit } = useApp();
  const { setRawMode, isRawModeSupported } = useStdin();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [currentClient, setCurrentClient] = useState<ModelClient>(deps.client);
  const [currentSessionId, setCurrentSessionId] = useState<SessionId>(deps.sessionId);
  const runnerRef = useRef<AgentRunner | null>(null);
  const watchAbortRef = useRef<AbortController | null>(null);
  // Set to true when the user approves a sudo-password TTY passthrough so that
  // raw mode can be restored once the agent turn finishes (see useEffect below).
  const sudoPassthroughUsedRef = useRef<boolean>(false);

  const approveProposals = useCallback(
    (proposals: readonly ProposedStep[], iteration: number): Promise<ProposalDecision> => {
      // YOLO auto-approves read-only follow-ups; mutate-tier always asks.
      const hasNonRead = proposals.some((p) => {
        const action = deps.catalog.resolve(p.actionName);
        return action !== undefined && action.tier !== 'read';
      });
      if (modeRef.current === 'yolo' && !hasNonRead) {
        return Promise.resolve({
          acceptedIndices: proposals.map((_, i) => i),
          stop: false,
        });
      }
      return new Promise<ProposalDecision>((resolve) => {
        dispatch({
          type: 'pending-approval',
          approval: { proposals, iteration, resolve },
        });
      });
    },
    [deps.catalog],
  );

  const modeRef = useRef<ExecutionMode>(state.executionMode);
  useEffect(() => {
    modeRef.current = state.executionMode;
  }, [state.executionMode]);

  const showReasoningRef = useRef<boolean>(state.showReasoning);
  useEffect(() => {
    showReasoningRef.current = state.showReasoning;
  }, [state.showReasoning]);

  const approveSteps = useCallback(
    (proposals: readonly ProposedStep[]): Promise<ProposalDecision> => {
      // CLAUDE.md guarantee: any mutate/destructive step ALWAYS asks, even in YOLO.
      const hasNonRead = proposals.some((p) => {
        const action = deps.catalog.resolve(p.actionName);
        return action !== undefined && action.tier !== 'read';
      });
      if (modeRef.current === 'yolo' && !hasNonRead) {
        // Auto-approve all read-tier steps
        return Promise.resolve({
          acceptedIndices: proposals.map((_, i) => i),
          stop: false,
        });
      }
      return new Promise<ProposalDecision>((resolve) => {
        dispatch({
          type: 'pending-approval',
          approval: { proposals, iteration: 0, resolve },
        });
      });
    },
    [deps.catalog],
  );

  const pendingReportRef = useRef<string | null>(null);
  // Accumulators for the line-by-line streaming pipeline:
  //   streamFullRef       = full markdown of the report being streamed (for archive/verify)
  //   streamPartialRef    = portion of the next line not yet ended with '\n'
  const streamFullRef = useRef<string>('');
  const streamPartialRef = useRef<string>('');
  const titleGenerationFiredRef = useRef<boolean>(deps.initialTitle !== undefined && deps.initialTitle !== null);

  useEffect(() => {
    if (deps.initialTitle !== undefined && deps.initialTitle !== null) {
      dispatch({ type: 'set-title', title: deps.initialTitle });
    }
    // initial-title only fires once at mount, by design
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-load existing chat history at mount (resume case).
  useEffect(() => {
    if (deps.chatHistory === undefined) return;
    void (async () => {
      try {
        const recent = await deps.chatHistory!.recent(currentSessionId, 100);
        if (recent.length === 0) return;
        const loaded: ChatEntry[] = [];
        for (const msg of recent) {
          if (msg.kind === 'prompt') {
            loaded.push({ kind: 'user', id: nextId(), text: msg.content });
          } else if (msg.kind === 'report' || msg.kind === 'session-report') {
            loaded.push({ kind: 'report', id: nextId(), markdown: msg.content, verified: true });
          } else if (msg.kind === 'summary') {
            loaded.push({
              kind: 'info',
              id: nextId(),
              text: '(history compacted — earlier turns summarised)',
            });
          }
        }
        if (loaded.length > 0) {
          dispatch({ type: 'replace-entries', entries: loaded });
          void recountTokens(currentSessionId, deps.chatHistory, dispatch);
        }
      } catch {
        // best-effort
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remote-credit fetch: at mount, after every synth/done, and on a 60s timer
  // (covers the case where the OR balance moves due to external usage).
  useEffect(() => {
    if (currentClient.getRemoteCredit === undefined) return;
    const fire = (): void => {
      void currentClient
        .getRemoteCredit!()
        .then((c) => dispatch({ type: 'set-remote-credit', credit: c }))
        .catch(() => {
          // silent — best-effort
        });
    };
    fire();
    const interval = setInterval(fire, 60_000);
    return () => clearInterval(interval);
  }, [currentClient]);

  const refreshRemoteCredit = useCallback(() => {
    if (currentClient.getRemoteCredit === undefined) return;
    void currentClient
      .getRemoteCredit()
      .then((c) => dispatch({ type: 'set-remote-credit', credit: c }))
      .catch(() => {
        // silent
      });
  }, [currentClient]);

  // Reset runner when the client changes (e.g. /model switch)
  useEffect(() => {
    runnerRef.current = null;
  }, [currentClient]);

  // Reset runner when the session changes too (state is fully scoped per session)
  useEffect(() => {
    runnerRef.current = null;
  }, [currentSessionId]);

  // Mount-time wiring: hand the outer world (src/index.tsx, which built the
  // Executor) a callback it can invoke whenever a mutation needs human
  // approval. Our implementation dispatches a `pending-mutation` state and
  // returns a Promise that resolves when the user presses a/r/n in the TUI.
  // Registered once — the bridge ref in index.tsx stays alive for the
  // lifetime of the App.
  useEffect(() => {
    if (deps.registerMutationApprover === undefined) return;
    deps.registerMutationApprover((proposal) => {
      return new Promise<MutationDecision>((resolve) => {
        dispatch({ type: 'pending-mutation', mutation: { proposal, resolve } });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Elevation (sudo) approval bridge — mirrors the mutation approver above.
  useEffect(() => {
    if (deps.registerElevationApprover === undefined) return;
    deps.registerElevationApprover((proposal) => {
      return new Promise<MutationDecision>((resolve) => {
        dispatch({ type: 'pending-elevation', elevation: { proposal, resolve } });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sudo-password yes/no bridge. On `true` the executor will spawn an
  // interactive `ssh -tt` child that owns the TTY; we drop Ink's raw mode first
  // so the child's stdin reaches the terminal cleanly. Known limitation: Ink
  // and the child share the TTY for the duration of the interactive prompt.
  useEffect(() => {
    if (deps.registerSudoPasswordApprover === undefined) return;
    deps.registerSudoPasswordApprover((info) => {
      return new Promise<boolean>((resolve) => {
        dispatch({
          type: 'pending-sudo-password',
          request: {
            actionName: info.actionName,
            commandScrubbed: info.commandScrubbed,
            resolve: (allow) => {
              if (allow && isRawModeSupported) {
                setRawMode(false);
                // Mark that a TTY passthrough was used so raw mode can be
                // restored once the agent turn finishes (see useEffect below).
                sudoPassthroughUsedRef.current = true;
              }
              resolve(allow);
            },
          },
        });
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore Ink raw mode after a sudo-password TTY passthrough. The interactive
  // ssh -tt child runs inside the executor (not directly observable here), but
  // `state.busy` goes false when the whole agent turn finishes. At that point,
  // if a passthrough was approved during this turn, re-enable raw mode so the
  // TUI input works normally for subsequent turns.
  useEffect(() => {
    if (!state.busy && sudoPassthroughUsedRef.current) {
      sudoPassthroughUsedRef.current = false;
      if (isRawModeSupported) setRawMode(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.busy]);

  const handleResume = useCallback(
    async (newSessionId: SessionId): Promise<void> => {
      if (deps.sessionsRepo === undefined || deps.chatHistory === undefined) return;
      try {
        const recent = await deps.chatHistory.recent(newSessionId, 100);
        const entries: ChatEntry[] = [];
        for (const msg of recent) {
          if (msg.kind === 'prompt') {
            entries.push({ kind: 'user', id: nextId(), text: msg.content });
          } else if (msg.kind === 'report' || msg.kind === 'session-report') {
            entries.push({ kind: 'report', id: nextId(), markdown: msg.content, verified: true });
          } else if (msg.kind === 'summary') {
            entries.push({
              kind: 'info',
              id: nextId(),
              text: `(history compacted — earlier turns summarised)`,
            });
          }
        }
        dispatch({ type: 'replace-entries', entries });
        const title = await deps.sessionsRepo.getTitle(newSessionId);
        if (title !== null) dispatch({ type: 'set-title', title });
        setCurrentSessionId(newSessionId);
        // Refresh the token meter to reflect the resumed session's history.
        void recountTokens(newSessionId, deps.chatHistory, dispatch);
      } catch (err) {
        appendError(`resume failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deps.sessionsRepo, deps.chatHistory],
  );

  if (runnerRef.current === null) {
    runnerRef.current = createAgentRunner({
      catalog: deps.catalog,
      registry: deps.registry,
      executor: deps.executor,
      client: currentClient,
      costTracker: deps.costTracker,
      approveProposals,
      approveSteps,
      ...(deps.chatHistory === undefined ? {} : { chatHistory: deps.chatHistory }),
      ...(deps.db === undefined ? {} : { db: deps.db }),
      ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      ...(deps.compactionKeepRecent === undefined
        ? {}
        : { compactionKeepRecent: deps.compactionKeepRecent }),
      ...(deps.compactionTriggerPct === undefined
        ? {}
        : { compactionTriggerPct: deps.compactionTriggerPct }),
      ...(deps.maxFollowupIterations === undefined
        ? {}
        : { maxFollowupIterations: deps.maxFollowupIterations }),
    });
  }

  const appendInfo = useCallback((text: string) => {
    dispatch({ type: 'append-entry', entry: { kind: 'info', id: nextId(), text } });
  }, []);
  const appendError = useCallback((text: string) => {
    dispatch({ type: 'append-entry', entry: { kind: 'error', id: nextId(), text } });
  }, []);

  const handleSlashCommand = useCallback(
    async (cmd: SlashCommand): Promise<void> => {
      if (cmd.kind === 'help') {
        dispatch({ type: 'set-help', show: true });
        return;
      }
      if (cmd.kind === 'quit') {
        exit();
        return;
      }
      if (cmd.kind === 'save') {
        const lastReport = [...state.entries].reverse().find((e) => e.kind === 'report');
        if (lastReport === undefined || lastReport.kind !== 'report') {
          appendError('no report to save yet');
          return;
        }
        const filename = cmd.filename ?? `piper-report-${Date.now()}.md`;
        await Bun.write(filename, lastReport.markdown);
        appendInfo(`saved to ${filename}`);
        return;
      }
      if (cmd.kind === 'session-report') {
        if (deps.chatHistory === undefined) {
          appendError('chat history not available — cannot build a session report');
          return;
        }
        appendInfo('building comprehensive session report…');
        dispatch({ type: 'set-busy', busy: true });
        try {
          const out = await buildSessionReport(
            { sessionId: currentSessionId },
            {
              chatHistory: deps.chatHistory,
              client: currentClient,
              costTracker: deps.costTracker,
              ...(deps.db === undefined ? {} : { db: deps.db }),
              ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
            },
          );
          if (out.reportMarkdown === '') {
            appendError('session report came back empty (no conversation history yet?)');
            return;
          }
          dispatch({
            type: 'append-entry',
            entry: { kind: 'report', id: nextId(), markdown: out.reportMarkdown, verified: true },
          });
          if (out.costUsd > 0) dispatch({ type: 'inc-cost', usd: out.costUsd });
          appendInfo(
            `session report ready${out.ragStored ? ` · indexed for RAG (${out.ragChunkCount} chunks)` : ''}`,
          );
          if (cmd.filename !== undefined) {
            await Bun.write(cmd.filename, out.reportMarkdown);
            appendInfo(`saved to ${cmd.filename}`);
          }
        } catch (err) {
          appendError(`session report failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          dispatch({ type: 'set-busy', busy: false });
        }
        return;
      }
      if (cmd.kind === 'annex') {
        if (deps.chatHistory === undefined) {
          appendError('chat history not available — cannot annex this session');
          return;
        }
        if (deps.db === undefined || deps.embedder === undefined) {
          appendError('knowledge base not available — annex needs the RAG store (db + embedder)');
          return;
        }
        appendInfo('annexing this session as a solved-case…');
        dispatch({ type: 'set-busy', busy: true });
        try {
          const out = await buildSessionReport(
            {
              sessionId: currentSessionId,
              ...(cmd.title === undefined ? {} : { title: cmd.title }),
              ragKind: 'solved-case',
              ragSourcePrefix: 'solved-case',
            },
            {
              chatHistory: deps.chatHistory,
              client: currentClient,
              costTracker: deps.costTracker,
              db: deps.db,
              embedder: deps.embedder,
            },
          );
          if (out.reportMarkdown === '') {
            appendError('nothing to annex yet (no conversation history)');
            return;
          }
          dispatch({
            type: 'append-entry',
            entry: { kind: 'report', id: nextId(), markdown: out.reportMarkdown, verified: true },
          });
          if (out.costUsd > 0) dispatch({ type: 'inc-cost', usd: out.costUsd });
          appendInfo(
            `annexed as solved-case${out.ragStored ? ` · indexed (${out.ragChunkCount} chunks)` : ' · RAG store failed'}`,
          );
        } catch (err) {
          appendError(`annex failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          dispatch({ type: 'set-busy', busy: false });
        }
        return;
      }
      if (cmd.kind === 'skill') {
        const loaded = await loadSkillsFromDir(defaultSkillsDir(), deps.catalog);
        for (const f of loaded.failures) {
          appendError(`skipped skill ${f.path}: ${f.message}`);
        }
        appendInfo('stock skills:');
        for (const s of STOCK_SKILLS) {
          const parsed = parseSkill(s.text, 'stock');
          appendInfo(`  ${parsed.name} — ${parsed.description}`);
        }
        if (loaded.skills.length > 0) {
          appendInfo('your skills:');
          for (const e of loaded.skills) {
            appendInfo(`  ${e.skill.name} — ${e.skill.description}`);
          }
        }
        appendInfo('Skills specialize an analyze run; matching is automatic (coming next).');
        return;
      }
      if (cmd.kind === 'model') {
        if (deps.onSwitchModel === undefined) {
          appendError('/model is not available — startup did not wire a model switcher');
          return;
        }
        dispatch({ type: 'show-model-picker', show: true });
        return;
      }
      if (cmd.kind === 'resume') {
        if (deps.sessionsRepo === undefined || deps.chatHistory === undefined) {
          appendError('/resume is not available — sessions repo not wired');
          return;
        }
        dispatch({ type: 'show-session-picker', show: true });
        return;
      }
      if (cmd.kind === 'memory') {
        if (deps.db === undefined) {
          appendError('/memory is not available — no database');
          return;
        }
        dispatch({ type: 'show-memory-viewer', show: true });
        return;
      }
      if (cmd.kind === 'debug') {
        dispatch({ type: 'toggle-debug' });
        appendInfo(
          state.debugMode
            ? 'debug mode OFF — agent noise hidden, the alien talks'
            : 'debug mode ON — costs, synth status, verify result visible',
        );
        return;
      }
      if (cmd.kind === 'env-list') {
        const envs = await deps.registry.list();
        if (envs.length === 0) {
          appendInfo('no environments registered. /env add <name> <user@host[:port]> [--key ...]');
          return;
        }
        for (const e of envs) {
          const port = e.port === undefined ? '' : `:${e.port}`;
          const key = e.identityFile === undefined ? '' : ` -i ${e.identityFile}`;
          const tags = e.tags.length === 0 ? '' : ` [${e.tags.join(',')}]`;
          appendInfo(`  ${e.name.padEnd(16)} ${e.sshUser}@${e.host}${port}${key}${tags}`);
        }
        return;
      }
      if (cmd.kind === 'env-remove') {
        const removed = await deps.registry.remove(cmd.name);
        if (removed) appendInfo(`removed env: ${cmd.name}`);
        else appendError(`no such env: ${cmd.name}`);
        return;
      }
      if (cmd.kind === 'env-add') {
        try {
          const env = await deps.registry.upsert({
            name: cmd.name,
            host: cmd.host,
            sshUser: cmd.sshUser,
            ...(cmd.port === undefined ? {} : { port: cmd.port }),
            ...(cmd.identityFile === undefined ? {} : { identityFile: cmd.identityFile }),
            ...(cmd.description === undefined ? {} : { description: cmd.description }),
            ...(cmd.tags === undefined ? {} : { tags: cmd.tags }),
          });
          const port = env.port === undefined ? '' : `:${env.port}`;
          appendInfo(`saved env "${env.name}" → ${env.sshUser}@${env.host}${port}`);
        } catch (err) {
          if (err instanceof InvalidEnvironmentError) {
            appendError(`invalid: ${err.message}`);
          } else {
            appendError(`save failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return;
      }
    },
    [
      deps.registry,
      deps.chatHistory,
      currentClient,
      deps.costTracker,
      deps.db,
      deps.embedder,
      currentSessionId,
      exit,
      state.entries,
      appendInfo,
      appendError,
    ],
  );

  const runAgent = useCallback(
    async (userText: string): Promise<void> => {
      dispatch({ type: 'set-busy', busy: true });
      const runner = runnerRef.current;
      if (runner === null) {
        appendError('agent runner not initialized');
        dispatch({ type: 'set-busy', busy: false });
        return;
      }

      if (deps.chatHistory !== undefined) {
        try {
          await deps.chatHistory.appendUser(currentSessionId, userText);
        } catch (err) {
          appendError(
            `chat history append failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Fire-and-forget title generation on the FIRST user prompt of the session
      if (!titleGenerationFiredRef.current && deps.sessionsRepo !== undefined) {
        titleGenerationFiredRef.current = true;
        void (async () => {
          const t = await generateSessionTitle(userText, currentClient);
          if (t === null) return;
          dispatch({ type: 'set-title', title: t });
          try {
            await deps.sessionsRepo!.setTitle(currentSessionId, t);
          } catch {
            // silent
          }
        })();
      }

      try {
        for await (const event of runner.run({
          userRequest: userText,
          sessionId: currentSessionId,
        })) {
          if (event.type === 'synthesize-chunk') {
            // Append delta to the partial; emit each completed line into the
            // scrollback as its own entry. The partial (without trailing \n)
            // stays dynamic at the bottom until newline or stream-end.
            streamFullRef.current += event.delta;
            streamPartialRef.current += event.delta;
            while (streamPartialRef.current.includes('\n')) {
              const idx = streamPartialRef.current.indexOf('\n');
              const line = streamPartialRef.current.slice(0, idx);
              streamPartialRef.current = streamPartialRef.current.slice(idx + 1);
              dispatch({ type: 'stream-line-complete', line });
            }
            dispatch({ type: 'stream-set-partial', partial: streamPartialRef.current });
            continue;
          }
          if (event.type === 'plan-started') {
            dispatch({ type: 'set-phase', phase: 'planning' });
          }
          if (event.type === 'gather-step-started') {
            dispatch({ type: 'set-phase', phase: 'gathering' });
          }
          if (event.type === 'synthesize-started') {
            // Begin a NEW dynamic streaming block. The previous attempt (if
            // any) was already discarded by verify-failed retrying below —
            // so this is a clean canvas.
            pendingReportRef.current = null;
            streamFullRef.current = '';
            streamPartialRef.current = '';
            dispatch({ type: 'set-phase', phase: 'synthesizing' });
            dispatch({ type: 'stream-begin' });
          }
          if (event.type === 'synthesize-ready') {
            // Flush any trailing partial as a final line and snapshot the
            // full markdown for archive. Nothing is committed to scrollback
            // yet — the next verify-* event decides whether to commit or
            // discard the stream buffer.
            if (streamPartialRef.current !== '') {
              dispatch({ type: 'stream-line-complete', line: streamPartialRef.current });
              streamPartialRef.current = '';
            }
            pendingReportRef.current = event.reportMarkdown;
            void recountTokens(currentSessionId, deps.chatHistory, dispatch);
            refreshRemoteCredit();
          }
          if (event.type === 'verify-passed') {
            // Promote the streaming buffer to ONE permanent `report` entry.
            dispatch({ type: 'stream-commit', verified: true });
          }
          if (event.type === 'verify-failed') {
            if (event.retrying) {
              // Discard the in-progress block — the next synth will re-stream
              // a corrected version into a fresh canvas. The user never sees
              // the rejected attempt linger in scrollback.
              dispatch({ type: 'stream-discard' });
              if (state.debugMode) {
                appendInfo('rewriting to ground every claim with citations…');
              }
            } else {
              // Final answer is ungrounded — commit anyway with verified=false
              // so the user gets the imperfect answer rather than nothing.
              dispatch({ type: 'stream-commit', verified: false });
            }
          }
          if (event.type === 'proposals-ready' && event.iteration > 0) {
            dispatch({
              type: 'append-entry',
              entry: {
                kind: 'info',
                id: nextId(),
                text: `investigating further (iteration ${event.iteration})…`,
              },
            });
          }
          if (event.type === 'done') {
            // Archive the streamed markdown (already line-by-line in scrollback).
            const finalMd = pendingReportRef.current ?? streamFullRef.current;
            if (finalMd !== '') {
              void archiveReport(currentSessionId, finalMd)
                .then((r) => {
                  if (state.debugMode) appendInfo(`report saved → ${r.path}`);
                })
                .catch(() => {
                  // silent
                });
            }
            pendingReportRef.current = null;
            streamFullRef.current = '';
            void recountTokens(currentSessionId, deps.chatHistory, dispatch);
            refreshRemoteCredit();
            if (deps.sessionsRepo !== undefined) {
              void deps.sessionsRepo.touch(currentSessionId).catch(() => {
                // silent
              });
            }
          }
          if (event.type === 'compaction-applied') {
            void recountTokens(currentSessionId, deps.chatHistory, dispatch);
          }
          // Skip pushing the agent-event line when reasoning is collapsed,
          // except for terminal events (done/aborted) which the user always
          // wants visible.
          const isTerminal = event.type === 'done' || event.type === 'aborted';
          if (showReasoningRef.current || isTerminal) {
            dispatch({
              type: 'append-entry',
              entry: { kind: 'agent-event', id: nextId(), event },
            });
          }
          maybeTrackCost(event, dispatch);
        }
      } catch (err) {
        appendError(`agent crash: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        dispatch({ type: 'set-busy', busy: false });
        dispatch({ type: 'set-phase', phase: 'idle' });
      }
    },
    [currentSessionId, deps.chatHistory, appendError],
  );

  const stopWatch = useCallback(() => {
    watchAbortRef.current?.abort();
    watchAbortRef.current = null;
    dispatch({ type: 'watch-stop' });
  }, []);

  const startWatch = useCallback(
    (plan: WatchPlan): void => {
      const runner = runnerRef.current;
      if (runner === null || deps.db === undefined) {
        appendError('cannot start watch — runner or database not available');
        return;
      }
      const abortController = new AbortController();
      watchAbortRef.current = abortController;
      dispatch({ type: 'watch-start', plan });
      appendInfo(`watching "${plan.name}" on ${plan.environment} — press q or Esc to stop`);

      const store = createWatchStore(deps.db);
      const policy = createAnomalyPolicy(DEFAULT_POLICY_CONFIG, () => Date.now());
      const notifier = createNotifier({
        execDesktopNotification: async (title, message) => {
          await deps.executor.exec('notify.desktop', { title, message }, { sessionId: currentSessionId });
        },
        webhookUrls: deps.watchWebhookUrls ?? [],
      });
      const diagnoser = createWatchDiagnoser({
        runDiagnostic: (prompt) => runner.run({ userRequest: prompt, sessionId: currentSessionId }),
        isAffordable: () => deps.costTracker.maxSessionCostUsd === null
          || state.costUsd < deps.costTracker.maxSessionCostUsd,
      });
      const gen = runWatch(plan, {
        runCheck: (check) =>
          runCheck(check, {
            executor: deps.executor,
            catalog: deps.catalog,
            sessionId: currentSessionId,
            now: () => Date.now(),
          }),
        policy,
        store,
        sessionId: currentSessionId,
        now: () => Date.now(),
        sleep: abortableSleep,
        signal: abortController.signal,
        notify: async (_checkName, watchPlan, outcome) => {
          await notifier.notifyAnomaly(watchPlan, outcome);
        },
        diagnose: diagnoser,
      });

      void (async () => {
        try {
          for await (const ev of gen) {
            if (ev.type === 'anomaly') process.stdout.write('');
            // Surface notifier failures in the chat feed before folding into
            // the reducer — the WatchUiState has no field for them and the
            // user needs to know their notification channel is broken.
            if (ev.type === 'notify-failed') {
              appendError(`notifier (${ev.channel}): ${ev.message}`);
              continue;
            }
            dispatch({ type: 'watch-event', event: ev });
          }
        } catch (err) {
          appendError(`watch loop crashed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          if (watchAbortRef.current === abortController) watchAbortRef.current = null;
          dispatch({ type: 'watch-stop' });
        }
      })();
    },
    [deps.db, deps.executor, deps.catalog, deps.costTracker, currentSessionId, state.costUsd, appendInfo, appendError],
  );

  const startStockPlan = useCallback(
    async (stockText: string, planName: string): Promise<void> => {
      const envs = await deps.registry.list();
      if (envs.length === 0) {
        appendError('no environments registered. /env add <name> <user@host[:port]> first.');
        return;
      }
      if (envs.length > 1) {
        appendInfo(`"${planName}" needs an environment. Registered: ${envs.map((e) => e.name).join(', ')}`);
        appendInfo(`Re-run as: /watch ${planName} <env-name>  — or run /watch <env-name>-${planName}`);
        return;
      }
      const env = envs[0]!;
      try {
        const plan = parseWatchPlan(instantiateStockPlan(stockText, env.name), 'stock');
        validateAgainstCatalog(plan, deps.catalog);
        startWatch(plan);
      } catch (err) {
        const msg = err instanceof InvalidWatchPlanError || err instanceof Error ? err.message : String(err);
        appendError(`could not start ${planName}: ${msg}`);
      }
    },
    [deps.registry, deps.catalog, startWatch, appendInfo, appendError],
  );

  const compileFromText = useCallback(
    async (request: string): Promise<void> => {
      const envs = await deps.registry.list();
      if (envs.length === 0) {
        appendError('no environments registered — cannot compile a watch plan.');
        return;
      }
      appendInfo('compiling a watch plan from your request…');
      dispatch({ type: 'set-busy', busy: true });
      try {
        const result = await compileWatchPlan(request, {
          catalog: deps.catalog,
          environmentNames: envs.map((e) => e.name),
          complete: (messages) => completeForCompiler(messages, currentClient, currentSessionId, deps.costTracker, dispatch),
        });
        if (result.kind === 'error') {
          appendError(`compile failed: ${result.message}`);
          return;
        }
        const dir = defaultWatchesDir();
        await mkdir(dir, { recursive: true });
        const path = join(dir, `${result.plan.name}.md`);
        await Bun.write(path, serializeWatchPlan(result.plan));
        appendInfo(`compiled "${result.plan.name}" (${result.plan.checks.length} checks) → saved to ${path}`);
        for (const c of result.plan.checks) {
          appendInfo(`  ${c.name}: ${c.action} expect ${c.expect.kind}`);
        }
        appendInfo(`Start it with /watch ${result.plan.name}`);
      } catch (err) {
        appendError(`compile error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        dispatch({ type: 'set-busy', busy: false });
      }
    },
    [deps.registry, deps.catalog, deps.costTracker, currentClient, currentSessionId, appendInfo, appendError],
  );

  const handleWatchCommand = useCallback(
    async (target: string | undefined): Promise<void> => {
      const userPlans = await loadPlansFromDir(defaultWatchesDir(), deps.catalog);
      for (const f of userPlans.failures) {
        appendError(`skipped plan ${f.path}: ${f.message}`);
      }

      // No target → list stock + user plans.
      if (target === undefined) {
        appendInfo('stock plans:');
        for (const sp of STOCK_PLANS) appendInfo(`  ${sp.name}`);
        if (userPlans.plans.length > 0) {
          appendInfo('your plans:');
          for (const p of userPlans.plans) appendInfo(`  ${p.plan.name} — ${p.plan.description}`);
        }
        appendInfo('Use /watch <name> to start, or /watch <description> to compile a new plan.');
        return;
      }

      const stock = STOCK_PLANS.find((sp) => sp.name === target);
      const userMatch = userPlans.plans.find((p) => p.plan.name === target);

      if (stock !== undefined) {
        await startStockPlan(stock.text, target);
        return;
      }
      if (userMatch !== undefined) {
        startWatch(userMatch.plan);
        return;
      }

      // A single token that names no plan, or multi-word text → compile.
      const looksLikePlanName = /^[a-z][a-z0-9-]*$/.test(target);
      if (looksLikePlanName && !target.includes(' ')) {
        appendError(`no plan named "${target}". /watch lists available plans.`);
        return;
      }
      await compileFromText(target);
    },
    [deps.catalog, startWatch, startStockPlan, compileFromText, appendInfo, appendError],
  );

  const submit = useCallback(async (override?: string) => {
    const text = (override ?? state.input).trim();
    if (text === '') return;
    dispatch({ type: 'clear-input' });
    dispatch({ type: 'append-entry', entry: { kind: 'user', id: nextId(), text } });
    const parsed = parseSlashCommand(text);
    if (parsed !== null) {
      if (parsed.ok && parsed.command.kind === 'watch') {
        await handleWatchCommand(parsed.command.target);
      } else if (parsed.ok) {
        await handleSlashCommand(parsed.command);
      } else {
        appendError(parsed.message);
      }
      return;
    }
    await runAgent(text);
  }, [state.input, handleSlashCommand, handleWatchCommand, runAgent, appendError]);

  const resolveApproval = useCallback(
    (decision: ProposalDecision) => {
      if (state.pendingApproval === undefined) return;
      state.pendingApproval.resolve(decision);
      dispatch({ type: 'clear-approval' });
    },
    [state.pendingApproval],
  );

  const resolveMutation = useCallback(
    (decision: MutationDecision) => {
      if (state.pendingMutation === undefined) return;
      state.pendingMutation.resolve(decision);
      dispatch({ type: 'clear-mutation' });
    },
    [state.pendingMutation],
  );

  const resolveElevation = useCallback(
    (decision: MutationDecision) => {
      if (state.pendingElevation === undefined) return;
      state.pendingElevation.resolve(decision);
      dispatch({ type: 'clear-elevation' });
    },
    [state.pendingElevation],
  );

  const resolveSudoPassword = useCallback(
    (allow: boolean) => {
      if (state.pendingSudoPassword === undefined) return;
      state.pendingSudoPassword.resolve(allow);
      dispatch({ type: 'clear-sudo-password' });
    },
    [state.pendingSudoPassword],
  );

  useInput((input, key) => {
    if (state.showHelp) {
      dispatch({ type: 'set-help', show: false });
      return;
    }
    // While a watch is active the WatchPanel owns the keyboard (↑↓/⏎/d/q/Esc).
    // Opt the main App out entirely — Ink delivers each key to every active
    // useInput subscriber, so without this the panel's keys would also leak
    // into the prompt buffer. Stopping the watch is handled by the panel's
    // own onStop → stopWatch.
    if (state.watch !== null) {
      return;
    }
    // Mode toggle: Shift+Tab — always available
    if (key.shift && key.tab) {
      dispatch({ type: 'toggle-mode' });
      return;
    }
    // Ctrl+O: toggle reasoning visibility (collapse / expand agent steps)
    if (key.ctrl && input === 'o') {
      dispatch({ type: 'toggle-reasoning' });
      return;
    }
    // Global Esc safety-net for modal overlays. Each picker has its own
    // `useInput` that catches Esc and emits onClose, but if for any reason
    // its handler is missed (unmount race, focus quirk), Esc here will
    // close the picker too — never leave the user "stuck" with no way out.
    // Dispatching show=false on an already-closed picker is a harmless
    // no-op, so we can run all three unconditionally.
    if (key.escape && (state.showModelPicker || state.showSessionPicker || state.showMemoryViewer)) {
      if (state.showModelPicker) dispatch({ type: 'show-model-picker', show: false });
      if (state.showSessionPicker) dispatch({ type: 'show-session-picker', show: false });
      if (state.showMemoryViewer) dispatch({ type: 'show-memory-viewer', show: false });
      return;
    }
    // When a modal picker overlay is mounted, it owns keyboard input. The
    // main App must NOT process any key — otherwise the filter characters
    // typed inside the picker also append to the main prompt buffer, and
    // the user gets that buffer submitted to the agent the next time they
    // press Enter. (Pickers have their own internal `useInput`, but Ink
    // delivers each key to ALL active subscribers, so we have to opt out
    // explicitly here.)
    if (state.showModelPicker || state.showSessionPicker || state.showMemoryViewer) {
      return;
    }
    // Sudo-password passthrough confirm: a simple yes/no. `y` runs the
    // INTERACTIVE ssh -tt session (the user types the password on their
    // terminal); anything else declines. Checked before all other gates.
    if (state.pendingSudoPassword !== undefined) {
      if (key.ctrl && input === 'c') {
        resolveSudoPassword(false);
        return;
      }
      if (key.escape) {
        resolveSudoPassword(false);
        return;
      }
      const ch = input.toLowerCase();
      if (ch === 'y') {
        resolveSudoPassword(true);
        return;
      }
      if (ch === 'n') {
        resolveSudoPassword(false);
        return;
      }
      // Everything else ignored — no buffer mutation.
      return;
    }
    // Elevation (sudo) approval mode. Ordered BEFORE the mutation gate so a
    // mutate+sudo proposal resolves the elevation first. For double-confirm
    // proposals the first `a` only arms; a second `a` resolves approve-once.
    if (state.pendingElevation !== undefined) {
      const proposal = state.pendingElevation.proposal;
      if (key.ctrl && input === 'c') {
        resolveElevation({ kind: 'reject', reason: 'user rejected sudo' });
        return;
      }
      if (key.escape) {
        resolveElevation({ kind: 'reject', reason: 'user rejected sudo' });
        return;
      }
      const ch = input.toLowerCase();
      if (ch === 'a' || ch === 'y') {
        if (proposal.doubleConfirm && !state.elevationConfirmArmed) {
          dispatch({ type: 'arm-elevation-confirm' });
          return;
        }
        resolveElevation({ kind: 'approve-once' });
        return;
      }
      if (ch === 'r' && proposal.tier !== 'destructive') {
        // 'r' = approve & remember (session). Destructive sudo is NEVER
        // rememberable — the option is hidden in the panel and rejected here.
        // approve-remember is MORE consequential than approve-once (it persists
        // for the session), so it MUST also honour doubleConfirm — mirror the
        // same arming logic used for 'a'.
        if (proposal.doubleConfirm && !state.elevationConfirmArmed) {
          dispatch({ type: 'arm-elevation-confirm' });
          return;
        }
        resolveElevation({ kind: 'approve-remember' });
        return;
      }
      if (ch === 'n') {
        resolveElevation({ kind: 'reject', reason: 'user rejected sudo' });
        return;
      }
      // Everything else ignored — no buffer mutation, no fallthrough.
      return;
    }
    // Mutation approval mode: a single mutation proposal is on screen and
    // the user must say a/r/n. ESC and Ctrl+C count as reject. We hold the
    // input buffer hostage — typing other characters does nothing — because
    // any stray keystroke during this prompt could trigger a deploy and
    // that's exactly what the gate is here to prevent.
    if (state.pendingMutation !== undefined) {
      if (key.ctrl && input === 'c') {
        resolveMutation({ kind: 'reject', reason: 'Ctrl+C' });
        return;
      }
      if (key.escape) {
        resolveMutation({ kind: 'reject', reason: 'Esc' });
        return;
      }
      const ch = input.toLowerCase();
      if (ch === 'a' || ch === 'y') {
        resolveMutation({ kind: 'approve-once' });
        return;
      }
      if (ch === 'r' && state.pendingMutation.proposal.tier === 'mutate') {
        // 'r' = approve & remember per env. Destructive can NEVER be
        // remembered — for that tier the executor downgrades to once
        // anyway, but we don't even surface the option in the panel.
        resolveMutation({ kind: 'approve-remember' });
        return;
      }
      if (ch === 'n') {
        resolveMutation({ kind: 'reject', reason: 'user pressed n' });
        return;
      }
      // Everything else: ignored on purpose. No buffer mutation, no fallthrough.
      return;
    }
    if (state.pendingApproval !== undefined) {
      // Approval mode: single-key shortcuts when the buffer is empty + the
      // classic "compose 1,3 + Enter" path for picklist selections.
      if (key.ctrl && input === 'c') {
        resolveApproval({ acceptedIndices: [], stop: true });
        return;
      }
      if (key.escape) {
        resolveApproval({ acceptedIndices: [], stop: false });
        return;
      }
      if (key.return) {
        const trimmed = state.input.trim();
        const decision = parseApprovalInput(trimmed, state.pendingApproval.proposals.length);
        resolveApproval(decision);
        return;
      }
      if (key.backspace || key.delete) {
        dispatch({ type: 'backspace' });
        return;
      }
      // Single-key shortcuts — only when the user hasn't started composing a
      // picklist. The moment a digit/comma/space goes in we know they're
      // typing "1,3" or similar, so we fall through to the buffer path
      // and wait for Enter. This matches the MutationApprovalPanel UX:
      // y/a/n/q resolve instantly, no Enter needed.
      if (state.input === '' && !key.ctrl && !key.meta) {
        const ch = input.toLowerCase();
        if (ch === 'y' || ch === 'a') {
          resolveApproval({
            acceptedIndices: Array.from(
              { length: state.pendingApproval.proposals.length },
              (_, i) => i,
            ),
            stop: false,
          });
          return;
        }
        if (ch === 'n') {
          resolveApproval({ acceptedIndices: [], stop: false });
          return;
        }
        if (ch === 'q') {
          resolveApproval({ acceptedIndices: [], stop: true });
          return;
        }
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        dispatch({ type: 'append-input', ch: input });
      }
      return;
    }
    if (state.busy) return;

    // Autocomplete only shows BEFORE the user starts entering arguments.
    // Once the input contains a space (meaning the user has typed past the
    // verb and is filling in args), autocomplete steps out of the way so
    // Enter / Tab go to the normal input handlers — otherwise typing
    // "/env add foo bar" + Enter would clobber the line with "/env add ".
    const hasArgs = /^\/\S+\s/.test(state.input);
    const completions =
      state.input.startsWith('/') && !state.autocompleteDismissed && !hasArgs
        ? slashCompletions(state.input)
        : [];
    const autocompleteOpen = completions.length > 0;

    if (autocompleteOpen) {
      if (key.escape) {
        dispatch({ type: 'dismiss-autocomplete' });
        return;
      }
      if (key.upArrow) {
        const next = (state.autocompleteIndex - 1 + completions.length) % completions.length;
        dispatch({ type: 'set-autocomplete-index', index: next });
        return;
      }
      if (key.downArrow) {
        const next = (state.autocompleteIndex + 1) % completions.length;
        dispatch({ type: 'set-autocomplete-index', index: next });
        return;
      }
      if (key.tab) {
        const pick = completions[state.autocompleteIndex] ?? completions[0];
        if (pick !== undefined) {
          dispatch({ type: 'set-input', value: pick.command });
        }
        return;
      }
      // Enter inside the autocomplete dropdown applies the highlighted entry
      // (unless input EXACTLY matches a complete command — then Enter submits).
      if (key.return && !key.shift && !key.meta && !key.ctrl) {
        const pick = completions[state.autocompleteIndex] ?? completions[0];
        if (pick !== undefined) {
          const currentLower = state.input.trim().toLowerCase();
          const pickLower = pick.command.trim().toLowerCase();
          if (currentLower === pickLower) {
            // Already typed the full command — submit.
            void submit();
            return;
          }
          // Apply the suggestion. If it's a leaf command (no trailing space),
          // submit it immediately so the user doesn't have to hit Enter twice.
          dispatch({ type: 'set-input', value: pick.command });
          if (!pick.command.endsWith(' ')) {
            void submit(pick.command);
          }
          return;
        }
      }
    }

    // Multi-line newline triggers (terminals vary — try multiple):
    //  * Ctrl+J emits LF (\n) on most terminals — capture it BEFORE generic input
    //  * Alt+Enter (key.meta && key.return) on macOS Terminal/iTerm
    //  * Shift+Enter where the terminal forwards it (rare, but cheap to support)
    if (key.ctrl && input === '\n') {
      dispatch({ type: 'append-input', ch: '\n' });
      return;
    }
    if (key.meta && key.return) {
      dispatch({ type: 'append-input', ch: '\n' });
      return;
    }
    if (key.return) {
      if (key.shift) {
        dispatch({ type: 'append-input', ch: '\n' });
        return;
      }
      void submit();
      return;
    }
    if (key.backspace || key.delete) {
      dispatch({ type: 'backspace' });
      return;
    }
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }
    // Esc: wipe the input buffer (Claude-Code-style). Only fires here, AFTER
    // autocomplete-dismiss / model-picker / approval modal already had their
    // chance to consume it.
    if (key.escape) {
      if (state.input !== '') dispatch({ type: 'clear-input' });
      return;
    }
    if (input !== '' && !key.ctrl && !key.meta) {
      dispatch({ type: 'append-input', ch: input });
    }
  });

  if (state.showHelp) return <Help />;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/*
        SCROLLBACK PERSISTENCE: every appended entry goes through <Static>.
        Ink writes each item ONCE to the terminal and never repaints it.
        That means past prompts, agent events, and final reports stay in the
        scrollback as the conversation grows. Items must never be mutated
        after being appended — our reducer only appends (immutable), so the
        contract holds.

        Note: spinners (Braille animation) on agent-events do NOT animate inside
        Static — the entry is rendered once with live=false. The 'started' line
        shows a static '○' placeholder; a separate 'done' / 'failed' event
        arrives later as its own static line ('✓' or '✗'). The user sees a
        clear two-line history rather than an animated overwrite.
      */}
      <Static items={state.entries}>
        {(entry, i) => {
          const prevWasUser = i > 0 && state.entries[i - 1]?.kind === 'user';
          const isFirstPrompt =
            entry.kind === 'user' && state.entries.slice(0, i).every((e) => e.kind !== 'user');
          return (
            <EntryView
              key={entry.id}
              entry={entry}
              live={false}
              debug={state.debugMode}
              isFirstAfterPrompt={isFirstPrompt || prevWasUser}
            />
          );
        }}
      </Static>

      <Box flexDirection="column">
        {state.streamingActive && (
          <ReportBlock
            withMascot
            lines={[
              ...state.streamingLines,
              ...(state.streamingPartial !== '' ? [state.streamingPartial] : []),
            ]}
            withCursor={state.streamingPartial !== ''}
          />
        )}
        {state.busy && !state.streamingActive && state.agentPhase !== 'idle' && (
          <PhaseIndicator phase={state.agentPhase} />
        )}
      </Box>

      {state.showModelPicker && deps.onSwitchModel !== undefined && (
        <ModelPicker
          onCancel={() => dispatch({ type: 'show-model-picker', show: false })}
          onSelect={(sel) => {
            dispatch({ type: 'show-model-picker', show: false });
            void (async () => {
              const newClient = await deps.onSwitchModel!(sel);
              if (newClient === null) {
                appendError('model switch failed');
                return;
              }
              setCurrentClient(newClient);
              appendInfo(`switched to ${newClient.modelId} (${newClient.isLocal ? 'local' : 'remote'})`);
            })();
          }}
          {...(deps.openrouterApiKey === undefined ? {} : { openRouterApiKey: deps.openrouterApiKey })}
        />
      )}

      {state.showMemoryViewer && deps.db !== undefined && (
        <MemoryViewer
          db={deps.db}
          onClose={() => dispatch({ type: 'show-memory-viewer', show: false })}
        />
      )}

      {state.showSessionPicker && deps.sessionsRepo !== undefined && (
        <SessionPicker
          sessionsRepo={deps.sessionsRepo}
          currentSessionId={currentSessionId}
          onCancel={() => dispatch({ type: 'show-session-picker', show: false })}
          onSelect={(picked) => {
            dispatch({ type: 'show-session-picker', show: false });
            void handleResume(picked);
          }}
        />
      )}

      {state.watch !== null && (
        <WatchPanel
          plan={state.watch.plan}
          lastOutcomes={state.watch.lastOutcomes}
          history={state.watch.history}
          anomalies={state.watch.anomalies}
          diagnoses={state.watch.diagnoses}
          diagnosing={state.watch.diagnosing}
          onStop={stopWatch}
          onViewDiagnosis={(checkName) => {
            const md = state.watch?.diagnoses.get(checkName);
            if (md !== undefined && md !== '') {
              dispatch({
                type: 'append-entry',
                entry: { kind: 'report', id: nextId(), markdown: md, verified: true },
              });
            }
          }}
        />
      )}

      {state.pendingApproval !== undefined && (
        <Proposals
          proposals={state.pendingApproval.proposals}
          iteration={state.pendingApproval.iteration}
          input={state.input}
        />
      )}

      {/* Elevation comes first: a mutate+sudo proposal resolves the sudo gate
          before the mutation gate. */}
      {state.pendingElevation !== undefined && (
        <ElevationApprovalPanel
          proposal={state.pendingElevation.proposal}
          doubleConfirmArmed={state.elevationConfirmArmed}
        />
      )}

      {state.pendingElevation === undefined && state.pendingMutation !== undefined && (
        <MutationApprovalPanel proposal={state.pendingMutation.proposal} />
      )}

      {state.pendingSudoPassword !== undefined && (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
          <Text bold color="yellow">
            sudo needs a password for {state.pendingSudoPassword.actionName}
          </Text>
          <Box marginTop={1} marginLeft={2}>
            <Text color="white">{state.pendingSudoPassword.commandScrubbed}</Text>
          </Box>
          <Box marginTop={1}>
            <Text bold>
              <Text color="green">[y]</Text>
              <Text> type your password in the terminal   </Text>
              <Text color="red">[n]</Text>
              <Text> cancel</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              PIPER never sees the password — the interactive ssh session owns the terminal.
            </Text>
          </Box>
        </Box>
      )}

      {state.entries.length === 0 &&
        !state.streamingActive &&
        !state.busy &&
        state.pendingApproval === undefined &&
        state.pendingElevation === undefined &&
        state.pendingSudoPassword === undefined &&
        state.pendingMutation === undefined && <Banner />}

      {state.pendingApproval === undefined &&
        state.pendingMutation === undefined &&
        state.pendingElevation === undefined &&
        state.pendingSudoPassword === undefined &&
        state.watch === null &&
        !state.showModelPicker &&
        !state.showSessionPicker &&
        !state.showMemoryViewer && (
        <Box flexDirection="column" marginTop={1}>
          <Box
            borderStyle="round"
            borderColor={state.busy ? 'gray' : 'cyan'}
            paddingX={1}
            flexDirection="column"
          >
            {state.input.split('\n').map((line, i, arr) => (
              <Box key={i}>
                <Text color={state.busy ? 'gray' : 'cyan'} bold>
                  {i === 0 ? (state.busy ? '… ' : '› ') : '  '}
                </Text>
                <Text>{line}</Text>
                {i === arr.length - 1 && !state.busy && <Text inverse> </Text>}
              </Box>
            ))}
          </Box>
          {state.input.startsWith('/') && !state.autocompleteDismissed && (
            <SlashAutocomplete
              completions={slashCompletions(state.input)}
              selectedIndex={state.autocompleteIndex}
            />
          )}
          {/*
            Status bar — ONE row under a thin dim separator, then a quiet
            keybinding hint. Components are ordered by importance, left→right:

              ─────────────────────────────────────────────────────────────
               Y(◐ ◐)Y  deepseek-v4-pro   HUMAN   ·  $0.0123 · 12k/128k ███░ · ◆ $4.32
               Shift+Tab mode · Ctrl+O reasoning · Esc clear · / cmds · Ctrl+C exit

            The model name sits next to the mascot in light grey; the HUMAN/YOLO
            badge is an inverse chip so the mode is unmistakable at a glance.
          */}
          <Box marginTop={0}>
            <Text dimColor>{'─'.repeat(60)}</Text>
          </Box>
          <Box>
            <AlienFace busy={state.busy} bold />
            <Text> </Text>
            <Text color="gray"> {shortenModelName(currentClient.modelId)}</Text>
            <Text>   </Text>
            <ModeBadge mode={state.executionMode} />
            <Text dimColor>   ·  </Text>
            <Text color="yellow">${state.costUsd.toFixed(4)}</Text>
            {deps.maxSessionCostUsd !== undefined && (
              <Text dimColor>{`/$${deps.maxSessionCostUsd.toFixed(2)}`}</Text>
            )}
            <Text dimColor>  ·  </Text>
            <TokenMeter
              tokensUsed={state.tokensUsed}
              modelLimit={currentClient.capabilities.maxContextTokens}
            />
            <CreditTail client={currentClient} credit={state.remoteCredit} />
            {!state.showReasoning && <Text color="magenta">  ·  reasoning hidden</Text>}
          </Box>
          <Text dimColor>
            Shift+Tab mode · Ctrl+O reasoning · Esc clear · / cmds · Ctrl+C exit
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** A sleep that resolves early when the AbortSignal fires (clean watch shutdown). */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * The compiler's `complete` hook: one LLM round-trip through the cost-tracked
 * path (budget guard + record), returning assistant text. Mirrors how the agent
 * runner issues LLM calls — never a raw fetch.
 */
async function completeForCompiler(
  messages: readonly CompilerMessage[],
  client: ModelClient,
  sessionId: SessionId,
  costTracker: CostTracker,
  dispatch: React.Dispatch<Action>,
): Promise<string> {
  const { completion, costUsd } = await trackedComplete({
    client,
    costTracker,
    sessionId,
    role: 'planner',
    req: { messages: messages.map((m) => ({ role: m.role, content: m.content })) },
  });
  if (costUsd > 0) dispatch({ type: 'inc-cost', usd: costUsd });
  return completion.content;
}

async function recountTokens(
  sessionId: SessionId,
  chatHistory: ChatHistory | undefined,
  dispatch: React.Dispatch<Action>,
): Promise<void> {
  if (chatHistory === undefined) return;
  try {
    const msgs = await chatHistory.forPlanner(sessionId, 64);
    const tokens = countMessagesTokens(msgs.map((m) => ({ role: m.role, content: m.content })));
    dispatch({ type: 'set-tokens', tokens });
  } catch {
    // best-effort meter — silently ignore
  }
}

/**
 * The "working" indicator. Uses the alien mascot as a single visual signal,
 * but tints it by phase so the user can tell what's happening at a glance:
 *
 *   planning      cyan      "thinking…"        — choosing what to run
 *   gathering     yellow    "running checks…"  — actions executing
 *   synthesizing  green     "writing…"         — answer streaming
 *                                                (handled in the streaming block,
 *                                                 not here)
 */
function PhaseIndicator({
  phase,
}: {
  phase: 'planning' | 'gathering' | 'synthesizing';
}): JSX.Element {
  const config: Record<typeof phase, { label: string; color: 'cyan' | 'yellow' | 'green' }> = {
    planning: { label: 'thinking…', color: 'cyan' },
    gathering: { label: 'running checks…', color: 'yellow' },
    synthesizing: { label: 'writing…', color: 'green' },
  };
  const { label, color } = config[phase];
  return (
    <Box>
      <Text color={color} bold>{'  '}</Text>
      <AlienFace busy color={color} bold />
      <Text dimColor>{`  ${label}`}</Text>
    </Box>
  );
}

function shortenModelName(id: string): string {
  // Strip the org prefix ("openai/gpt-4o" → "gpt-4o", "deepseek/deepseek-v4-flash" → "deepseek-v4-flash")
  const slashIdx = id.indexOf('/');
  return slashIdx === -1 ? id : id.slice(slashIdx + 1);
}

/** HUMAN / YOLO mode as an inverse chip — unmistakable at a glance. */
function ModeBadge({ mode }: { mode: 'human' | 'yolo' }): JSX.Element {
  if (mode === 'yolo') {
    return (
      <Text backgroundColor="red" color="white" bold>
        {' YOLO '}
      </Text>
    );
  }
  return (
    <Text backgroundColor="green" color="black" bold>
      {' HUMAN '}
    </Text>
  );
}

/**
 * Trailing credit indicator for the status row. The model NAME now lives next
 * to the mascot, so this shows only the provider dot + remaining balance.
 */
function CreditTail({
  client,
  credit,
}: {
  client: ModelClient;
  credit: RemoteCredit | null;
}): JSX.Element {
  if (client.isLocal) {
    return (
      <Text>
        <Text dimColor>{'  ·  '}</Text>
        <Text color="green">◆ local</Text>
      </Text>
    );
  }
  if (credit === null) {
    return (
      <Text>
        <Text dimColor>{'  ·  '}</Text>
        <Text color="magenta">◆</Text>
      </Text>
    );
  }
  const remaining = credit.remaining;
  if (remaining === null) {
    return (
      <Text>
        <Text dimColor>{'  ·  '}</Text>
        <Text color="magenta">◆ </Text>
        <Text dimColor>used ${credit.totalUsage.toFixed(2)}</Text>
      </Text>
    );
  }
  const lowBalance = remaining < 1;
  return (
    <Text>
      <Text dimColor>{'  ·  '}</Text>
      <Text color="magenta">◆ </Text>
      <Text color={lowBalance ? 'red' : 'green'}>${remaining.toFixed(2)}</Text>
    </Text>
  );
}

function TokenMeter({
  tokensUsed,
  modelLimit,
}: {
  tokensUsed: number;
  modelLimit: number;
}): JSX.Element {
  const pct = Math.min(100, (tokensUsed / Math.max(1, modelLimit)) * 100);
  const color = pct >= 85 ? 'red' : pct >= 60 ? 'yellow' : 'green';
  const barWidth = 10;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  // Compact: no `tok=` prefix. "12k/128k ████░░░░░░" is self-explanatory.
  return (
    <Text>
      <Text color={color}>▮ </Text>
      <Text color={color}>
        {formatTokenCount(tokensUsed)}/{formatTokenLimit(modelLimit)}
      </Text>
      <Text dimColor>  </Text>
      <Text color={color}>{bar}</Text>
    </Text>
  );
}

function EntryView({
  entry,
  live,
  debug,
  isFirstAfterPrompt,
}: {
  entry: ChatEntry;
  live: boolean;
  debug: boolean;
  isFirstAfterPrompt: boolean;
}): JSX.Element {
  const Inner = ((): JSX.Element => {
    switch (entry.kind) {
      case 'user':
        return (
          <Box>
            <Text color="cyan" bold>{'› '}</Text>
            <Text>{entry.text}</Text>
          </Box>
        );
      case 'info':
        return <Text color="gray">  {entry.text}</Text>;
      case 'error':
        return <Text color="red">  ! {entry.text}</Text>;
      case 'agent-event':
        return <AgentEventLine event={entry.event} live={live} debug={debug} />;
      case 'report':
        return <Report markdown={entry.markdown} verified={entry.verified} />;
      case 'report-start':
        return (
          <Box marginTop={1}>
            <Text color="cyan" bold>{'  ▌ '}</Text>
            <AlienFace busy color="cyan" bold />
          </Box>
        );
      case 'report-line': {
        const color = 'green';
        return (
          <Box>
            <Text color={color} dimColor>{'  ▌ '}</Text>
            <Text>{entry.text}</Text>
          </Box>
        );
      }
      case 'report-end': {
        const color = entry.verified ? 'green' : 'yellow';
        const label = entry.verified ? '' : 'unverified';
        return label === '' ? <Text> </Text> : (
          <Box>
            <Text color={color} dimColor>{'  ▌ '}</Text>
            <Text color={color} dimColor>{label}</Text>
          </Box>
        );
      }
      default:
        return <Text> </Text>;
    }
  })();
  if (entry.kind === 'user' && !isFirstAfterPrompt) {
    return (
      <Box flexDirection="column">
        <Text dimColor>──────────────────────────────────────────────────</Text>
        {Inner}
      </Box>
    );
  }
  return Inner;
}

function maybeTrackCost(event: AgentEvent, dispatch: React.Dispatch<Action>): void {
  if (event.type === 'plan-ready' || event.type === 'synthesize-ready') {
    if (event.costUsdDelta > 0) dispatch({ type: 'inc-cost', usd: event.costUsdDelta });
  }
}

function parseApprovalInput(text: string, total: number): ProposalDecision {
  const t = text.trim().toLowerCase();
  if (t === '' || t === 'n' || t === 'no' || t === 'skip') {
    return { acceptedIndices: [], stop: false };
  }
  if (t === 'q' || t === 'quit' || t === 'stop') {
    return { acceptedIndices: [], stop: true };
  }
  if (t === 'y' || t === 'yes' || t === 'a' || t === 'all') {
    return { acceptedIndices: Array.from({ length: total }, (_, i) => i), stop: false };
  }
  // numeric pick list: "1", "1,3", "2 3"
  const picks = t
    .split(/[\s,]+/)
    .filter((p) => p !== '')
    .map((p) => Number(p))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= total)
    .map((n) => n - 1);
  return { acceptedIndices: Array.from(new Set(picks)), stop: false };
}
