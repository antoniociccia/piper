import type { PGlite } from '@electric-sql/pglite';

import type { SessionId } from '../memory/types.ts';
import { scrubText } from '../security/scrub.ts';

import type { CheckOutcome, CheckOutcomeKind } from './types.ts';

export type WatchRunId = number;
export type WatchAnomalyId = number;

export type DiagnosisStatus =
  | 'pending'
  | 'ready'
  | 'skipped-budget'
  | 'skipped-cooldown'
  | 'skipped-no-diagnoser';

export interface DiagnosisUpdate {
  readonly status: DiagnosisStatus;
  readonly reportMarkdown?: string;
}

export interface WatchStore {
  createRun(sessionId: SessionId, planName: string, environment: string): Promise<WatchRunId>;
  finishRun(runId: WatchRunId, reason: string): Promise<void>;
  recordCheckResult(runId: WatchRunId, outcome: CheckOutcome): Promise<void>;
  recordAnomaly(
    runId: WatchRunId,
    checkName: string,
    kind: Exclude<CheckOutcomeKind, 'pass'>,
  ): Promise<WatchAnomalyId>;
  updateAnomalyDiagnosis(anomalyId: WatchAnomalyId, update: DiagnosisUpdate): Promise<void>;
}

// Write-time scrub discipline: every free-form text column that can originate from
// user-authored plan files is scrubbed via scrubText() before persistence. This
// includes environment, check_name, stopped_reason, detail, and diagnosis_report.
// plan_name is safe by construction (constrained to /^[a-z][a-z0-9-]{0,63}$/ at
// parse time) but is scrubbed here too — the overhead is negligible and the rule
// becomes simple: scrub every text param.
export function createWatchStore(db: PGlite, userScrubPatterns: readonly RegExp[] = []): WatchStore {
  return {
    async createRun(sessionId, planName, environment) {
      const result = await db.query<{ id: number }>(
        `INSERT INTO watch_runs (session_id, plan_name, environment) VALUES ($1, $2, $3) RETURNING id`,
        [sessionId, scrubText(planName, userScrubPatterns), scrubText(environment, userScrubPatterns)],
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error('failed to persist watch_runs row');
      // PGlite returns BIGSERIAL as number; guard against string in case of
      // driver behaviour changes or future schema edits.
      return typeof id === 'string' ? Number(id) : id;
    },

    async finishRun(runId, reason) {
      await db.query(
        `UPDATE watch_runs SET stopped_at = now(), stopped_reason = $1 WHERE id = $2`,
        [scrubText(reason, userScrubPatterns), runId],
      );
    },

    async recordCheckResult(runId, outcome) {
      await db.query(
        `INSERT INTO watch_check_results (watch_run_id, check_name, outcome, exit_code, detail_scrubbed)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          runId,
          scrubText(outcome.checkName, userScrubPatterns),
          outcome.kind,
          outcome.exitCode,
          scrubText(outcome.detail, userScrubPatterns),
        ],
      );
    },

    async recordAnomaly(runId, checkName, kind) {
      const result = await db.query<{ id: number }>(
        `INSERT INTO watch_anomalies (watch_run_id, check_name, kind) VALUES ($1, $2, $3) RETURNING id`,
        [runId, scrubText(checkName, userScrubPatterns), kind],
      );
      const id = result.rows[0]?.id;
      if (id === undefined) throw new Error('failed to persist watch_anomalies row');
      return typeof id === 'string' ? Number(id) : id;
    },

    async updateAnomalyDiagnosis(anomalyId, update) {
      const reportScrubbed =
        update.reportMarkdown === undefined
          ? null
          : scrubText(update.reportMarkdown, userScrubPatterns);
      await db.query(
        `UPDATE watch_anomalies SET diagnosis_status = $1, diagnosis_report = $2 WHERE id = $3`,
        [update.status, reportScrubbed, anomalyId],
      );
    },
  };
}
