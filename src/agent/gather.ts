import type { Executor } from '../exec/executor.ts';
import { ExecError } from '../exec/types.ts';
import type { SessionId } from '../memory/types.ts';

import type { EvidenceRef, Plan, PlanStep, StepFailure } from './types.ts';

export interface GatherNodeInput {
  readonly plan: Plan;
  readonly sessionId: SessionId;
  readonly timeoutMs?: number;
}

export interface GatherNodeDeps {
  readonly executor: Executor;
}

export interface GatherNodeOutput {
  readonly evidence: readonly EvidenceRef[];
  readonly failures: readonly StepFailure[];
}

export type StepEvent =
  | { readonly type: 'started'; readonly step: PlanStep }
  | { readonly type: 'done'; readonly step: PlanStep; readonly evidence: EvidenceRef }
  | { readonly type: 'failed'; readonly step: PlanStep; readonly failure: StepFailure };

export async function gatherNode(
  input: GatherNodeInput,
  deps: GatherNodeDeps,
  onStep?: (event: StepEvent) => void,
): Promise<GatherNodeOutput> {
  const evidence: EvidenceRef[] = [];
  const failures: StepFailure[] = [];

  const results = await Promise.all(
    input.plan.steps.map(async (step, index) => {
      onStep?.({ type: 'started', step });
      try {
        const result = await deps.executor.exec(step.actionName, step.args, {
          sessionId: input.sessionId,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        });
        const ref: EvidenceRef = {
          id: `ev-${index + 1}`,
          auditId: result.auditId,
          evidenceId: result.evidenceId,
          actionName: step.actionName,
          args: step.args,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        };
        onStep?.({ type: 'done', step, evidence: ref });
        return { kind: 'ok' as const, ref };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failure: StepFailure = {
          stepId: step.id,
          actionName: step.actionName,
          reason: message,
          ...(err instanceof ExecError && err.auditId !== undefined ? { auditId: err.auditId } : {}),
        };
        onStep?.({ type: 'failed', step, failure });
        return { kind: 'err' as const, failure };
      }
    }),
  );

  for (const r of results) {
    if (r.kind === 'ok') evidence.push(r.ref);
    else failures.push(r.failure);
  }

  return { evidence, failures };
}
