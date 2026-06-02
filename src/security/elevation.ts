/** Privilege elevation for a single command invocation. Orthogonal to tier. */
export type Elevation = 'none' | 'sudo';

// Matches a `sudo` invocation as argv[0]: bare `sudo`, an absolute/relative
// path (`/usr/bin/sudo`), and any case. Keeps the idempotency check from being
// fooled by a full-path sudo, which would otherwise get double-wrapped.
const SUDO_TOKEN = /(?:^|\/)sudo$/i;

/**
 * The ONE place that prepends sudo to a remote command. Actions that accept an
 * elevatable command route the inner argv through here; the Executor uses the
 * same helper to re-validate the resolved command. Non-interactive `sudo -n`:
 * it never blocks on a password prompt — a host needing a password fails fast,
 * which the Executor detects and turns into a TTY-passthrough proposal.
 *
 * Idempotent: a command already invoking sudo as argv[0] (bare, full-path, any
 * case) is returned unchanged, so an action that hard-codes sudo plus
 * ctx.elevation can't double-wrap.
 */
export function elevateRemoteCommand(
  command: readonly string[],
  mode: Elevation,
): readonly string[] {
  if (mode === 'none' || command.length === 0) return command;
  const head = command[0];
  if (head !== undefined && SUDO_TOKEN.test(head)) return command;
  return ['sudo', '-n', ...command];
}

// ── Reactive-trigger signature matchers (deterministic, never LLM) ───────────

// Patterns are deliberately simple literal-ish regexes with no nested
// quantifiers, alternation of fixed strings only — zero catastrophic
// backtracking risk even on adversarial input (e.g. long log lines).
// Conservative on purpose: a false NEGATIVE only costs a missed sudo proposal
// (the user asks manually) — safe. A false POSITIVE would propose sudo on an
// unrelated failure — annoying. So these stay tightly privilege-specific; grow
// the list from real-world host telemetry, not speculation.
const PERMISSION_DENIED: ReadonlyArray<RegExp> = [
  /permission denied/i,
  /must be root/i,
  /are you root/i,
  /operation not permitted/i,
  /requires root/i,
  /insufficient privilege/i,
];

/**
 * True when a non-elevated command failed on a permission boundary, so the
 * Executor can propose a sudo re-run. Requires a non-zero exit AND a matching
 * stderr signature — a 0 exit is NEVER a permission failure.
 */
export function detectPermissionDenied(stderr: string, exitCode: number): boolean {
  if (exitCode === 0) return false;
  return PERMISSION_DENIED.some((re) => re.test(stderr));
}

const PASSWORD_REQUIRED: ReadonlyArray<RegExp> = [
  /a password is required/i,
  /a terminal is required/i,
  /no tty present/i,
];

/**
 * True when `sudo -n` refused because it needs a password / TTY. Used by the
 * Executor to offer a TTY-passthrough fallback (user enters password manually)
 * rather than a hard failure.
 */
export function detectSudoPasswordRequired(stderr: string): boolean {
  return PASSWORD_REQUIRED.some((re) => re.test(stderr));
}
