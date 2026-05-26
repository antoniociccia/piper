import type { PGlite } from '@electric-sql/pglite';

import type { Catalog } from '../actions/catalog.ts';
import type { Action, ActionExecContext, Tier } from '../actions/types.ts';
import type { EnvironmentRegistry } from '../environments/registry.ts';
import { createEnvironmentRegistry } from '../environments/registry.ts';
import type { Logger } from '../logging/logger.ts';
import type { AuditLogId, EvidenceId } from '../memory/types.ts';
import type { EmbeddingClient } from '../rag/embedding-client.ts';
import { retrieveRelevant } from '../rag/retrieve.ts';
import { isPathDenied } from '../security/paths.ts';
import { detectSecrets, scrubText } from '../security/scrub.ts';

import {
  argvToShell,
  ExecError,
  type ExecContext,
  type ExecResult,
  type RefuseReason,
} from './types.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ALLOWED_TIERS: readonly Tier[] = ['read'];

export interface ExecutorDeps {
  readonly db: PGlite;
  readonly catalog: Catalog;
  readonly registry?: EnvironmentRegistry;
  readonly logger?: Logger;
  readonly allowedTiers?: readonly Tier[];
  readonly userPathPatterns?: readonly RegExp[];
  readonly userScrubPatterns?: readonly RegExp[];
  /**
   * Optional embedder for the in-process `memory.search` action. If undefined,
   * memory.search will succeed with an empty result set (no embedder = no RAG).
   */
  readonly embedder?: EmbeddingClient;
}

export interface Executor {
  exec(actionName: string, args: unknown, ctx: ExecContext): Promise<ExecResult>;
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const allowedTiers = deps.allowedTiers ?? DEFAULT_ALLOWED_TIERS;
  const userScrub = deps.userScrubPatterns ?? [];
  const userPaths = deps.userPathPatterns ?? [];
  const log = deps.logger;
  const registry = deps.registry ?? createEnvironmentRegistry(deps.db);

  async function writeRefusal(
    actionName: string,
    args: unknown,
    reason: RefuseReason,
    ctx: ExecContext,
    message: string,
  ): Promise<AuditLogId> {
    const scrubbedArgsJson = scrubText(JSON.stringify(args ?? null), userScrub);
    const result = await deps.db.query<{ id: AuditLogId }>(
      `INSERT INTO audit_log
         (session_id, kind, action_name, args_scrubbed_json, refused_reason)
       VALUES ($1, 'refuse', $2, $3::jsonb, $4)
       RETURNING id`,
      [ctx.sessionId, actionName, scrubbedArgsJson, `${reason}: ${message}`],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw new Error('failed to persist refusal audit row');
    }
    log?.debug('action refused', { action: actionName, reason });
    return id;
  }

  function refuse(
    actionName: string,
    args: unknown,
    reason: RefuseReason,
    ctx: ExecContext,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ): Promise<never> {
    return writeRefusal(actionName, args, reason, ctx, message).then((auditId) => {
      throw new ExecError({
        reason,
        actionName,
        message,
        auditId,
        details: details ?? {},
      });
    });
  }

  async function exec(
    actionName: string,
    rawArgs: unknown,
    ctx: ExecContext,
  ): Promise<ExecResult> {
    const action = deps.catalog.resolve(actionName);
    if (action === undefined) {
      return refuse(actionName, rawArgs, 'unknown-action', ctx, 'not in catalog');
    }

    if (!allowedTiers.includes(action.tier)) {
      return refuse(actionName, rawArgs, 'tier-not-allowed', ctx, `tier=${action.tier} not allowed`);
    }

    const parsed = action.argsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      return refuse(actionName, rawArgs, 'invalid-args', ctx, msg);
    }
    const args = parsed.data;

    const argsJson = JSON.stringify(args ?? null);
    const argsSecrets = detectSecrets(argsJson, userScrub);
    if (argsSecrets.length > 0) {
      const kinds = [...new Set(argsSecrets.map((s) => s.kind))];
      return refuse(
        actionName,
        args,
        'secret-in-args',
        ctx,
        `args contain redactable secret(s): ${kinds.join(', ')}`,
        { kinds },
      );
    }

    const argsObj =
      typeof args === 'object' && args !== null
        ? (args as Record<string, unknown>)
        : {};

    const pathArg = argsObj['path'];
    if (typeof pathArg === 'string' && isPathDenied(pathArg, userPaths)) {
      return refuse(actionName, args, 'path-denied', ctx, `path in denylist: ${pathArg}`, {
        path: pathArg,
      });
    }

    let resolvedEnvironment = ctx.environment;
    const envArg = argsObj['environment'];
    if (typeof envArg === 'string') {
      const env = await registry.get(envArg);
      if (env === null) {
        return refuse(
          actionName,
          args,
          'environment-not-found',
          ctx,
          `environment not registered: ${envArg}`,
          { environment: envArg },
        );
      }
      resolvedEnvironment = env;
    }

