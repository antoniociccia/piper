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
  | 'execution-failed';

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
