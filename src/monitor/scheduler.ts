import type { SessionId } from '../memory/types.ts';

import type { AnomalyPolicy } from './anomaly-policy.ts';
import type {
  CheckOutcome,
  DiagnosisSkipReason,
  WatchCheck,
  WatchEvent,
  WatchPlan,
} from './types.ts';
import type { WatchStore } from './watch-store.ts';

// Exponential backoff for check-errors: doubles per consecutive error, capped at 5 min.
const ERROR_BACKOFF_CAP_MS = 5 * 60_000;

/** Returns true when the signal is both present and already aborted. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

export type DiagnosisOutcome =
  | { readonly kind: 'ready'; readonly reportMarkdown: string }
  | { readonly kind: 'skipped'; readonly reason: DiagnosisSkipReason };

export interface SchedulerDeps {
  /** Runs one check (Task 4's runCheck, partially applied). Injected for testability. */
  readonly runCheck: (check: WatchCheck) => Promise<CheckOutcome>;
  readonly policy: AnomalyPolicy;
  readonly store: WatchStore;
  readonly sessionId: SessionId;
  readonly now: () => number;
  /**
   * Pause the loop for `ms` milliseconds.
   * SHOULD resolve early when `signal` fires (race setTimeout vs abort event).
   * Test fakes may ignore the second param — the loop re-checks the signal after
   * every sleep call regardless.
   */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  /** Notification dispatch (Task 7). Failures must not stop the loop. */
  readonly notify?: (checkName: string, plan: WatchPlan, outcome: CheckOutcome) => Promise<void>;
  /** Anomaly diagnoser (Task 10). Undefined = diagnosis-skipped(no-diagnoser). */
  readonly diagnose?: (plan: WatchPlan, outcome: CheckOutcome) => Promise<DiagnosisOutcome>;
}

interface CheckSchedule {
  readonly check: WatchCheck;
  nextDueMs: number;
  consecutiveErrors: number;
}

function effectiveIntervalMs(schedule: CheckSchedule): number {
  if (schedule.consecutiveErrors === 0) return schedule.check.intervalMs;
  // 2^consecutiveErrors multiplier, capped at ERROR_BACKOFF_CAP_MS (but never
  // below the check's own intervalMs — the cap applies on top of the base).
  const backoff = schedule.check.intervalMs * 2 ** schedule.consecutiveErrors;
  return Math.min(backoff, Math.max(schedule.check.intervalMs, ERROR_BACKOFF_CAP_MS));
}

/**
 * The watch loop. TUI-agnostic, daemon-ready: all I/O goes through injected
 * deps, every event is persisted before being yielded, and the loop stops
 * cleanly on AbortSignal.
 *
 * Design invariants:
 *  - Persist BEFORE yield (daemon-ready: state survives host restart).
 *  - runCheck() is defensive — if it throws anyway, we catch and convert.
 *  - store.recordCheckResult() failure is non-fatal (outcome still yielded + policy runs).
 *  - store.recordAnomaly() failure is non-fatal: anomaly event is still yielded with
 *    anomalyId -1 (sentinel: "persistence failed, anomaly was still notified/diagnosed").
 *  - store.updateAnomalyDiagnosis() failure is swallowed: the diagnosis event is still
 *    yielded; the DB row stays 'pending'.
 *  - notify() failure emits notify-failed, never stops the loop.
 *  - diagnose() failure falls back to diagnosis-skipped(budget).
 *    NOTE: a crashed diagnoser is reported as budget-skip because DiagnosisSkipReason
 *    has no 'crashed' variant; distinguishing it would require a type/schema change — deferred.
 *  - sleep() receives the AbortSignal so signal-aware implementations can exit early.
 *    The loop re-checks the signal after every sleep regardless.
 *  - stopReason tracks why the loop exits so finishRun() records the accurate cause.
 *    On consumer-driven shutdown (gen.return()), finishRun() still runs in finally
 *    but the final yield is never reached — that is expected (the consumer went away).
 *  - finishRun() itself is wrapped in try/catch so a DB error on shutdown never escapes.
 */
