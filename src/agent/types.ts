import type { AuditLogId, EvidenceId, SessionId } from '../memory/types.ts';

export interface PlanStep {
  readonly id: string;
  readonly actionName: string;
  readonly args: unknown;
  readonly description: string;
}

export interface ProposedStep extends PlanStep {
  readonly rationale: string;
}

export interface ProposalDecision {
  readonly acceptedIndices: readonly number[];
  readonly stop: boolean;
}

export interface ParallelismHint {
  readonly fanout: number;
  readonly reasoning: string;
}

export interface Plan {
  readonly steps: readonly PlanStep[];
  readonly parallelismHint: ParallelismHint;
  readonly rationale: string;
}

export interface EvidenceRef {
  readonly id: string;
  readonly auditId: AuditLogId;
  readonly evidenceId: EvidenceId;
  readonly actionName: string;
  readonly args: unknown;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface StepFailure {
  readonly stepId: string;
  readonly actionName: string;
  readonly reason: string;
  readonly auditId?: AuditLogId;
}

export interface Verification {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export interface AgentResult {
  readonly userRequest: string;
  readonly sessionId: SessionId;
  readonly plan?: Plan;
  readonly evidence: readonly EvidenceRef[];
  readonly failures: readonly StepFailure[];
  readonly reportMarkdown?: string;
  readonly verification?: Verification;
  readonly costUsd: number;
  readonly aborted: boolean;
  readonly abortReason?: string;
}

export type AgentEvent =
  | { readonly type: 'session-started'; readonly sessionId: SessionId }
  | { readonly type: 'plan-started' }
  | { readonly type: 'plan-ready'; readonly plan: Plan; readonly costUsdDelta: number }
  | { readonly type: 'gather-step-started'; readonly step: PlanStep }
  | { readonly type: 'gather-step-done'; readonly step: PlanStep; readonly evidence: EvidenceRef }
  | { readonly type: 'gather-step-failed'; readonly step: PlanStep; readonly failure: StepFailure }
  | { readonly type: 'synthesize-started' }
  | { readonly type: 'synthesize-chunk'; readonly delta: string }
  | { readonly type: 'synthesize-ready'; readonly reportMarkdown: string; readonly costUsdDelta: number }
  | { readonly type: 'verify-failed'; readonly issues: readonly string[]; readonly retrying: boolean }
  | { readonly type: 'verify-passed' }
  | { readonly type: 'proposals-ready'; readonly proposals: readonly ProposedStep[]; readonly iteration: number }
  | { readonly type: 'proposals-declined' }
  | {
      readonly type: 'llm-trace';
      readonly role: 'planner' | 'synthesize' | 'proposer' | 'compactor' | 'title';
      readonly model: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly toolCount: number;
      readonly evidenceCount: number;
      /** Number of prior conversation messages injected as planner context (turns N-1, N-2…). 0 = first turn or history wasn't found. */
      readonly historyMessages: number;
      /** Compact preview of the injected history (per-role, truncated). Empty when historyMessages=0. */
      readonly historyPreview: readonly { role: string; snippet: string }[];
      readonly ragHits: readonly { source: string; similarity: number; headingPath: string }[];
      readonly systemSnippet: string;
      readonly userSnippet: string;
    }
  | {
      readonly type: 'compaction-applied';
      readonly coversUntilId: number;
      readonly summaryLength: number;
      readonly reason: string;
      readonly costUsdDelta: number;
    }
  | { readonly type: 'aborted'; readonly reason: string }
  | { readonly type: 'done'; readonly result: AgentResult };
