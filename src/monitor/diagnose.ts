import type { AgentEvent } from '../agent/types.ts';

import type { DiagnosisOutcome } from './scheduler.ts';
import type { CheckOutcome, WatchPlan } from './types.ts';

export interface DiagnoserDeps {
  /**
   * Starts a diagnostic run for the given prompt and returns its event
   * stream. The TUI wires this to AgentRunner.run({ userRequest, sessionId }).
   * Injected as a function so this module never owns runner construction.
   */
  readonly runDiagnostic: (prompt: string) => AsyncIterable<AgentEvent>;
  /**
   * Budget guard — wired to CostTracker by the caller (e.g. checking whether
   * maxSessionCostUsd is null or sessionTotal < max). False = skip diagnosis,
   * keep checks running.
   */
  readonly isAffordable: () => boolean;
}

export type WatchDiagnoser = (plan: WatchPlan, outcome: CheckOutcome) => Promise<DiagnosisOutcome>;

/**
 * Builds the diagnostic prompt that is injected into the agent runner on anomaly.
 *
 * Why embed the runbook here: the agent runner's system prompt has generic
 * infrastructure knowledge; the runbook is plan-specific context the plan
 * author wrote precisely for this scenario.
 *
 * Why mention approval: the runner may propose mutate-tier actions as follow-ups.
 * Telling it those are gated prevents it from hedging ("I would suggest but cannot
 * act") and encourages concrete proposals.
 *
 * Prompt-injection note: outcome.detail and plan.runbook are user/remote-controlled
 * text embedded verbatim. This is acceptable because the runner is bounded by the
 * deterministic gate — it can only call catalog actions, and any mutation it proposes
 * requires explicit human approval. A hostile runbook can craft words, not execution paths.
 */
export function buildDiagnosisPrompt(plan: WatchPlan, outcome: CheckOutcome): string {
  const exitCodeLine =
    outcome.exitCode === null
      ? '- exit code: n/a (command did not run)'
      : `- exit code: ${outcome.exitCode}`;

  return [
    `A watch check just failed on environment "${plan.environment}". Diagnose the root cause.`,
    '',
    '## Failed check',
    `- check: ${outcome.checkName}`,
    `- failure: ${outcome.detail}`,
    exitCodeLine,
    '',
    '## Runbook for this watch plan (context from the plan author)',
    '',
    plan.runbook,
    '',
    '## Instructions',
    'Investigate using read-only actions, find the most likely root cause, and report it.',
    'If you identify a remediation, propose it as a concrete action — it will go through',
    'the normal approval flow before anything is executed.',
  ].join('\n');
}

/**
 * Creates the watch diagnoser function.
 *
 * Invariants:
 * 1. isAffordable() === false → skip immediately with 'budget'; runner is NEVER invoked.
 * 2. Runner emits a 'done' event with a non-empty reportMarkdown → { kind: 'ready' }.
 * 3. Runner aborts / stream throws / stream ends without a report → { kind: 'skipped' }.
 *    The diagnoser NEVER throws — failures become skipped so the watch loop keeps running.
 */
export function createWatchDiagnoser(deps: DiagnoserDeps): WatchDiagnoser {
  return async (plan, outcome) => {
    // Budget guard must run before any runner invocation.
    if (!deps.isAffordable()) {
      return { kind: 'skipped', reason: 'budget' };
    }

    const prompt = buildDiagnosisPrompt(plan, outcome);

    let report: string | undefined;
    try {
      for await (const event of deps.runDiagnostic(prompt)) {
        if (event.type === 'done') {
          // reportMarkdown is optional on AgentResult — only accept a non-empty string.
          const md = event.result.reportMarkdown;
          if (md !== undefined && md !== '') {
            report = md;
          }
          // 'done' is always the final event from the runner; break regardless.
          break;
        }
        // 'aborted' precedes 'done' in normal runner flow, but if the stream ends
        // after an abort without a 'done' event we still fall through to the
        // undefined check below and return skipped correctly.
      }
    } catch {
      // Any thrown error from the stream is caught here; report stays undefined.
      report = undefined;
    }

    if (report === undefined) {
      // Diagnosis failing is non-fatal to the watch loop. Return 'budget' because
      // DiagnosisSkipReason has no 'crashed' variant (deferred schema change per
      // scheduler.ts design comment).
      return { kind: 'skipped', reason: 'budget' };
    }

    return { kind: 'ready', reportMarkdown: report };
  };
}
