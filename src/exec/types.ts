import type { Environment } from '../environments/types.ts';
import type { AuditLogId, EvidenceId, SessionId } from '../memory/types.ts';

export type RefuseReason =
  | 'unknown-action'
  | 'invalid-args'
  | 'secret-in-args'
  | 'path-denied'
  | 'environment-not-found'
  | 'tier-not-allowed'
  | 'timeout'
  | 'execution-failed'
  | 'mutation-no-approval'  // mutate/destructive action invoked but no approval callback wired
  | 'mutation-rejected'     // user declined the approval prompt
  | 'verify-failed';        // mutation executed but the verify step rejected the result

/**
 * Snapshot of a proposed mutation, sent to the human approver. The approver
 * receives the verbatim command, plus the dry-run output and pre-state
 * snapshot the action emitted. They decide:
 *
 *   - approve-once       run this proposal exactly once, no rule persisted
 *   - approve-remember   like once + persist an env-scoped allowlist rule
 *                        so the same (action, args shape) auto-approves
 *                        on this environment next time. The executor
 *                        IGNORES "remember" for destructive-tier actions
 *                        regardless — destructive is always fresh.
 *   - reject             refuse the proposal; no execution, no rule.
 */
export interface MutationProposal {
  readonly actionName: string;
  readonly tier: 'mutate' | 'destructive';
  readonly args: unknown;
  readonly commandScrubbed: string;
  readonly snapshotOutput?: string;
  readonly dryRunOutput?: string;
  readonly environment?: Environment;
}

export type MutationDecision =
  | { readonly kind: 'approve-once' }
  | { readonly kind: 'approve-remember' }
  | { readonly kind: 'reject'; readonly reason?: string };

export type MutationApprovalCallback = (
  proposal: MutationProposal,
) => Promise<MutationDecision>;

export interface ExecContext {
  readonly sessionId: SessionId;
  readonly timeoutMs?: number;
  readonly environment?: Environment;
}

export interface ExecResult {
  readonly auditId: AuditLogId;
  readonly evidenceId: EvidenceId;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  /**
   * Populated only for mutate/destructive executions that actually ran.
   * Read-tier results omit these fields entirely.
   */
  readonly mutation?: MutationExecMeta;
}

export interface MutationExecMeta {
  /** Output of `buildSnapshotCommand` (if action provided one). Scrubbed. */
  readonly snapshotOutput?: string;
  /** Output of `buildDryRunCommand` (if action provided one). Scrubbed. */
  readonly dryRunOutput?: string;
  /** True if the user picked "approve-remember"; ignored for destructive. */
  readonly remembered: boolean;
  /** Exit code of the verify command, if a verify hook ran. */
  readonly verifyExitCode?: number;
  /** Verify command's stdout/stderr, scrubbed. */
  readonly verifyOutput?: string;
  /** True if rollback fired (only possible after verify failure). */
  readonly rolledBack: boolean;
  /** Rollback command's stdout/stderr, scrubbed. */
  readonly rollbackOutput?: string;
}

export interface ExecErrorOptions {
  readonly reason: RefuseReason;
  readonly actionName: string;
  readonly message: string;
  readonly auditId?: AuditLogId;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class ExecError extends Error {
  readonly reason: RefuseReason;
  readonly actionName: string;
  readonly auditId: AuditLogId | undefined;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(opts: ExecErrorOptions) {
    super(opts.message);
    this.name = 'ExecError';
    this.reason = opts.reason;
    this.actionName = opts.actionName;
    this.auditId = opts.auditId;
    this.details = opts.details ?? {};
  }
}

const SHELL_SAFE_TOKEN = /^[A-Za-z0-9_./@:=+-]+$/;

export function argvToShell(argv: readonly string[]): string {
  return argv
    .map((arg) => {
      if (arg === '') return `''`;
      if (SHELL_SAFE_TOKEN.test(arg)) return arg;
      return `'${arg.replace(/'/g, `'\\''`)}'`;
    })
    .join(' ');
}
