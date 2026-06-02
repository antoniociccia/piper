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
import {
  detectPermissionDenied,
  detectSudoPasswordRequired,
  type Elevation,
} from '../security/elevation.ts';
import { isPathDenied } from '../security/paths.ts';
import { detectSecrets, scrubText } from '../security/scrub.ts';
import { toInteractive } from './ssh.ts';
import type { Environment } from '../environments/types.ts';

import {
  argvToShell,
  ExecError,
  type ElevationApprovalCallback,
  type ExecContext,
  type ExecResult,
  type MutationApprovalCallback,
  type MutationExecMeta,
  type MutationProposal,
  type RefuseReason,
} from './types.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ALLOWED_TIERS: readonly Tier[] = ['read', 'mutate', 'destructive'];

/**
 * Defense in depth: after a sudo elevation is approved, the resolved argv MUST
 * actually carry sudo before we execute. Catches a buildCommand that — by bug
 * or tampering — drops the elevation between approval and execution. Matches
 * either a local `sudo` token or `sudo`/`sudo -n` embedded in a remote command
 * string (actions self-wrap ssh, so sudo lives inside the quoted remote cmd).
 */
function argvCarriesSudo(argv: readonly string[]): boolean {
  return argv.some((a) => a === 'sudo' || a.includes('sudo -n ') || a.includes('sudo '));
}

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
  /**
   * Required for any action whose effective elevation is `sudo`. When unset,
   * a sudo-wanting action is refused (`mutation-no-approval`) — sudo never runs
   * unprompted. The callback shows the verbatim `sudo -n …` command and returns
   * the decision. Destructive-tier "approve-remember" is never persisted.
   */
  readonly onElevationProposal?: ElevationApprovalCallback;
  /**
   * When false, mutate+sudo proposals carry `doubleConfirm: false` (single
   * confirmation). Defaults to true (the safe default — ask twice).
   */
  readonly sudoDoubleConfirmMutate?: boolean;
  /**
   * Called when an elevated `sudo -n` run failed because it needs a password.
   * Returns true if the user wants to retry via an INTERACTIVE ssh -tt session
   * where they type the password on their own terminal (PIPER never sees it).
   */
  readonly onSudoPasswordRequired?: (info: {
    readonly actionName: string;
    readonly commandScrubbed: string;
    readonly environment?: Environment;
  }) => Promise<boolean>;
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

  // Session-only allowlist for remembered sudo elevations, keyed by
  // `${environment} ${action}`. Never persisted to PGlite, never holds a
  // destructive action (guarded at insertion). Cleared when the executor (and
  // thus the session) goes away.
  const rememberedSudo = new Set<string>();
  const sudoKey = (envName: string, actionName: string): string => `${envName} ${actionName}`;

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

  // Interactive run for the sudo-password fallback. stdio is INHERITED, so the
  // sudo password prompt and the typed password stay on the user's terminal and
  // never enter PIPER's buffers. We learn only the exit code.
  async function runInteractive(argv: readonly string[]): Promise<number> {
    const proc = Bun.spawn([...argv], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    return await proc.exited;
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

    // Path denylist. Scan the canonical `path` arg AND any other string arg
    // whose value is a filesystem path (starts with `/` or `~/`). The second
    // clause matters once actions can run under sudo: a privileged action could
    // otherwise read a denied file (`/etc/shadow`, `~/.ssh/id_rsa`) via a
    // differently-named arg (`target`, `file`, `unit`). Free-text args (search
    // queries, service names) don't start with `/` or `~/`, so they're never
    // falsely denied.
    for (const [key, value] of Object.entries(argsObj)) {
      if (typeof value !== 'string') continue;
      const looksLikePath = key === 'path' || value.startsWith('/') || value.startsWith('~/');
      if (looksLikePath && isPathDenied(value, userPaths)) {
        return refuse(actionName, args, 'path-denied', ctx, `path in denylist: ${value}`, {
          path: value,
        });
      }
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

    const typedAction = action as Action<unknown, unknown>;

    // ── Elevation gate ───────────────────────────────────────────────────────
    // Runs AFTER the path-denylist check above, so a sudo command with a denied
    // path arg is refused (`path-denied`) without ever prompting for sudo.
    const wantsSudo = typedAction.defaultElevation === 'sudo' || ctx.elevation === 'sudo';
    let elevation: Elevation = 'none';
    if (wantsSudo) {
      const envName = resolvedEnvironment?.name ?? '';
      if (!rememberedSudo.has(sudoKey(envName, typedAction.name))) {
        if (deps.onElevationProposal === undefined) {
          return refuse(typedAction.name, args, 'mutation-no-approval', ctx, 'sudo requires an approver');
        }
        const previewCtx: ActionExecContext = {
          sessionId: ctx.sessionId,
          ...(resolvedEnvironment === undefined ? {} : { environment: resolvedEnvironment }),
          elevation: 'sudo',
        };
        const previewArgv = typedAction.buildCommand(args, previewCtx);
        // Proactive misconfig: the action declares sudo elevation but its
        // buildCommand doesn't honor ctx.elevation, so the resolved command
        // carries no sudo and would trip the argvCarriesSudo backstop after the
        // user approved. Refuse with a clear message instead of prompting for a
        // sudo that can't apply.
        if (!argvCarriesSudo(previewArgv)) {
          return refuse(
            typedAction.name,
            args,
            'execution-failed',
            ctx,
            'action declares sudo elevation but buildCommand does not honor ctx.elevation',
          );
        }
        const decision = await deps.onElevationProposal({
          actionName: typedAction.name,
          tier: typedAction.tier,
          args,
          commandScrubbed: scrubText(argvToShell(previewArgv), userScrub),
          ...(resolvedEnvironment === undefined ? {} : { environment: resolvedEnvironment }),
          origin: ctx.elevation === 'sudo' ? 'reactive' : 'proactive',
          doubleConfirm: typedAction.tier === 'mutate' && (deps.sudoDoubleConfirmMutate ?? true),
        });
        if (decision.kind === 'reject') {
          return refuse(typedAction.name, args, 'elevation-rejected', ctx, decision.reason ?? 'sudo rejected');
        }
        // Destructive sudo is NEVER remembered — it prompts every time, by design.
        if (decision.kind === 'approve-remember' && typedAction.tier !== 'destructive') {
          rememberedSudo.add(sudoKey(envName, typedAction.name));
        }
      }
      elevation = 'sudo';
    }

    const actionCtx: ActionExecContext = {
      sessionId: ctx.sessionId,
      ...(resolvedEnvironment === undefined ? {} : { environment: resolvedEnvironment }),
      ...(elevation === 'none' ? {} : { elevation }),
    };

    // Mutate / destructive: route through the human-in-the-loop flow.
    if (typedAction.tier !== 'read') {
      return execMutation(typedAction, args, argsJson, actionCtx, ctx, resolvedEnvironment, elevation);
    }

    return execRead(typedAction, args, argsJson, actionCtx, ctx, elevation);
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
    elevation: Elevation,
  ): Promise<ExecResult> {
    const argv = action.buildCommand(args, actionCtx);
    if (argv.length === 0) {
      return refuse(action.name, args, 'execution-failed', ctx, 'buildCommand returned empty argv');
    }
    if (elevation === 'sudo' && !argvCarriesSudo(argv)) {
      return refuse(action.name, args, 'execution-failed', ctx, 'approved sudo but resolved command lacks sudo');
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

    // Sudo password fallback: an ELEVATED `sudo -n` run that failed solely
    // because the host needs a password / TTY. We offer to retry in an
    // INTERACTIVE ssh -tt session where the user types the password on their own
    // terminal — it never enters PIPER's buffers, logs, evidence, or model. We
    // learn only the exit code. This is distinct from the reactive permission
    // block below (already-sudo needing a password, not a generic denial).
    if (
      elevation === 'sudo' &&
      exitCode !== 0 &&
      detectSudoPasswordRequired(stderrScrubbed) &&
      deps.onSudoPasswordRequired !== undefined &&
      actionCtx.environment !== undefined
    ) {
      const interactiveArgv = toInteractive(argv);
      const interactiveCommandScrubbed = scrubText(argvToShell(interactiveArgv), userScrub);
      const ok = await deps.onSudoPasswordRequired({
        actionName: action.name,
        commandScrubbed: interactiveCommandScrubbed,
        environment: actionCtx.environment,
      });
      if (ok) {
        const interactiveAuditId = await insertAudit(
          'exec',
          ctx.sessionId,
          action.name,
          scrubText(argsJson, userScrub),
          { commandScrubbed: interactiveCommandScrubbed },
        );
        const code = await runInteractive(interactiveArgv);
        // Output went to the user's terminal; we capture only the exit code.
        await deps.db.query(`UPDATE audit_log SET exit_code = $1 WHERE id = $2`, [
          code,
          interactiveAuditId,
        ]);
        return {
          auditId: interactiveAuditId,
          // Reuse the failed `sudo -n` evidence row: the interactive run produces
          // no captured stdout/stderr by design, so there is nothing new to store.
          evidenceId,
          stdout: '',
          stderr: '',
          exitCode: code,
          durationMs: 0,
        };
      }
    }

    // Reactive sudo: a non-elevated permission failure → offer a sudo re-run.
    // Recursion-safe: the re-run sets ctx.elevation='sudo', so the second pass
    // has elevation!=='none' here and cannot re-trigger.
    if (
      elevation === 'none' &&
      action.defaultElevation !== 'sudo' &&
      deps.onElevationProposal !== undefined &&
      detectPermissionDenied(stderrScrubbed, exitCode)
    ) {
      const previewCtx: ActionExecContext = { ...actionCtx, elevation: 'sudo' };
      const previewArgv = action.buildCommand(args, previewCtx);
      // Guard: only propose sudo if the action actually honors ctx.elevation.
      // A buildCommand that ignores elevation would produce the same non-sudo
      // command, then trip the argvCarriesSudo backstop on the re-run and fail
      // with "approved sudo but resolved command lacks sudo" — bad UX. Skip the
      // proposal and return the original failed result instead.
      if (!argvCarriesSudo(previewArgv)) {
        return {
          auditId,
          evidenceId,
          stdout: stdoutScrubbed,
          stderr: stderrScrubbed,
          exitCode,
          durationMs,
        };
      }
      const decision = await deps.onElevationProposal({
        actionName: action.name,
        tier: action.tier,
        args,
        commandScrubbed: scrubText(argvToShell(previewArgv), userScrub),
        ...(actionCtx.environment === undefined ? {} : { environment: actionCtx.environment }),
        origin: 'reactive',
        doubleConfirm: false,
      });
      if (decision.kind !== 'reject') {
        const key = sudoKey(actionCtx.environment?.name ?? '', action.name);
        const persist = decision.kind === 'approve-remember' && action.tier !== 'destructive';
        // Grant for THIS re-run so the gate in the recursive exec() doesn't
        // prompt a second time. approve-remember keeps the grant for the
        // session; approve-once removes it after the single re-run.
        const wasAlreadyRemembered = rememberedSudo.has(key);
        rememberedSudo.add(key);
        try {
          return await exec(action.name, args, { ...ctx, elevation: 'sudo' });
        } finally {
          if (!persist && !wasAlreadyRemembered) rememberedSudo.delete(key);
        }
      }
    }

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
    elevation: Elevation,
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

    // The context/elevation actually used for the dry-run, execute, verify, and
    // rollback hooks. Starts from what exec() decided, but the snapshot probe
    // below may upgrade it to sudo IN PLACE (no recursion). The params stay
    // untouched — only these locals change.
    let effectiveCtx = actionCtx;
    let effectiveElevation = elevation;

    // 1. Snapshot (best-effort; non-fatal if it fails — verify may still work).
    //    It runs NON-elevated (the probe): on a sudo-only host this fails with a
    //    permission-denied stderr, which we read below to offer reactive sudo.
    let snapshotOutput: string | undefined;
    let snapshotStderr = '';
    let snapshotExit = 0;
    if (action.buildSnapshotCommand !== undefined) {
      const snapArgv = action.buildSnapshotCommand(args, actionCtx);
      if (snapArgv.length > 0) {
        const snapAudit = await insertAudit('mutate-snapshot', ctx.sessionId, action.name, argsScrubbedJson, {
          commandScrubbed: scrubText(argvToShell(snapArgv), userScrub),
        });
        const snap = await runProcess(snapArgv, timeoutMs);
        await deps.db.query(`UPDATE audit_log SET exit_code = $1 WHERE id = $2`, [snap.exitCode, snapAudit]);
        snapshotOutput = scrubText(snap.stdout, userScrub);
        snapshotStderr = scrubText(snap.stderr, userScrub);
        snapshotExit = snap.exitCode;
        await insertEvidence(ctx.sessionId, snapAudit, snapshotOutput, snapshotStderr);
      }
    }

    // Reactive sudo for mutations: if the read-only snapshot probe hit a
    // permission boundary and the action is elevation-aware, offer sudo for the
    // whole mutation (in place — no recursion, so the mutation proposal still
    // fires exactly once afterwards).
    if (
      effectiveElevation === 'none' &&
      deps.onElevationProposal !== undefined &&
      detectPermissionDenied(snapshotStderr, snapshotExit)
    ) {
      const previewCtx: ActionExecContext = { ...actionCtx, elevation: 'sudo' };
      const previewArgv = action.buildCommand(args, previewCtx);
      if (argvCarriesSudo(previewArgv)) { // action genuinely honors elevation
        const decision = await deps.onElevationProposal({
          actionName: action.name,
          tier: action.tier,
          args,
          commandScrubbed: scrubText(argvToShell(previewArgv), userScrub),
          ...(environment === undefined ? {} : { environment }),
          origin: 'reactive',
          doubleConfirm: action.tier === 'mutate' && (deps.sudoDoubleConfirmMutate ?? true),
        });
        if (decision.kind !== 'reject') {
          if (decision.kind === 'approve-remember' && action.tier !== 'destructive') {
            rememberedSudo.add(sudoKey(environment?.name ?? '', action.name));
          }
          effectiveElevation = 'sudo';
          effectiveCtx = previewCtx;
          // Re-run the snapshot elevated so the pre-state (used by rollback) is real.
          if (action.buildSnapshotCommand !== undefined) {
            const snap2Argv = action.buildSnapshotCommand(args, effectiveCtx);
            if (snap2Argv.length > 0) {
              const snap2Audit = await insertAudit('mutate-snapshot', ctx.sessionId, action.name, argsScrubbedJson, {
                commandScrubbed: scrubText(argvToShell(snap2Argv), userScrub),
              });
              const snap2 = await runProcess(snap2Argv, timeoutMs);
              await deps.db.query(`UPDATE audit_log SET exit_code = $1 WHERE id = $2`, [snap2.exitCode, snap2Audit]);
              snapshotOutput = scrubText(snap2.stdout, userScrub);
              await insertEvidence(ctx.sessionId, snap2Audit, snapshotOutput, scrubText(snap2.stderr, userScrub));
            }
          }
        }
        // On reject: proceed non-elevated. The mutation will likely fail, but the
        // user explicitly declined sudo — their choice, and the failure is reported.
      }
    }

    // 2. Dry-run (best-effort; shown to the user as the diff to approve).
    let dryRunOutput: string | undefined;
    if (action.buildDryRunCommand !== undefined) {
      const dryArgv = action.buildDryRunCommand(args, effectiveCtx);
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
    const execArgv = action.buildCommand(args, effectiveCtx);
    if (execArgv.length === 0) {
      return refuse(action.name, args, 'execution-failed', ctx, 'buildCommand returned empty argv');
    }
    if (effectiveElevation === 'sudo' && !argvCarriesSudo(execArgv)) {
      return refuse(action.name, args, 'execution-failed', ctx, 'approved sudo but resolved command lacks sudo');
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
      const verifyArgv = action.buildVerifyCommand(args, effectiveCtx);
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
          const rbArgv = action.buildRollbackCommand(args, effectiveCtx, snapshotOutput ?? '');
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
