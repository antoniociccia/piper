// src/monitor/plan-loader.ts
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Catalog } from '../actions/catalog.ts';

import {
  InvalidWatchPlanError,
  parseIntervalMs,
  watchFrontmatterSchema,
  type WatchCheck,
  type WatchPlan,
  type WatchPlanSource,
} from './types.ts';

// Default interval when neither a check-level `every` nor a plan-level default is provided.
const FALLBACK_INTERVAL = '60s';

/**
 * Recursively freezes an object and all nested objects it owns.
 * Prevents TOCTOU mutation of check args after validation. The gate guarantee
 * is completed by the Executor's re-validation at execution time (CLAUDE.md guardrail #9).
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

export interface SplitResult {
  readonly frontmatterRaw: string;
  readonly body: string;
}

export function splitFrontmatter(text: string): SplitResult {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new InvalidWatchPlanError('plan file must start with a "---" frontmatter block');
  }
  const closing = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (closing === -1) {
    throw new InvalidWatchPlanError('frontmatter block is not closed (missing second "---")');
  }
  return {
    frontmatterRaw: lines.slice(1, closing).join('\n'),
    body: lines.slice(closing + 1).join('\n').trim(),
  };
}

export function parseWatchPlan(text: string, source: WatchPlanSource): WatchPlan {
  const { frontmatterRaw, body } = splitFrontmatter(text);

  let rawYaml: unknown;
  try {
    rawYaml = Bun.YAML.parse(frontmatterRaw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidWatchPlanError(`frontmatter is not valid YAML: ${msg}`);
  }

  const parsed = watchFrontmatterSchema.safeParse(rawYaml);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new InvalidWatchPlanError(`invalid plan frontmatter: ${issues}`);
  }
  const fm = parsed.data;

  const defaultEvery = fm.defaults?.every ?? FALLBACK_INTERVAL;
  const usedNames = new Map<string, number>();

  const checks: WatchCheck[] = fm.checks.map((c) => {
    const baseName = c.name ?? c.action;
    const seen = usedNames.get(baseName) ?? 0;
    usedNames.set(baseName, seen + 1);
    // First occurrence keeps the bare name; subsequent ones get a -N suffix (1-based, starting at 2).
    const name = seen === 0 ? baseName : `${baseName}-${seen + 1}`;
    return {
      name,
      action: c.action,
      // deepFreeze ensures nested objects are also immutable — shallow Object.freeze
      // would leave inner objects mutable (TOCTOU surface). The gate guarantee is
      // completed by the Executor's re-validation at execution time (CLAUDE.md guardrail #9).
      args: deepFreeze({ ...(c.args ?? {}) }),
      expect: c.expect,
      intervalMs: parseIntervalMs(c.every ?? defaultEvery),
    };
  });

  return {
    name: fm.name,
    description: fm.description,
    environment: fm.environment,
    checks,
    runbook: body,
    source,
  };
}

/**
 * GATE: a plan may only reference catalog actions of tier `read`, and every
 * check's args must satisfy that action's own zod schema.
 *
 * Throws InvalidWatchPlanError on the first violation. This is a deterministic
 * gate — the LLM cannot author a watch plan that runs mutate or destructive
 * actions without this check catching it.
 */
export function validateAgainstCatalog(plan: WatchPlan, catalog: Catalog): void {
  for (const check of plan.checks) {
    const action = catalog.resolve(check.action);
    if (action === undefined) {
      throw new InvalidWatchPlanError(
        `check "${check.name}": action "${check.action}" is not in catalog`,
      );
    }
    if (action.tier !== 'read') {
      throw new InvalidWatchPlanError(
        `check "${check.name}": action "${check.action}" is ${action.tier}-tier — watch plans may only use read-tier actions`,
      );
    }
    const argsResult = action.argsSchema.safeParse(check.args);
    if (!argsResult.success) {
      const issues = argsResult.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new InvalidWatchPlanError(
        `check "${check.name}": invalid args for "${check.action}": ${issues}`,
      );
    }
  }
}

/**
 * Serialize a plan back to a .md file. The frontmatter is emitted as JSON —
 * JSON is a strict subset of YAML, so Bun.YAML.parse round-trips it without
 * requiring a YAML stringifier dependency.
 */
export function serializeWatchPlan(plan: WatchPlan): string {
  const frontmatter = {
    name: plan.name,
    description: plan.description,
    environment: plan.environment,
    checks: plan.checks.map((c) => ({
      name: c.name,
      action: c.action,
      args: c.args,
      expect: c.expect,
      every: `${Math.round(c.intervalMs / 1000)}s`,
    })),
  };
  return ['---', JSON.stringify(frontmatter, null, 2), '---', '', plan.runbook, ''].join('\n');
}

// ── Directory loading ────────────────────────────────────────────────────────

export interface LoadedPlanEntry {
  readonly plan: WatchPlan;
  readonly path: string;
}

export interface PlanLoadFailure {
  readonly path: string;
  readonly message: string;
}

export interface LoadPlansResult {
  readonly plans: readonly LoadedPlanEntry[];
  readonly failures: readonly PlanLoadFailure[];
}

/**
 * Load and validate every *.md plan in a directory. Invalid files are
 * accumulated in `failures` and never thrown — a single bad plan must not
 * prevent valid plans from loading.
 *
 * A missing directory is treated as "no user plans yet", not an error.
 */
export async function loadPlansFromDir(
  dir: string,
  catalog: Catalog,
): Promise<LoadPlansResult> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Missing or inaccessible directory — not an error, just no plans.
    return { plans: [], failures: [] };
  }

  const plans: LoadedPlanEntry[] = [];
  const failures: PlanLoadFailure[] = [];

  for (const entry of entries.filter((e) => e.endsWith('.md')).sort()) {
    const path = join(dir, entry);
    try {
      const text = await Bun.file(path).text();
      const plan = parseWatchPlan(text, 'user');
      validateAgainstCatalog(plan, catalog);
      plans.push({ plan, path });
    } catch (err) {
      failures.push({
        path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { plans, failures };
}

export function defaultWatchesDir(): string {
  return join(homedir(), '.piper', 'watches');
}