    const actionCtx: ActionExecContext = {
      sessionId: ctx.sessionId,
      ...(resolvedEnvironment === undefined ? {} : { environment: resolvedEnvironment }),
    };

    const typedAction = action as Action<unknown, unknown>;
    const argv = typedAction.buildCommand(args, actionCtx);
    if (argv.length === 0) {
      return refuse(actionName, args, 'execution-failed', ctx, 'buildCommand returned empty argv');
    }
    const commandStr = argvToShell(argv);
    const commandScrubbed = scrubText(commandStr, userScrub);

    const argsScrubbedJson = scrubText(argsJson, userScrub);
    const auditInsert = await deps.db.query<{ id: AuditLogId }>(
      `INSERT INTO audit_log
         (session_id, kind, action_name, args_scrubbed_json, command_scrubbed)
       VALUES ($1, 'exec', $2, $3::jsonb, $4)
       RETURNING id`,
      [ctx.sessionId, actionName, argsScrubbedJson, commandScrubbed],
    );
    const auditId = auditInsert.rows[0]?.id;
    if (auditId === undefined) {
      throw new Error('failed to persist exec audit row');
    }

    const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = performance.now();
    let timedOut = false;
    let exitCode = -1;
    let stdoutRaw = '';
    let stderrRaw = '';

    try {
      // In-process special action: memory.search. We DON'T spawn — we run a
      // pgvector retrieval directly on the same DB. Same audit/evidence/scrub
      // pipeline as everything else.
      if (argv[0] === '__memory_search__') {
        const a = args as { query: string; k?: number; kinds?: readonly string[] };
        if (deps.embedder === undefined) {
          stdoutRaw = JSON.stringify({ query: a.query, hits: [] });
          exitCode = 0;
        } else {
          try {
            const hits = await retrieveRelevant({
              db: deps.db,
              embedder: deps.embedder,
              query: a.query,
              ...(a.k === undefined ? {} : { k: a.k }),
              ...(a.kinds === undefined ? {} : { kinds: a.kinds as readonly ('runbook' | 'adr' | 'session-summary' | 'note' | 'solved-case')[] }),
            });
            stdoutRaw = JSON.stringify({
              query: a.query,
              hits: hits.map((h) => ({
                source: h.source,
                kind: h.kind,
                headingPath: h.headingPath,
                similarity: Number(h.similarity.toFixed(3)),
                excerpt: h.content.length > 800 ? `${h.content.slice(0, 800)}…` : h.content,
              })),
            });
            exitCode = 0;
          } catch (err) {
            stderrRaw = err instanceof Error ? err.message : String(err);
            exitCode = 1;
          }
        }
      } else {
        const proc = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'pipe' });
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs);
        try {
          exitCode = await proc.exited;
        } finally {
          clearTimeout(timer);
        }
        stdoutRaw = await new Response(proc.stdout).text();
        stderrRaw = await new Response(proc.stderr).text();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await deps.db.query(
        `UPDATE audit_log SET exit_code = $1, refused_reason = $2 WHERE id = $3`,
        [-1, `execution-failed: ${message}`, auditId],
      );
      throw new ExecError({
        reason: 'execution-failed',
        actionName,
        message: `spawn failed: ${message}`,
        auditId,
      });
    }

    const durationMs = performance.now() - start;
    const stdoutScrubbed = scrubText(stdoutRaw, userScrub);
    const stderrScrubbed = scrubText(stderrRaw, userScrub);

    await deps.db.query(`UPDATE audit_log SET exit_code = $1 WHERE id = $2`, [
      exitCode,
      auditId,
    ]);

    if (timedOut) {
      await deps.db.query(
        `UPDATE audit_log SET refused_reason = $1 WHERE id = $2`,
        [`timeout: killed after ${timeoutMs}ms`, auditId],
      );
      throw new ExecError({
        reason: 'timeout',
        actionName,
        message: `process killed after ${timeoutMs}ms timeout`,
        auditId,
      });
    }

    const evidenceInsert = await deps.db.query<{ id: EvidenceId }>(
      `INSERT INTO evidence
         (session_id, action_id, stdout_scrubbed, stderr_scrubbed)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [ctx.sessionId, auditId, stdoutScrubbed, stderrScrubbed],
    );
    const evidenceId = evidenceInsert.rows[0]?.id;
    if (evidenceId === undefined) {
      throw new Error('failed to persist evidence row');
    }

    log?.debug('action executed', {
      action: actionName,
      exit_code: exitCode,
      duration_ms: durationMs,
    });

    return {
      auditId,
      evidenceId,
      stdout: stdoutScrubbed,
      stderr: stderrScrubbed,
      exitCode,
      durationMs,
    };
  }

  return { exec };
}
