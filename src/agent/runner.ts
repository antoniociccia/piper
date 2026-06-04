import type { PGlite } from '@electric-sql/pglite';

import type { Catalog } from '../actions/catalog.ts';
import type { EnvironmentRegistry } from '../environments/registry.ts';
import type { Executor } from '../exec/executor.ts';
import type { Logger } from '../logging/logger.ts';
import type { ChatHistory } from '../memory/chat-history.ts';
import type { SessionId } from '../memory/types.ts';
import type { CostTracker } from '../models/cost.ts';
import type { ModelClient } from '../models/types.ts';
import type { EmbeddingClient } from '../rag/embedding-client.ts';

import { ModelClientError } from '../models/client.ts';

import { maybeCompactHistory, shouldCompact } from './compactor.ts';
import { gatherNode } from './gather.ts';
import { EmptyPlanError, planNode } from './plan.ts';
import { proposeFollowups, synthesizeNodeStream } from './synthesize.ts';
import { countMessagesTokens } from './token-counter.ts';
import type {
  AgentEvent,
  AgentResult,
  EvidenceRef,
  Plan,
  PlanStep,
  ProposalDecision,
  ProposedStep,
  StepFailure,
  Verification,
} from './types.ts';
import { verifyReport } from './verify.ts';

export interface AgentRunnerDeps {
  readonly catalog: Catalog;
  readonly registry: EnvironmentRegistry;
  readonly executor: Executor;
  readonly client: ModelClient;
  readonly costTracker: CostTracker;
  readonly logger?: Logger;
  readonly chatHistory?: ChatHistory;
  readonly historyTurnLimit?: number;
  readonly maxSynthesizeRetries?: number;
  readonly perStepTimeoutMs?: number;
  readonly maxFollowupIterations?: number;
  readonly db?: PGlite;
  readonly embedder?: EmbeddingClient;
  readonly approveProposals?: (
    proposals: readonly ProposedStep[],
    iteration: number,
  ) => Promise<ProposalDecision>;
  /**
   * Optional initial-plan approval (HUMAN mode). Receives the planned steps
   * (as ProposedStep[]) before any gather runs. If undefined, the runner skips
   * the gate (legacy auto-approve behaviour kept for tests).
   */
  readonly approveSteps?: (
    proposals: readonly ProposedStep[],
  ) => Promise<ProposalDecision>;
  /** Fraction of effective context at which we auto-compact before planning (default 0.70). */
  readonly compactionTriggerPct?: number;
  /** Pending regular-message threshold for the secondary compaction trigger (default 12). */
  readonly compactionPendingMessageThreshold?: number;
  /** keep_recent for the compactor (default 6). */
  readonly compactionKeepRecent?: number;
  /** Tokens reserved for the next model response when computing the budget (default 4096). */
  readonly compactionReservedForOutput?: number;
}

export interface RunRequest {
  readonly userRequest: string;
  readonly sessionId: SessionId;
}

