import type { Catalog } from '../actions/catalog.ts';
import type { CostTracker } from '../models/cost.ts';
import type { ModelClient } from '../models/types.ts';
import type { Executor } from '../exec/executor.ts';
import type { EnvironmentRegistry } from '../environments/registry.ts';
import type { SessionId } from '../memory/types.ts';

import { gatherNode } from './gather.ts';
import { proposeFollowups, synthesizeNodeStream } from './synthesize.ts';
import type {
  AgentEvent,
  EvidenceRef,
  Plan,
  PlanStep,
  ProposalDecision,
  ProposedStep,
} from './types.ts';
import { verifyReport } from './verify.ts';

interface StepSpec {
  readonly action: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly description: string;
}

/** The deterministic, skill-independent discovery sweep. Same actions, same
 *  order, every run — this is the reproducible "first step". */
export function buildDiscoveryPlan(environment: string): Plan {
  const env = { environment };
  const specs: readonly StepSpec[] = [
    { action: 'system.os_info', args: env, description: 'OS / kernel' },
    { action: 'system.cpu_info', args: env, description: 'CPU' },
    { action: 'system.memory', args: env, description: 'memory + swap' },
    { action: 'system.disk_usage', args: env, description: 'disk usage' },
    { action: 'system.uptime', args: env, description: 'uptime + load' },
    { action: 'system.process_list', args: { ...env, limit: 15 }, description: 'top processes' },
    { action: 'network.connections', args: { ...env, listening_only: true }, description: 'open ports' },
    { action: 'docker.ps', args: { ...env, all: true }, description: 'containers (incl. stopped)' },
    { action: 'docker.compose_ls', args: { ...env, all: true }, description: 'compose projects' },
    { action: 'discover.compose_files', args: env, description: 'compose files on disk' },
    { action: 'kubectl.context_current', args: env, description: 'kubernetes context' },
    { action: 'system.systemctl_list', args: { ...env, state: 'active' }, description: 'active services' },
  ];

  const steps: PlanStep[] = specs.map((s, i) => ({
    id: `discover-${i + 1}`,
    actionName: s.action,
    args: s.args,
    description: s.description,
  }));

  return {
    steps,
    parallelismHint: { fanout: steps.length, reasoning: 'deterministic baseline discovery sweep' },
    rationale: `baseline analyze discovery of ${environment}`,
  };
}

export interface AnalyzeInput {
  readonly userRequest: string;
  readonly sessionId: SessionId;
  readonly environment: string;
}

export interface AnalyzeDeps {
  readonly executor: Executor;
  readonly client: ModelClient;
  readonly costTracker: CostTracker;
  readonly catalog: Catalog;
  readonly registry: EnvironmentRegistry;
  readonly approveProposals?: (
    proposals: readonly ProposedStep[],
    iteration: number,
  ) => Promise<ProposalDecision>;
  readonly maxFollowupIterations?: number;
  readonly perStepTimeoutMs?: number;
  readonly maxSynthesizeRetries?: number;
  readonly signal?: AbortSignal;
}

