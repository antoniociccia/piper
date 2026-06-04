import type { CostTracker } from '../models/cost.ts';
import type { ModelClient } from '../models/types.ts';
import type { Executor } from '../exec/executor.ts';
import type { SessionId } from '../memory/types.ts';

import { gatherNode } from './gather.ts';
import { synthesizeNodeStream } from './synthesize.ts';
import type { AgentEvent, EvidenceRef, Plan, PlanStep } from './types.ts';
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
  readonly perStepTimeoutMs?: number;
  readonly maxSynthesizeRetries?: number;
  readonly signal?: AbortSignal;
}

export async function* runAnalyze(
  input: AnalyzeInput,
  deps: AnalyzeDeps,
): AsyncGenerator<AgentEvent> {
  const maxRetries = deps.maxSynthesizeRetries ?? 1;

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

  const evidence: readonly EvidenceRef[] = gathered.evidence;
  if (evidence.length === 0) {
    yield { type: 'aborted', reason: 'analyze: discovery produced no evidence (host unreachable?)' };
    yield {
      type: 'done',
      result: {
        userRequest: input.userRequest,
        sessionId: input.sessionId,
        plan,
        evidence: [],
        failures: gathered.failures,
        costUsd: 0,
        aborted: true,
        abortReason: 'analyze: discovery produced no evidence',
      },
    };
    return;
  }

  // SYNTHESIZE → VERIFY (single round, verify-then-retry like the runner)
  let lastReport = '';
  let verification = { ok: false, issues: ['not synthesized yet'] as readonly string[] };
  let costUsd = 0;
  let attempts = 0;
  let previousIssues: readonly string[] | undefined;

  while (attempts <= maxRetries) {
    yield { type: 'synthesize-started' };
    const gen = synthesizeNodeStream(
      {
        userRequest: input.userRequest,
        sessionId: input.sessionId,
        evidence,
        ...(previousIssues === undefined ? {} : { previousAttemptIssues: previousIssues }),
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

  yield {
    type: 'done',
    result: {
      userRequest: input.userRequest,
      sessionId: input.sessionId,
      plan,
      evidence,
      failures: gathered.failures,
      reportMarkdown: lastReport,
      verification,
      costUsd,
      aborted: false,
    },
  };
}
