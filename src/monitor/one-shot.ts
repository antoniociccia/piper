// src/monitor/one-shot.ts
//
// One-shot check runner: run every check in a plan once, return a numeric exit
// code for CI/cron consumption.
//
// Exit codes:
//   0 — all checks passed
//   1 — at least one expectation-failed, no errors
//   2 — at least one check-error (execution or gate failure)
//   3 — plan not found or invalid (returned by the CLI caller, not this module)
//
// This module never calls process.exit itself — that responsibility lies with
// the CLI branch in src/index.tsx so tests can inspect the return value cleanly.

import type { Catalog } from '../actions/catalog.ts';
import type { Executor } from '../exec/executor.ts';
import type { Logger } from '../logging/logger.ts';
import type { SessionId } from '../memory/types.ts';

import { runCheck } from './check-runner.ts';
import {
  defaultWatchesDir,
  loadPlansFromDir,
  parseWatchPlan,
  validateAgainstCatalog,
} from './plan-loader.ts';
import { instantiateStockPlan, STOCK_PLANS } from './stock.ts';
import type { WatchPlan } from './types.ts';
import { InvalidWatchPlanError } from './types.ts';

export interface OneShotDeps {
  readonly catalog: Catalog;
  readonly executor: Executor;
  readonly sessionId: SessionId;
  readonly logger: Logger;
  readonly environmentName?: string;
}

/**
 * Resolve a plan by name. Stock plans take priority over user plans.
 * Stock plans require an environmentName (they contain __ENV__ placeholders);
 * without one, the function returns null rather than producing a plan with
 * a literal "__ENV__" environment name.
 *
 * Returns null if:
 * - the plan name is not recognised (stock or user)
 * - it is a stock plan and no environmentName is provided
 * - the plan is invalid (parse or catalog-validation failure)
 */
export async function resolvePlanByName(
  name: string,
  deps: OneShotDeps,
): Promise<WatchPlan | null> {
  const stock = STOCK_PLANS.find((p) => p.name === name);
  if (stock !== undefined) {
    if (deps.environmentName === undefined) return null;
    try {
      const instantiated = instantiateStockPlan(stock.text, deps.environmentName);
      const plan = parseWatchPlan(instantiated, 'stock');
      validateAgainstCatalog(plan, deps.catalog);
      return plan;
    } catch (err) {
      if (err instanceof InvalidWatchPlanError) return null;
      throw err;
    }
  }

  const { plans } = await loadPlansFromDir(defaultWatchesDir(), deps.catalog);
  return plans.find((entry) => entry.plan.name === name)?.plan ?? null;
}

/**
 * Run every check in a plan exactly once and return the worst exit code seen:
 *   0 — all pass
 *   1 — at least one expectation-failed
 *   2 — at least one check-error
 */
export async function runOneShotCheck(plan: WatchPlan, deps: OneShotDeps): Promise<number> {
  let worst = 0;

  for (const check of plan.checks) {
    const outcome = await runCheck(check, {
      executor: deps.executor,
      catalog: deps.catalog,
      sessionId: deps.sessionId,
      now: () => Date.now(),
    });

    const status =
      outcome.kind === 'pass' ? 'PASS' : outcome.kind === 'expectation-failed' ? 'FAIL' : 'ERROR';
    deps.logger.info(`${status} ${check.name}`, {
      outcome: outcome.kind,
      detail: outcome.detail,
    });

    if (outcome.kind === 'expectation-failed') worst = Math.max(worst, 1);
    if (outcome.kind === 'check-error') worst = Math.max(worst, 2);
  }

  return worst;
}
