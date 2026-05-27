import type { PGlite } from '@electric-sql/pglite';

import type { Catalog } from '../actions/catalog.ts';
import type { Action, ActionExecContext, Tier } from '../actions/types.ts';
import type { EnvironmentRegistry } from '../environments/registry.ts';
import { createEnvironmentRegistry } from '../environments/registry.ts';
import type { Logger } from '../logging/logger.ts';
import type { AuditKind } from '../memory/migrations.ts';
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
  type MutationApprovalCallback,
  type MutationExecMeta,
  type MutationProposal,
  type RefuseReason,
} from './types.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ALLOWED_TIERS: readonly Tier[] = ['read', 'mutate', 'destructive'];

export interface ExecutorDeps {
  readonly db: PGlite;
  readonly catalog: Catalog;
  readonly registry?: EnvironmentRegistry;
  readonly logger?: Logger;
  /**
   * Tiers this executor will accept. Defaults to all three — restriction by
   * tier should now happen via `onMutationProposal`, not by clamping the
   * list. We keep the option for tests that want a hard read-only executor.
   */
  readonly allowedTiers?: readonly Tier[];
  readonly userPathPatterns?: readonly RegExp[];
  readonly userScrubPatterns?: readonly RegExp[];
  /**
   * Optional embedder for the in-process `memory.search` action. If undefined,
   * memory.search will succeed with an empty result set (no embedder = no RAG).
   */
  readonly embedder?: EmbeddingClient;
  /**
   * Required for mutate/destructive tier execution. When unset, those tiers
   * are refused with `mutation-no-approval`. The callback is responsible for
   * showing the proposal to the user (TUI prompt) and returning the decision.
   * Destructive-tier "approve-remember" decisions are downgraded to
   * "approve-once" by the executor — destructive is never persisted.
   */
  readonly onMutationProposal?: MutationApprovalCallback;
}

export interface Executor {
  exec(actionName: string, args: unknown, ctx: ExecContext): Promise<ExecResult>;
}