export interface AgentRunner {
  run(req: RunRequest): AsyncIterable<AgentEvent>;
}

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  const maxRetries = deps.maxSynthesizeRetries ?? 1;
  const historyLimit = deps.historyTurnLimit ?? 6;
  // Default: ONE follow-up round. The proposer fires only when there's a
  // concrete gap to close (it emits zero tool_calls when the report is already
  // complete), so simple prompts stay 1-prompt-1-answer — but multi-step
  // requests (e.g. "show me the logs" needs discover-then-tail) get the
  // chaining round they require. Set max_followup_iterations: 0 in
  // ~/.piper/credentials.json to disable.
  const maxFollowupIterations = deps.maxFollowupIterations ?? 1;

  async function* run(req: RunRequest): AsyncIterable<AgentEvent> {
    // LLM trace queue — populated by the onTrace callbacks we pass to each
    // node, drained between phases as `llm-trace` AgentEvents. The TUI only
    // renders them when /debug is active.
    const traceQueue: Array<Extract<AgentEvent, { type: 'llm-trace' }>> = [];

    const result: {
      userRequest: string;
      sessionId: SessionId;
      plan?: Plan;
      evidence: EvidenceRef[];
      failures: StepFailure[];
      reportMarkdown?: string;
      verification?: Verification;
      costUsd: number;
      aborted: boolean;
      abortReason?: string;
    } = {
      userRequest: req.userRequest,
      sessionId: req.sessionId,
      evidence: [],
      failures: [],
      costUsd: 0,
      aborted: false,
    };

    yield { type: 'session-started', sessionId: req.sessionId };

    // COMPACT (token-budget aware) — must run BEFORE the planner pulls history
    if (deps.chatHistory !== undefined) {
      try {
        const probe = await deps.chatHistory.forPlanner(req.sessionId, historyLimit);
        const probeMsgs = probe.map((m) => ({ role: m.role, content: m.content }));
        const pending = await deps.chatHistory.pendingForCompaction(
          req.sessionId,
          deps.compactionKeepRecent ?? 6,
        );
        const decision = shouldCompact({
          tokensUsed: countMessagesTokens(probeMsgs),
          modelLimit: deps.client.capabilities.maxContextTokens,
          reservedForOutput: deps.compactionReservedForOutput ?? 4096,
          triggerPct: deps.compactionTriggerPct ?? 0.70,
          pendingMessageCount: pending.length,
          pendingMessageThreshold: deps.compactionPendingMessageThreshold ?? 12,
        });
        if (decision.triggered) {
          const compacted = await maybeCompactHistory({
            sessionId: req.sessionId,
            chatHistory: deps.chatHistory,
            client: deps.client,
            costTracker: deps.costTracker,
            keepRecent: deps.compactionKeepRecent ?? 6,
          });
          if (compacted.compacted && compacted.coversUntilId !== undefined) {
            result.costUsd += compacted.costUsd;
            yield {
              type: 'compaction-applied',
              coversUntilId: compacted.coversUntilId,
              summaryLength: compacted.summaryLength ?? 0,
              reason: decision.reason,
              costUsdDelta: compacted.costUsd,
            };
          }
        }
      } catch (err) {
        deps.logger?.warn('compaction skipped due to error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // PLAN
    yield { type: 'plan-started' };
    let plan: Plan;
    try {
      const previousMessages =
        deps.chatHistory === undefined
          ? undefined
          : await deps.chatHistory.forPlanner(req.sessionId, historyLimit);
      const out = await planNode(
        {
          userRequest: req.userRequest,
          sessionId: req.sessionId,
          ...(previousMessages === undefined ? {} : { previousMessages }),
        },
        {
          client: deps.client,
          costTracker: deps.costTracker,
          catalog: deps.catalog,
          registry: deps.registry,
          ...(deps.db === undefined ? {} : { db: deps.db }),
          ...(deps.embedder === undefined ? {} : { embedder: deps.embedder }),
          onTrace: (t) => {
            traceQueue.push({
              type: 'llm-trace',
              role: 'planner',
              model: t.model,
              inputTokens: t.inputTokens,
              outputTokens: t.outputTokens,
              toolCount: t.toolCount,
              evidenceCount: 0,
              historyMessages: t.historyMessages,
              historyPreview: t.historyPreview,
              ragHits: t.ragHits,
              systemSnippet: t.systemSnippet,
              userSnippet: t.userSnippet,
            });
          },
        },
      );
      plan = out.plan;
      result.plan = plan;
      result.costUsd += out.costUsd;
      while (traceQueue.length > 0) yield traceQueue.shift()!;
      yield { type: 'plan-ready', plan, costUsdDelta: out.costUsd };
    } catch (err) {
      // Special-case: the model decided no tool call was needed and replied
      // with plain text instead (e.g. user wrote "ok" or "thanks"). Surface
      // the reply as a one-shot answer rather than an ABORT screamer.
      if (err instanceof EmptyPlanError) {
        const text = err.assistantContent.trim();
        if (text !== '') {
          yield { type: 'synthesize-started' };
          yield { type: 'synthesize-chunk', delta: text };
          yield { type: 'synthesize-ready', reportMarkdown: text, costUsdDelta: 0 };
          // Skip the verifier — there's no evidence to ground against. Commit
          // the answer directly via verify-failed-non-retrying which routes
          // it through stream-commit in the UI without "unverified" labelling
          // (the App treats it as a chat reply).
          yield { type: 'verify-failed', issues: [], retrying: false };
        }
        yield { type: 'done', result: toResult(result) };
        return;
      }
      const reason = formatError('plan-failed', err);
      result.aborted = true;
      result.abortReason = reason;
      yield { type: 'aborted', reason };
      yield { type: 'done', result: toResult(result) };
      return;
    }

    // STEP APPROVAL (initial plan) — HUMAN mode bridge
    if (deps.approveSteps !== undefined) {
      const proposedFromPlan: readonly ProposedStep[] = plan.steps.map((s) => ({
        id: s.id,
        actionName: s.actionName,
        args: s.args,
        description: s.description,
        rationale: s.description,
      }));
      yield { type: 'proposals-ready', proposals: proposedFromPlan, iteration: 0 };
      let decision: ProposalDecision;
      try {
        decision = await deps.approveSteps(proposedFromPlan);
      } catch (err) {
        const reason = formatError('approval-error', err);
        result.aborted = true;
        result.abortReason = reason;
        yield { type: 'aborted', reason };
        yield { type: 'done', result: toResult(result) };
        return;
      }
      if (decision.stop || decision.acceptedIndices.length === 0) {
        yield { type: 'proposals-declined' };
        result.aborted = true;
        result.abortReason = 'plan declined by user';
        yield { type: 'aborted', reason: 'plan declined by user' };
        yield { type: 'done', result: toResult(result) };
        return;
      }
      // Filter plan steps to only the accepted indices (preserves order)
      const accepted = new Set(decision.acceptedIndices);
      const filteredSteps = plan.steps.filter((_, i) => accepted.has(i));
      if (filteredSteps.length === 0) {
        yield { type: 'proposals-declined' };
        result.aborted = true;
        result.abortReason = 'all plan steps declined';
        yield { type: 'aborted', reason: 'all plan steps declined' };
        yield { type: 'done', result: toResult(result) };
        return;
      }
      plan = { ...plan, steps: filteredSteps };
      result.plan = plan;
    }

    // GATHER
    const gathered = await gatherNode(
      {
        plan,
        sessionId: req.sessionId,
        ...(deps.perStepTimeoutMs === undefined ? {} : { timeoutMs: deps.perStepTimeoutMs }),
      },
      { executor: deps.executor },
    );
    for (const step of plan.steps) {
      yield { type: 'gather-step-started', step };
      const ok = gathered.evidence.find(
        (e) => e.actionName === step.actionName && deepEqual(e.args, step.args),
      );
      if (ok !== undefined) {
        yield { type: 'gather-step-done', step, evidence: ok };
      } else {
        const fail = gathered.failures.find((f) => f.stepId === step.id);
        if (fail !== undefined) yield { type: 'gather-step-failed', step, failure: fail };
      }
    }
    result.evidence = [...gathered.evidence];
    result.failures = [...gathered.failures];

    if (result.evidence.length === 0) {
      // No read evidence to synthesize from. If steps actually FAILED (e.g. a
      // mutation whose verify failed and rolled back), don't abort with a
      // cryptic message — render a grounded failure report so the user sees
      // what was attempted and why it failed. Deterministic, no LLM call.
      if (result.failures.length > 0) {
        const report = formatFailureReport(result.failures);
        result.reportMarkdown = report;
        yield { type: 'synthesize-started' };
        yield { type: 'synthesize-chunk', delta: report };
        yield { type: 'synthesize-ready', reportMarkdown: report, costUsdDelta: 0 };
        yield { type: 'verify-passed' };
        yield { type: 'done', result: toResult(result) };
        return;
      }
      result.aborted = true;
      result.abortReason = 'gather-empty: all plan steps failed; no evidence to synthesize';
      yield { type: 'aborted', reason: result.abortReason };
      yield { type: 'done', result: toResult(result) };
      return;
    }

    // SYNTHESIZE → VERIFY → (optional) PROPOSE → APPROVE → GATHER loop
    let lastReport = '';
    let lastVerification: Verification = { ok: false, issues: ['not synthesized yet'] };
    let followupIteration = 0;

    while (true) {
      const allowProposals =
        deps.approveProposals !== undefined && followupIteration < maxFollowupIterations;

      let attempts = 0;
      let previousIssues: readonly string[] | undefined;
      // Keep the best synth we've seen so far in case the retry comes back worse.
      let bestSoFar: { reportMarkdown: string; issues: readonly string[] } | undefined;

      // STAGE 1: report — streamed, NO tools, verify-then-retry
      while (attempts <= maxRetries) {
        yield { type: 'synthesize-started' };
        let synthOutput: { reportMarkdown: string; costUsd: number } | undefined;
        // Incremental mode: only on the FIRST attempt of a follow-up iteration,
        // not on verify-failed retries (those should be re-fixing the report
        // they just produced, not merging with the previous-iteration report).
        const isIncremental = attempts === 0 && followupIteration > 0 && lastReport !== '';
        try {
          const gen = synthesizeNodeStream(
            {
              userRequest: req.userRequest,
              sessionId: req.sessionId,
              evidence: result.evidence,
              ...(previousIssues === undefined ? {} : { previousAttemptIssues: previousIssues }),
              ...(isIncremental ? { previousReport: lastReport } : {}),
            },
            {
              client: deps.client,
              costTracker: deps.costTracker,
              onTrace: (t) => {
                traceQueue.push({
                  type: 'llm-trace',
                  role: 'synthesize',
                  model: t.model,
                  inputTokens: t.inputTokens,
                  outputTokens: t.outputTokens,
                  toolCount: t.toolCount,
                  evidenceCount: t.evidenceCount,
                  historyMessages: 0,
                  historyPreview: [],
                  ragHits: [],
                  systemSnippet: t.systemSnippet,
                  userSnippet: t.userSnippet,
                });
              },
            },
          );
          while (true) {
            const next = await gen.next();
            if (next.done) {
              synthOutput = next.value;
              break;
            }
            yield { type: 'synthesize-chunk', delta: next.value.delta };
          }
        } catch (err) {
          const reason = formatError('synthesize-failed', err);
          result.aborted = true;
          result.abortReason = reason;
          yield { type: 'aborted', reason };
          yield { type: 'done', result: toResult(result) };
          return;
        }
        if (synthOutput === undefined) {
          result.aborted = true;
          result.abortReason = 'synthesize-failed: generator did not return an output';
          yield { type: 'aborted', reason: result.abortReason };
          yield { type: 'done', result: toResult(result) };
          return;
        }
        result.costUsd += synthOutput.costUsd;
        lastReport = synthOutput.reportMarkdown;
        while (traceQueue.length > 0) yield traceQueue.shift()!;
        yield {
          type: 'synthesize-ready',
          reportMarkdown: synthOutput.reportMarkdown,
          costUsdDelta: synthOutput.costUsd,
        };

        lastVerification = verifyReport({
          markdown: synthOutput.reportMarkdown,
          evidence: result.evidence,
        });

        if (lastVerification.ok) {
          yield { type: 'verify-passed' };
          break;
        }
        // Track the least-broken candidate so we don't expose a worse retry.
        if (
          bestSoFar === undefined ||
          lastVerification.issues.length < bestSoFar.issues.length
        ) {
          bestSoFar = {
            reportMarkdown: synthOutput.reportMarkdown,
            issues: lastVerification.issues,
          };
        }
        attempts += 1;
        const retrying = attempts <= maxRetries;
        yield { type: 'verify-failed', issues: lastVerification.issues, retrying };
        if (!retrying) {
          // Exhausted retries: surface the best candidate, not the last (often worse) one.
          if (bestSoFar !== undefined && bestSoFar.reportMarkdown !== synthOutput.reportMarkdown) {
            lastReport = bestSoFar.reportMarkdown;
            lastVerification = { ok: false, issues: bestSoFar.issues };
          }
          break;
        }
        previousIssues = lastVerification.issues;
      }

      // STAGE 2: proposals — only if report verified AND callback wired AND not over budget
      if (!allowProposals || !lastVerification.ok) break;

      let lastProposals: readonly ProposedStep[] = [];
      try {
        const envBlockForProposer = await deps.registry.describeForLLM();
        const proposalsOut = await proposeFollowups(
          {
            userRequest: req.userRequest,
            sessionId: req.sessionId,
            evidence: result.evidence,
            reportMarkdown: lastReport,
            environmentsBlock: envBlockForProposer,
          },
          {
            client: deps.client,
            costTracker: deps.costTracker,
            catalog: deps.catalog,
            onTrace: (t) => {
              traceQueue.push({
                type: 'llm-trace',
                role: 'proposer',
                model: t.model,
                inputTokens: t.inputTokens,
                outputTokens: t.outputTokens,
                toolCount: t.toolCount,
                evidenceCount: t.evidenceCount,
                historyMessages: 0,
                  historyPreview: [],
                ragHits: [],
                systemSnippet: t.systemSnippet,
                userSnippet: t.userSnippet,
              });
            },
          },
        );
        result.costUsd += proposalsOut.costUsd;
        while (traceQueue.length > 0) yield traceQueue.shift()!;
        // Hard filter: drop any proposal whose (actionName, args) already exists
        // in the accumulated evidence for this turn. Defense in depth — the
        // proposer is also told not to repeat, but the model sometimes does.
        lastProposals = proposalsOut.proposals.filter(
          (p) =>
            !result.evidence.some(
              (ev) => ev.actionName === p.actionName && deepEqual(ev.args, p.args),
            ),
        );
      } catch (err) {
        deps.logger?.warn('proposeFollowups failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (lastProposals.length === 0) break;
      yield {
        type: 'proposals-ready',
        proposals: lastProposals,
        iteration: followupIteration + 1,
      };
      const decide = deps.approveProposals;
      if (decide === undefined) break;
      let decision: ProposalDecision;
      try {
        decision = await decide(lastProposals, followupIteration + 1);
      } catch {
        decision = { acceptedIndices: [], stop: true };
      }
      const accepted: PlanStep[] = decision.acceptedIndices
        .map((i) => lastProposals[i])
        .filter((s): s is ProposedStep => s !== undefined)
        .map((p, i) => ({
          id: `follow-${followupIteration + 1}-${i + 1}`,
          actionName: p.actionName,
          args: p.args,
          description: p.description,
        }));
      if (decision.stop || accepted.length === 0) {
        yield { type: 'proposals-declined' };
        break;
      }
      const followPlan: Plan = {
        steps: accepted,
        parallelismHint: { fanout: accepted.length, reasoning: 'user-approved follow-up' },
        rationale: `user-approved follow-up batch #${followupIteration + 1}`,
      };
      const extraGather = await gatherNode(
        {
          plan: followPlan,
          sessionId: req.sessionId,
          ...(deps.perStepTimeoutMs === undefined ? {} : { timeoutMs: deps.perStepTimeoutMs }),
        },
        { executor: deps.executor },
      );
      for (const step of followPlan.steps) {
        yield { type: 'gather-step-started', step };
        const ok = extraGather.evidence.find(
          (e) => e.actionName === step.actionName && deepEqual(e.args, step.args),
        );
        if (ok !== undefined) {
          // Renumber evidence so its id is unique across the whole session run.
          const renumbered: EvidenceRef = { ...ok, id: `ev-${result.evidence.length + 1}` };
          result.evidence.push(renumbered);
          yield { type: 'gather-step-done', step, evidence: renumbered };
        } else {
          const fail = extraGather.failures.find((f) => f.stepId === step.id);
          if (fail !== undefined) {
            result.failures.push(fail);
            yield { type: 'gather-step-failed', step, failure: fail };
          }
        }
      }
      followupIteration += 1;
      // Loop back to synth with combined evidence
    }

    result.reportMarkdown = lastReport;
    result.verification = lastVerification;

    if (deps.chatHistory !== undefined && lastReport !== '') {
      try {
        await deps.chatHistory.appendAssistant(req.sessionId, lastReport);
      } catch (err) {
        deps.logger?.warn('failed to persist assistant report', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    yield { type: 'done', result: toResult(result) };
  }

  function toResult(s: {
    userRequest: string;
    sessionId: SessionId;
    plan?: Plan;
    evidence: EvidenceRef[];
    failures: StepFailure[];
    reportMarkdown?: string;
    verification?: Verification;
    costUsd: number;
    aborted: boolean;
    abortReason?: string;
  }): AgentResult {
    return {
      userRequest: s.userRequest,
      sessionId: s.sessionId,
      ...(s.plan === undefined ? {} : { plan: s.plan }),
      evidence: s.evidence,
      failures: s.failures,
      ...(s.reportMarkdown === undefined ? {} : { reportMarkdown: s.reportMarkdown }),
      ...(s.verification === undefined ? {} : { verification: s.verification }),
      costUsd: s.costUsd,
      aborted: s.aborted,
      ...(s.abortReason === undefined ? {} : { abortReason: s.abortReason }),
    };
  }

  return { run };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A grounded, deterministic report for when every plan step failed (no read
 * evidence to synthesize). Lists each failure and, for the common
 * privilege/daemon case, adds a concrete next step. No LLM call.
 */
export function formatFailureReport(failures: readonly StepFailure[]): string {
  const lines: string[] = ['The plan could not complete — every step failed.', ''];
  for (const f of failures) {
    lines.push(`- **${f.actionName}** — ${f.reason}`);
  }
  const haystack = failures.map((f) => f.reason).join(' ').toLowerCase();
  if (
    haystack.includes('permission denied') ||
    haystack.includes('daemon socket') ||
    haystack.includes('must be root') ||
    haystack.includes('verify exited')
  ) {
    lines.push('');
    lines.push(
      'This looks like a privilege or daemon-access problem — often the host needs `sudo` for docker. Re-run the request and approve the sudo prompt when it appears.',
    );
  }
  return lines.join('\n');
}

function formatError(prefix: string, err: unknown): string {
  if (err instanceof ModelClientError) {
    const bodySnippet =
      err.body === undefined || err.body === ''
        ? ''
        : ` — body: ${err.body.slice(0, 240)}`;
    return `${prefix}: ${err.message}${bodySnippet}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${message}`;
}
