// src/monitor/types.ts
import { z } from 'zod';

// ── Errors ────────────────────────────────────────────────────────────────

export class InvalidWatchPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWatchPlanError';
  }
}

// ── Intervals ─────────────────────────────────────────────────────────────
// "30s" / "5m" / "1h". Floor of 10s prevents accidental hammering.

export const MIN_INTERVAL_MS = 10_000;

const INTERVAL_PATTERN = /^(\d+)(s|m|h)$/;

export function parseIntervalMs(text: string): number {
  const m = INTERVAL_PATTERN.exec(text);
  if (m === null) {
    throw new InvalidWatchPlanError(`invalid interval: "${text}" (expected e.g. "30s", "5m", "1h")`);
  }
  const value = Number(m[1]);
  const unit = m[2];
  const mult = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
  const ms = value * mult;
  if (ms < MIN_INTERVAL_MS) {
    throw new InvalidWatchPlanError(`interval "${text}" is below the ${MIN_INTERVAL_MS / 1000}s floor`);
  }
  return ms;
}

// ── Expectation DSL (closed, deterministic — never LLM-evaluated) ─────────

export const expectationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exit_zero') }),
  z.object({ kind: z.literal('all_running') }),
  z.object({ kind: z.literal('max_percent'), value: z.number().min(0).max(100) }),
  z.object({ kind: z.literal('min_count'), value: z.number().int().min(0) }),
  z.object({ kind: z.literal('regex_match'), pattern: z.string().min(1) }),
  z.object({ kind: z.literal('regex_absent'), pattern: z.string().min(1) }),
  z.object({
    kind: z.literal('json_path_eq'),
    path: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean()]),
  }),
]);

export type Expectation = z.infer<typeof expectationSchema>;

// ── Plan frontmatter schemas (what Bun.YAML.parse output must satisfy) ────

const PLAN_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const INTERVAL_STRING = z
  .string()
  .regex(INTERVAL_PATTERN, 'expected e.g. "30s", "5m", "1h"')
  .refine(
    (s) => {
      const m = INTERVAL_PATTERN.exec(s);
      if (m === null) return false;
      const mult = m[2] === 's' ? 1_000 : m[2] === 'm' ? 60_000 : 3_600_000;
      return Number(m[1]) * mult >= MIN_INTERVAL_MS;
    },
    `interval must be at least ${MIN_INTERVAL_MS / 1_000}s`,
  );

export const checkFrontmatterSchema = z.object({
  name: z.string().min(1).optional(),
  action: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  expect: expectationSchema,
  every: INTERVAL_STRING.optional(),
});

export const watchFrontmatterSchema = z.object({
  name: z.string().regex(PLAN_NAME_PATTERN, 'lowercase, digits and dashes only'),
  description: z.string().min(1),
  environment: z.string().min(1),
  defaults: z.object({ every: INTERVAL_STRING }).optional(),
  checks: z.array(checkFrontmatterSchema).min(1),
});

export type WatchFrontmatter = z.infer<typeof watchFrontmatterSchema>;

// ── Resolved plan (post-parse, post-validation) ───────────────────────────

export type WatchPlanSource = 'stock' | 'user' | 'compiled';

export interface WatchCheck {
  /** Unique within the plan. Defaults to the action name (+ index suffix on collision). */
  readonly name: string;
  readonly action: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly expect: Expectation;
  readonly intervalMs: number;
}

export interface WatchPlan {
  readonly name: string;
  readonly description: string;
  readonly environment: string;
  readonly checks: readonly WatchCheck[];
  /** Markdown body — runbook context fed to the LLM only on anomaly. */
  readonly runbook: string;
  readonly source: WatchPlanSource;
}

// ── Runtime outcomes & events ─────────────────────────────────────────────

export type CheckOutcomeKind = 'pass' | 'expectation-failed' | 'check-error';

export interface CheckOutcome {
  readonly checkName: string;
  readonly kind: CheckOutcomeKind;
  /** Human-readable, scrubbed. For failures: what did not hold. */
  readonly detail: string;
  readonly exitCode: number | null;
  readonly executedAtMs: number;
}

export type DiagnosisSkipReason = 'budget' | 'cooldown' | 'no-diagnoser';

export type WatchEvent =
  | { readonly type: 'watch-started'; readonly planName: string; readonly runId: number }
  | { readonly type: 'check-result'; readonly outcome: CheckOutcome }
  | {
      readonly type: 'anomaly';
      readonly checkName: string;
      readonly outcomeKind: Exclude<CheckOutcomeKind, 'pass'>;
      readonly consecutiveFailures: number;
      readonly atMs: number;
      readonly anomalyId: number;
    }
  | { readonly type: 'diagnosis-started'; readonly checkName: string }
  | { readonly type: 'diagnosis-ready'; readonly checkName: string; readonly reportMarkdown: string }
  | { readonly type: 'diagnosis-skipped'; readonly checkName: string; readonly reason: DiagnosisSkipReason }
  | { readonly type: 'notify-failed'; readonly channel: string; readonly message: string }
  | { readonly type: 'watch-stopped'; readonly reason: string };