interface RawProcOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const allowedTiers = deps.allowedTiers ?? DEFAULT_ALLOWED_TIERS;
  const userScrub = deps.userScrubPatterns ?? [];
  const userPaths = deps.userPathPatterns ?? [];
  const log = deps.logger;
  const registry = deps.registry ?? createEnvironmentRegistry(deps.db);

  // ────────────────────────────────────────────────────────────────────────
  // Audit helpers
  // ────────────────────────────────────────────────────────────────────────

  async function insertAudit(
    kind: AuditKind,
    sessionId: string,
    actionName: string,
    argsScrubbedJson: string,
    extra: { commandScrubbed?: string; exitCode?: number; refusedReason?: string } = {},
  ): Promise<AuditLogId> {
    const result = await deps.db.query<{ id: AuditLogId }>(
      `INSERT INTO audit_log
         (session_id, kind, action_name, args_scrubbed_json, command_scrubbed, exit_code, refused_reason)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING id`,
      [
        sessionId,
        kind,
        actionName,
        argsScrubbedJson,
        extra.commandScrubbed ?? null,
        extra.exitCode ?? null,
        extra.refusedReason ?? null,
      ],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error(`failed to persist audit row (kind=${kind})`);
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
    const argsScrubbedJson = scrubText(JSON.stringify(args ?? null), userScrub);
    return insertAudit('refuse', ctx.sessionId, actionName, argsScrubbedJson, {
      refusedReason: `${reason}: ${message}`,
    }).then((auditId) => {
      log?.debug('action refused', { action: actionName, reason });
      throw new ExecError({
        reason,
        actionName,
        message,
        auditId,
        details: details ?? {},
      });
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Subprocess runner — single side-effect surface, with timeout + scrubbing.
  // ────────────────────────────────────────────────────────────────────────

  async function runProcess(argv: readonly string[], timeoutMs: number): Promise<RawProcOutput> {
    const proc = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'pipe' });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    let exitCode = -1;
    try {
      exitCode = await proc.exited;
    } finally {
      clearTimeout(timer);
    }
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    return { stdout, stderr, exitCode, timedOut };
  }

  // ────────────────────────────────────────────────────────────────────────
  // exec — the only entry point
  // ────────────────────────────────────────────────────────────────────────

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

    // Mutate / destructive: route through the human-in-the-loop flow.
    if (typedAction.tier !== 'read') {
      return execMutation(typedAction, args, argsJson, actionCtx, ctx, resolvedEnvironment);
    }

    return execRead(typedAction, args, argsJson, actionCtx, ctx);
  }

  // ────────────────────────────────────────────────────────────────────────
  // execRead — read-tier flow (unchanged from M1)
  // ────────────────────────────────────────────────────────────────────────

  async function execRead(
    action: Action<unknown, unknown>,
    args: unknown,
    argsJson: string,
    actionCtx: ActionExecContext,
    ctx: ExecContext,
  ): Promise<ExecResult> {
    const argv = action.buildCommand(args, actionCtx);
    if (argv.length === 0) {
      return refuse(action.name, args, 'execution-failed', ctx, 'buildCommand returned empty argv');
    }
    const commandScrubbed = scrubText(argvToShell(argv), userScrub);
    const argsScrubbedJson = scrubText(argsJson, userScrub);
    const auditId = await insertAudit('exec', ctx.sessionId, action.name, argsScrubbedJson, {
      commandScrubbed,
    });

    const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const start = performance.now();

    let stdoutRaw = '';
    let stderrRaw = '';
    let exitCode = -1;
    let timedOut = false;

    try {
      if (argv[0] === '__memory_search__') {
        // In-process special action: memory.search. Same audit/evidence/scrub
        // pipeline as everything else, but no subprocess.
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
        const proc = await runProcess(argv, timeoutMs);
        stdoutRaw = proc.stdout;
        stderrRaw = proc.stderr;
        exitCode = proc.exitCode;
        timedOut = proc.timedOut;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await deps.db.query(
        `UPDATE audit_log SET exit_code = $1, refused_reason = $2 WHERE id = $3`,
        [-1, `execution-failed: ${message}`, auditId],
      );
      throw new ExecError({
        reason: 'execution-failed',
        actionName: action.name,
        message: `spawn failed: ${message}`,
        auditId,
      });
    }

    const durationMs = performance.now() - start;
    const stdoutScrubbed = scrubText(stdoutRaw, userScrub);
    const stderrScrubbed = scrubText(stderrRaw, userScrub);

    await deps.db.query(`UPDATE audit_log SET exit_code = $1 WHERE id = $2`, [exitCode, auditId]);

    if (timedOut) {
      await deps.db.query(`UPDATE audit_log SET refused_reason = $1 WHERE id = $2`, [
        `timeout: killed after ${timeoutMs}ms`,
        auditId,
      ]);
      throw new ExecError({
        reason: 'timeout',
        actionName: action.name,
        message: `process killed after ${timeoutMs}ms timeout`,
        auditId,
      });
    }

    const evidenceId = await insertEvidence(ctx.sessionId, auditId, stdoutScrubbed, stderrScrubbed);

    log?.debug('action executed', {
      action: action.name,
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

  // ────────────────────────────────────────────────────────────────────────
  // execMutation — propose → approve → execute → verify → rollback
  // ────────────────────────────────────────────────────────────────────────

  async function execMutation(
    action: Action<unknown, unknown>,
    args: unknown,
    argsJson: string,
    actionCtx: ActionExecContext,
    ctx: ExecContext,
    environment: ActionExecContext['environment'],
  ): Promise<ExecResult> {
    if (deps.onMutationProposal === undefined) {
      return refuse(
        action.name,
        args,
        'mutation-no-approval',
        ctx,
        'mutate/destructive action invoked but no approval callback wired',
      );
    }

    const argsScrubbedJson = scrubText(argsJson, userScrub);
    const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // 1. Snapshot (best-effort; non-fatal if it fails — verify may still work).
    let snapshotOutput: string | undefined;
    if (action.buildSnapshotCommand !== undefined) {
      const snapArgv = action.buildSnapshotCommand(args, actionCtx);
      if (snapArgv.length > 0) {
        const snapAudit = await insertAudit('mutate-snapshot', ctx.sessionId, action.name, argsScrubbedJson, {
          commandScrubbed: scrubText(argvToShell(snapArgv), userScrub),
        });
        const snap = await runProcess(snapArgv, timeoutMs);
        await deps.db.query(`UPDATE audit_log SET exit_code = $1 WHERE id = $2`, [snap.exitCode, snapAudit]);
        snapshotOutput = scrubText(snap.stdout, userScrub);
        await insertEvidence(ctx.sessionId, snapAudit, snapshotOutput, scrubText(snap.stderr, userScrub));
      }
    }

    // 2. Dry-run (best-effort; shown to the user as the diff to approve).
    let dryRunOutput: string | undefined;
    if (action.buildDryRunCommand !== undefined) {
      const dryArgv = action.buildDryRunCommand(args, actionCtx);
      if (dryArgv.length > 0) {
        const dryAudit = await insertAudit('mutate-dryrun', ctx.sessionId, action.name, argsScrubbedJson, {
          commandScrubbed: scrubText(argvToShell(dryArgv), userScrub),
        });
        const dry = await runProcess(dryArgv, timeoutMs);
        await deps.db.query(`UPDATE audit_log SET exit_code = $1 WHERE id = $2`, [dry.exitCode, dryAudit]);
        dryRunOutput = scrubText(dry.stdout, userScrub);
        await insertEvidence(ctx.sessionId, dryAudit, dryRunOutput, scrubText(dry.stderr, userScrub));
      }
    }

    // 3. Build the mutation command and emit the proposal.
    const execArgv = action.buildCommand(args, actionCtx);
    if (execArgv.length === 0) {
      return refuse(action.name, args, 'execution-failed', ctx, 'buildCommand returned empty argv');
    }
    const commandScrubbed = scrubText(argvToShell(execArgv), userScrub);

    const proposalAuditId = await insertAudit(
      'mutate-proposed',
      ctx.sessionId,
      action.name,
      argsScrubbedJson,
      { commandScrubbed },
    );

    const proposal: MutationProposal = {
      actionName: action.name,
      tier: action.tier as 'mutate' | 'destructive',
      args,
      commandScrubbed,
      ...(snapshotOutput === undefined ? {} : { snapshotOutput }),
      ...(dryRunOutput === undefined ? {} : { dryRunOutput }),
      ...(environment === undefined ? {} : { environment }),
    };

    const decisionRaw = await deps.onMutationProposal(proposal);
    // Destructive never persists. Downgrade silently — the user's intent is
    // "I'm ok running this once"; we honour that without bending the rule.
    const decision =
      action.tier === 'destructive' && decisionRaw.kind === 'approve-remember'
        ? ({ kind: 'approve-once' } as const)
        : decisionRaw;

    if (decision.kind === 'reject') {
      await deps.db.query(
        `UPDATE audit_log SET refused_reason = $1 WHERE id = $2`,
        [`mutation-rejected: ${decision.reason ?? 'user declined'}`, proposalAuditId],
      );
      await insertAudit('mutate-rejected', ctx.sessionId, action.name, argsScrubbedJson, {
        commandScrubbed,
        refusedReason: decision.reason ?? 'user declined',
      });
      throw new ExecError({
        reason: 'mutation-rejected',
        actionName: action.name,
        message: decision.reason ?? 'user declined the mutation proposal',
        auditId: proposalAuditId,
      });
    }

    // 4. Execute.
    const execAuditId = await insertAudit('mutate-execute', ctx.sessionId, action.name, argsScrubbedJson, {
      commandScrubbed,
    });
    const start = performance.now();
    const execProc = await runProcess(execArgv, timeoutMs);
    await deps.db.query(`UPDATE audit_log SET exit_code = $1 WHERE id = $2`, [execProc.exitCode, execAuditId]);
    const stdoutScrubbed = scrubText(execProc.stdout, userScrub);
    const stderrScrubbed = scrubText(execProc.stderr, userScrub);
    const evidenceId = await insertEvidence(ctx.sessionId, execAuditId, stdoutScrubbed, stderrScrubbed);
    const durationMs = performance.now() - start;

    if (execProc.timedOut) {
      await deps.db.query(`UPDATE audit_log SET refused_reason = $1 WHERE id = $2`, [
        `timeout: killed after ${timeoutMs}ms`,
        execAuditId,
      ]);
      throw new ExecError({
        reason: 'timeout',
        actionName: action.name,
        message: `mutation killed after ${timeoutMs}ms timeout`,
        auditId: execAuditId,
      });
    }

    // 5. Verify + rollback.
    let verifyExitCode: number | undefined;
    let verifyOutput: string | undefined;
    let rolledBack = false;
    let rollbackOutput: string | undefined;

    if (action.buildVerifyCommand !== undefined) {
      const verifyArgv = action.buildVerifyCommand(args, actionCtx);
      if (verifyArgv.length > 0) {
        const verifyAudit = await insertAudit('mutate-verify', ctx.sessionId, action.name, argsScrubbedJson, {
          commandScrubbed: scrubText(argvToShell(verifyArgv), userScrub),
        });
        const ver = await runProcess(verifyArgv, timeoutMs);
        await deps.db.query(`UPDATE audit_log SET exit_code = $1 WHERE id = $2`, [ver.exitCode, verifyAudit]);
        verifyExitCode = ver.exitCode;
        verifyOutput = scrubText(ver.stdout, userScrub);
        await insertEvidence(
          ctx.sessionId,
          verifyAudit,
          verifyOutput,
          scrubText(ver.stderr, userScrub),
        );

        if (ver.exitCode !== 0 && action.buildRollbackCommand !== undefined) {
          const rbArgv = action.buildRollbackCommand(args, actionCtx, snapshotOutput ?? '');
          if (rbArgv !== null && rbArgv.length > 0) {
            const rbAudit = await insertAudit('mutate-rollback', ctx.sessionId, action.name, argsScrubbedJson, {
              commandScrubbed: scrubText(argvToShell(rbArgv), userScrub),
            });
            const rb = await runProcess(rbArgv, timeoutMs);
            await deps.db.query(`UPDATE audit_log SET exit_code = $1 WHERE id = $2`, [rb.exitCode, rbAudit]);
            rollbackOutput = scrubText(rb.stdout, userScrub);
            rolledBack = true;
            await insertEvidence(
              ctx.sessionId,
              rbAudit,
              rollbackOutput,
              scrubText(rb.stderr, userScrub),
            );
          }

          // Surface verify failure as an ExecError so the caller knows the
          // mutation did NOT land cleanly — but the audit trail above tells
          // them what was tried.
          const errMsg = `verify exited with code ${ver.exitCode}` + (rolledBack ? ' (rolled back)' : ' (no rollback available)');
          throw new ExecError({
            reason: 'verify-failed',
            actionName: action.name,
            message: errMsg,
            auditId: execAuditId,
            details: { verifyExitCode: ver.exitCode, rolledBack },
          });
        }
      }
    }

    const mutation: MutationExecMeta = {
      remembered: decision.kind === 'approve-remember' && action.tier === 'mutate',
      rolledBack,
      ...(snapshotOutput === undefined ? {} : { snapshotOutput }),
      ...(dryRunOutput === undefined ? {} : { dryRunOutput }),
      ...(verifyExitCode === undefined ? {} : { verifyExitCode }),
      ...(verifyOutput === undefined ? {} : { verifyOutput }),
      ...(rollbackOutput === undefined ? {} : { rollbackOutput }),
    };

    log?.debug('mutation executed', {
      action: action.name,
      tier: action.tier,
      exit_code: execProc.exitCode,
      verify_exit_code: verifyExitCode ?? null,
      rolled_back: rolledBack,
      duration_ms: durationMs,
    });

    return {
      auditId: execAuditId,
      evidenceId,
      stdout: stdoutScrubbed,
      stderr: stderrScrubbed,
      exitCode: execProc.exitCode,
      durationMs,
      mutation,
    };
  }

  async function insertEvidence(
    sessionId: string,
    actionId: AuditLogId,
    stdoutScrubbed: string,
    stderrScrubbed: string,
  ): Promise<EvidenceId> {
    const evidenceInsert = await deps.db.query<{ id: EvidenceId }>(
      `INSERT INTO evidence
         (session_id, action_id, stdout_scrubbed, stderr_scrubbed)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [sessionId, actionId, stdoutScrubbed, stderrScrubbed],
    );
    const id = evidenceInsert.rows[0]?.id;
    if (id === undefined) throw new Error('failed to persist evidence row');
    return id;
  }

  return { exec };
}