export async function* runAnalyze(
  input: AnalyzeInput,
  deps: AnalyzeDeps,
): AsyncGenerator<AgentEvent> {
  const maxRetries = deps.maxSynthesizeRetries ?? 1;
  const maxFollowupIterations = deps.maxFollowupIterations ?? 1;

  yield { type: 'session-started', sessionId: input.sessionId };

  // PLAN (deterministic — no LLM)
  const plan = buildDiscoveryPlan(input.environment);
  yield { type: 'plan-started' };
  yield { type: 'plan-ready', plan, costUsdDelta: 0 };

  // GATHER
  const gathered = await gatherNode(
    {
      plan,
      sessionId: input.sessionId,
      ...(deps.perStepTimeoutMs === undefined ? {} : { timeoutMs: deps.perStepTimeoutMs }),
    },
    { executor: deps.executor },
  );
  for (const step of plan.steps) {
    yield { type: 'gather-step-started', step };
    const ok = gathered.evidence.find(
      (e) => e.actionName === step.actionName && JSON.stringify(e.args) === JSON.stringify(step.args),
    );
    if (ok !== undefined) {
      yield { type: 'gather-step-done', step, evidence: ok };
    } else {
      const fail = gathered.failures.find((f) => f.stepId === step.id);
      if (fail !== undefined) yield { type: 'gather-step-failed', step, failure: fail };
    }
  }

  // Mutable so follow-up evidence can be appended.
  const evidence: EvidenceRef[] = [...gathered.evidence];
  const failures = [...gathered.failures];

  if (evidence.length === 0) {
    yield { type: 'aborted', reason: 'analyze: discovery produced no evidence (host unreachable?)' };
    yield {
      type: 'done',
      result: {
        userRequest: input.userRequest,
        sessionId: input.sessionId,
        plan,
        evidence: [],
        failures,
        costUsd: 0,
        aborted: true,
        abortReason: 'analyze: discovery produced no evidence',
      },
    };
    return;
  }

  // SYNTHESIZE → VERIFY (baseline round, then optional follow-up rounds)
  let lastReport = '';
  let verification = { ok: false, issues: ['not synthesized yet'] as readonly string[] };
  let costUsd = 0;
  let followupIteration = 0;

  while (true) {
    // ── STAGE 1: report — streamed, NO tools, verify-then-retry ─────────────
    let attempts = 0;
    let previousIssues: readonly string[] | undefined;
    // Incremental mode: only on the FIRST attempt of a follow-up iteration.
    const isIncremental = followupIteration > 0 && lastReport !== '';

    while (attempts <= maxRetries) {
      yield { type: 'synthesize-started' };
      const gen = synthesizeNodeStream(
        {
          userRequest: input.userRequest,
          sessionId: input.sessionId,
          evidence,
          ...(previousIssues === undefined ? {} : { previousAttemptIssues: previousIssues }),
          ...(isIncremental && attempts === 0 ? { previousReport: lastReport } : {}),
        },
        { client: deps.client, costTracker: deps.costTracker },
      );
      let out: { reportMarkdown: string; costUsd: number } | undefined;
      while (true) {
        const next = await gen.next();
        if (next.done) {
          out = next.value;
          break;
        }
        yield { type: 'synthesize-chunk', delta: next.value.delta };
      }
      if (out === undefined) break;
      costUsd += out.costUsd;
      lastReport = out.reportMarkdown;
      yield { type: 'synthesize-ready', reportMarkdown: out.reportMarkdown, costUsdDelta: out.costUsd };

      verification = verifyReport({ markdown: out.reportMarkdown, evidence });
      if (verification.ok) {
        yield { type: 'verify-passed' };
        break;
      }
      attempts += 1;
      const retrying = attempts <= maxRetries;
      yield { type: 'verify-failed', issues: verification.issues, retrying };
      if (!retrying) break;
      previousIssues = verification.issues;
    }

    // ── STAGE 2: proposals — only if report verified, callback wired, budget ─
    const allowProposals =
      deps.approveProposals !== undefined && followupIteration < maxFollowupIterations;

    if (!allowProposals || !verification.ok) break;

    let proposals: readonly ProposedStep[] = [];
    try {
      const envBlock = await deps.registry.describeForLLM();
      const proposalsOut = await proposeFollowups(
        {
          userRequest: input.userRequest,
          sessionId: input.sessionId,
          evidence,
          reportMarkdown: lastReport,
          environmentsBlock: envBlock,
        },
        {
          client: deps.client,
          costTracker: deps.costTracker,
          catalog: deps.catalog,
        },
      );
      costUsd += proposalsOut.costUsd;
      // Filter out proposals already executed in this run.
      proposals = proposalsOut.proposals.filter(
        (p) =>
          !evidence.some(
            (ev) =>
              ev.actionName === p.actionName &&
              JSON.stringify(ev.args) === JSON.stringify(p.args),
          ),
      );
    } catch {
      // proposeFollowups failed — baseline report already stands; exit loop.
      break;
    }

    if (proposals.length === 0) break;

    yield { type: 'proposals-ready', proposals, iteration: followupIteration + 1 };

    let decision: ProposalDecision;
    try {
      decision = await deps.approveProposals(proposals, followupIteration + 1);
    } catch {
      decision = { acceptedIndices: [], stop: true };
    }

    const accepted: PlanStep[] = decision.acceptedIndices
      .map((i) => proposals[i])
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
        sessionId: input.sessionId,
        ...(deps.perStepTimeoutMs === undefined ? {} : { timeoutMs: deps.perStepTimeoutMs }),
      },
      { executor: deps.executor },
    );

    for (const step of followPlan.steps) {
      yield { type: 'gather-step-started', step };
      const ok = extraGather.evidence.find(
        (e) =>
          e.actionName === step.actionName &&
          JSON.stringify(e.args) === JSON.stringify(step.args),
      );
      if (ok !== undefined) {
        // Renumber evidence so its id is unique across the whole run.
        const renumbered: EvidenceRef = { ...ok, id: `ev-${evidence.length + 1}` };
        evidence.push(renumbered);
        yield { type: 'gather-step-done', step, evidence: renumbered };
      } else {
        const fail = extraGather.failures.find((f) => f.stepId === step.id);
        if (fail !== undefined) {
          failures.push(fail);
          yield { type: 'gather-step-failed', step, failure: fail };
        }
      }
    }

    followupIteration += 1;
    // Loop back to synthesize with expanded evidence.
  }

  yield {
    type: 'done',
    result: {
      userRequest: input.userRequest,
      sessionId: input.sessionId,
      plan,
      evidence,
      failures,
      reportMarkdown: lastReport,
      verification,
      costUsd,
      aborted: false,
    },
  };
}