export async function* runWatch(plan: WatchPlan, deps: SchedulerDeps): AsyncGenerator<WatchEvent> {
  if (plan.checks.length === 0) {
    throw new Error(`runWatch: plan "${plan.name}" has no checks — nothing to monitor`);
  }

  const runId = await deps.store.createRun(deps.sessionId, plan.name, plan.environment);
  yield { type: 'watch-started', planName: plan.name, runId };

  // Every check starts as due immediately.
  const schedules: CheckSchedule[] = plan.checks.map((check) => ({
    check,
    nextDueMs: deps.now(),
    consecutiveErrors: 0,
  }));

  // Tracks why the loop exited so finishRun() records the accurate reason.
  // 'consumer-closed' is the default: if the consumer breaks out of for-await
  // (gen.return() is called), we never reach the abort-path assignment below.
  let stopReason = 'consumer-closed';

  try {
    while (deps.signal?.aborted !== true) {
      const currentMs = deps.now();
      const due = schedules.filter((s) => s.nextDueMs <= currentMs);

      for (const schedule of due) {
        if (isAborted(deps.signal)) break;

        // Defensive wrapper: runCheck contract says it never throws, but we
        // guard against future changes or test doubles that do.
        let outcome: CheckOutcome;
        try {
          outcome = await deps.runCheck(schedule.check);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          outcome = {
            checkName: schedule.check.name,
            kind: 'check-error',
            detail,
            exitCode: null,
            executedAtMs: deps.now(),
          };
        }

        // Persist the result — if the store fails, yield the outcome anyway
        // (the user can still see it in the TUI). The policy still runs on the
        // local outcome so in-memory state stays consistent.
        try {
          await deps.store.recordCheckResult(runId, outcome);
        } catch {
          // Storage hiccup — non-fatal.
        }

        yield { type: 'check-result', outcome };

        // Backoff bookkeeping: check-error stretches the interval; any other
        // kind resets the consecutive-error counter.
        // I3 cadence floor: nextDue is relative to MAX(now, executedAt) so a
        // slow check (took > interval) waits a full interval after it FINISHES
        // rather than being immediately due again.
        schedule.consecutiveErrors =
          outcome.kind === 'check-error' ? schedule.consecutiveErrors + 1 : 0;
        schedule.nextDueMs =
          Math.max(deps.now(), outcome.executedAtMs) + effectiveIntervalMs(schedule);

        // Policy must observe every outcome (including passes — they reset streaks).
        const decision = deps.policy.observe(outcome);

        // M2: control-flow narrowing instead of a cast.
        // Pass outcomes never fire anomalies; a non-fire decision means debounce hasn't
        // triggered yet. Both continue here so TypeScript narrows outcome.kind below.
        if (outcome.kind === 'pass' || decision.kind !== 'fire') continue;

        // At this point outcome.kind is narrowed to 'expectation-failed' | 'check-error'.

        // C1: recordAnomaly failure is non-fatal. Sentinel -1 means "persistence failed;
        // anomaly was still notified and diagnosed from in-memory state."
        let anomalyId: number;
        try {
          anomalyId = await deps.store.recordAnomaly(runId, outcome.checkName, outcome.kind);
        } catch {
          anomalyId = -1; // persistence failed — anomaly still proceeds in-memory
        }

        yield {
          type: 'anomaly',
          checkName: outcome.checkName,
          outcomeKind: outcome.kind,
          consecutiveFailures: decision.consecutiveFailures,
          atMs: outcome.executedAtMs,
          anomalyId,
        };

        // Notify — never let a notification failure stop the loop.
        if (deps.notify !== undefined) {
          try {
            await deps.notify(outcome.checkName, plan, outcome);
          } catch (err) {
            yield {
              type: 'notify-failed',
              channel: 'notifier',
              message: err instanceof Error ? err.message : String(err),
            };
          }
        }

        // Diagnose.
        if (deps.diagnose === undefined) {
          // C1: updateAnomalyDiagnosis failure is swallowed; event is still yielded.
          try {
            await deps.store.updateAnomalyDiagnosis(anomalyId, { status: 'skipped-no-diagnoser' });
          } catch {
            // DB row stays 'pending' — event still yields below.
          }
          yield { type: 'diagnosis-skipped', checkName: outcome.checkName, reason: 'no-diagnoser' };
          continue;
        }

        yield { type: 'diagnosis-started', checkName: outcome.checkName };

        let diagnosis: DiagnosisOutcome;
        try {
          diagnosis = await deps.diagnose(plan, outcome);
        } catch {
          // diagnose() threw unexpectedly. Reported as budget-skip because
          // DiagnosisSkipReason has no 'crashed' variant — deferred type change.
          // C1: updateAnomalyDiagnosis failure swallowed.
          try {
            await deps.store.updateAnomalyDiagnosis(anomalyId, { status: 'skipped-budget' });
          } catch {
            // DB row stays 'pending' — event still yields below.
          }
          yield { type: 'diagnosis-skipped', checkName: outcome.checkName, reason: 'budget' };
          continue;
        }

        if (diagnosis.kind === 'ready') {
          // C1: updateAnomalyDiagnosis failure swallowed; event still yields.
          try {
            await deps.store.updateAnomalyDiagnosis(anomalyId, {
              status: 'ready',
              reportMarkdown: diagnosis.reportMarkdown,
            });
          } catch {
            // DB row stays 'pending' — event still yields below.
          }
          yield {
            type: 'diagnosis-ready',
            checkName: outcome.checkName,
            reportMarkdown: diagnosis.reportMarkdown,
          };
        } else {
          const status =
            diagnosis.reason === 'budget'
              ? 'skipped-budget'
              : diagnosis.reason === 'cooldown'
                ? 'skipped-cooldown'
                : 'skipped-no-diagnoser';
          // C1: updateAnomalyDiagnosis failure swallowed; event still yields.
          try {
            await deps.store.updateAnomalyDiagnosis(anomalyId, { status });
          } catch {
            // DB row stays 'pending' — event still yields below.
          }
          yield {
            type: 'diagnosis-skipped',
            checkName: outcome.checkName,
            reason: diagnosis.reason,
          };
        }
      }

      if (isAborted(deps.signal)) break;

      // I1: Sleep until the earliest next-due check; pass the signal so a
      // signal-aware sleep impl can resolve early on abort. The loop re-checks
      // the signal after sleep regardless.
      const nextDueMs = schedules.reduce(
        (min, s) => (s.nextDueMs < min ? s.nextDueMs : min),
        schedules[0]!.nextDueMs,
      );
      const sleepMs = Math.max(0, nextDueMs - deps.now());
      if (sleepMs > 0) await deps.sleep(sleepMs, deps.signal);
    }

    // Normal exit via abort signal.
    stopReason = 'aborted';
  } finally {
    // I2 + M4: finishRun is wrapped so a DB error on shutdown never escapes the
    // generator. The accurate stopReason is used ('consumer-closed' when the
    // consumer broke out of for-await, 'aborted' on signal).
    try {
      await deps.store.finishRun(runId, stopReason);
    } catch {
      // Shutdown DB error — swallowed. The run may stay 'running' in the DB.
    }
  }

  // I2: This yield is only reached on the abort path (stopReason === 'aborted').
  // On consumer-driven shutdown (gen.return()), the consumer is gone — nobody
  // would receive this event, and generators do not yield after return().
  yield { type: 'watch-stopped', reason: 'aborted' };
}
