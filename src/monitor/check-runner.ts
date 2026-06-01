// src/monitor/check-runner.ts
import type { Catalog } from '../actions/catalog.ts';
import type { Executor } from '../exec/executor.ts';
import { ExecError } from '../exec/types.ts';
import type { SessionId } from '../memory/types.ts';

import { evaluateExpectation } from './expectations.ts';
import type { CheckOutcome, WatchCheck } from './types.ts';

export interface CheckRunnerDeps {
  readonly executor: Executor;
  readonly catalog: Catalog;
  readonly sessionId: SessionId;
  readonly now: () => number;
}

/**
 * Run one check through the Executor and evaluate its expectation.
 *
 * Never throws: every failure mode becomes a CheckOutcome so the scheduler
 * loop can keep running other checks. ExecErrors (unknown action, path
 * denied, timeout, etc.) become 'check-error' outcomes. A command that
 * completes but does not satisfy its expectation becomes 'expectation-failed'.
 */
export async function runCheck(check: WatchCheck, deps: CheckRunnerDeps): Promise<CheckOutcome> {
  const executedAtMs = deps.now();

  let stdout: string;
  let stderr: string;
  let exitCode: number;

  try {
    const result = await deps.executor.exec(check.action, check.args, { sessionId: deps.sessionId });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = result.exitCode;
  } catch (err) {
    // ExecError: gate/policy refusals, timeout, unknown action, etc.
    // Any other Error is also caught so the scheduler never sees an exception.
    const detail =
      err instanceof ExecError
        ? `${err.reason}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { checkName: check.name, kind: 'check-error', detail, exitCode: null, executedAtMs };
  }

  // Post-exec phase: catalog.resolve → parseResult → evaluateExpectation.
  // Wrapped in its own try/catch so any unexpected throw (e.g. a patched catalog
  // in tests, a future change to evaluateExpectation) cannot escape runCheck and
  // kill the watch loop. exitCode is preserved: the command did run.
  try {
    // Run the action's parseResult so structured expectations (e.g. all_running)
    // can work with typed data rather than raw text. A throwing parseResult means
    // we pass `undefined` — the expectation degrades gracefully (e.g. to raw
    // stdout matching) rather than turning a good command into a check-error.
    let parsed: unknown;
    const action = deps.catalog.resolve(check.action);
    if (action !== undefined) {
      try {
        parsed = action.parseResult({ stdout, stderr, exitCode }, check.args);
      } catch {
        // parseResult failure is non-fatal; leave parsed undefined
      }
    }

    const evaluation = evaluateExpectation(check.expect, {
      stdout,
      stderr,
      exitCode,
      ...(parsed === undefined ? {} : { parsed }),
    });

    return {
      checkName: check.name,
      kind: evaluation.passed ? 'pass' : 'expectation-failed',
      detail: evaluation.detail,
      exitCode,
      executedAtMs,
    };
  } catch (err) {
    // Unexpected throw in the post-exec phase (catalog proxy, future evaluateExpectation
    // change, etc.). exitCode is preserved: the underlying command did complete.
    const detail = err instanceof Error ? err.message : String(err);
    return { checkName: check.name, kind: 'check-error', detail, exitCode, executedAtMs };
  }
}
