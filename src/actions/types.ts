import type { z } from 'zod';

import type { Environment } from '../environments/types.ts';
import type { SessionId } from '../memory/types.ts';
import type { Elevation } from '../security/elevation.ts';

export type Tier = 'read' | 'mutate' | 'destructive';

export const ALL_TIERS: readonly Tier[] = ['read', 'mutate', 'destructive'];

export interface ActionExecContext {
  readonly sessionId: SessionId;
  readonly environment?: Environment;
  /**
   * Effective privilege elevation for THIS invocation, decided by the Executor
   * (action's defaultElevation, a session-remembered rule, or a reactive sudo
   * re-run). Actions route their elevatable command through
   * `elevateRemoteCommand(inner, ctx.elevation ?? 'none')`. Undefined = 'none'.
   */
  readonly elevation?: Elevation;
}

export interface RawExecOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * An Action is one entry in the catalog. `read` actions just execute. `mutate`
 * and `destructive` actions also expose optional hooks that drive the
 * human-in-the-loop flow:
 *
 *   1. `buildSnapshotCommand` — capture state ROLLBACK will need (e.g. current
 *      image tag). Runs read-only, before anything else, no user prompt.
 *   2. `buildDryRunCommand`   — render the diff/plan the user will approve.
 *      Runs read-only. Output is shown verbatim in the approval panel.
 *   3. (user approval)        — TUI shows verbatim command + dry-run output;
 *      user picks approve-once / approve-and-remember-for-env / reject.
 *   4. `buildCommand`         — the actual mutation. Same shape as read-tier.
 *   5. `buildVerifyCommand`   — check the mutation landed correctly. Runs
 *      read-only. Non-zero exit triggers rollback.
 *   6. `buildRollbackCommand` — undo, given the snapshot from step 1. Runs
 *      only on verify failure (or explicit user /undo).
 *
 * All hooks are optional. A `mutate` action without `buildDryRunCommand` is
 * legal but the approval panel will show "no preview available" — discouraged.
 * `destructive` actions SHOULD always provide at least a dry-run; the
 * approval flow enforces fresh confirmation per call regardless.
 */
export interface Action<Args = unknown, Result = unknown> {
  readonly name: string;
  readonly tier: Tier;
  /**
   * The elevation this action needs by default (e.g. iptables → 'sudo'). The
   * Executor proposes it; it is still gated. Omitted = none.
   */
  readonly defaultElevation?: Elevation;
  readonly description: string;
  readonly argsSchema: z.ZodType<Args>;
  buildCommand(args: Args, ctx: ActionExecContext): readonly string[];
  parseResult(raw: RawExecOutput, args: Args): Result;

  /**
   * Read-only snapshot of pre-mutation state. The stdout is handed to
   * `buildRollbackCommand` later as `preState`. Skip if rollback doesn't
   * depend on pre-state (e.g. `service.restart` — re-restart has no
   * meaningful undo).
   */
  buildSnapshotCommand?(args: Args, ctx: ActionExecContext): readonly string[];

  /**
   * Read-only preview of what the mutation WILL do. Use the underlying CLI's
   * --dry-run flag when available (`kubectl --dry-run=server`, `helm
   * --dry-run`, `docker compose config`, ...). The output is the diff the
   * user reads before approving.
   */
  buildDryRunCommand?(args: Args, ctx: ActionExecContext): readonly string[];

  /**
   * Read-only check that the mutation landed correctly. Examples:
   *   - `systemctl is-active <unit>` after `service.restart`
   *   - `docker compose ps` returning all services in `running` state
   *   - HTTP 200 on the health endpoint
   * Non-zero exit → executor invokes rollback automatically.
   */
  buildVerifyCommand?(args: Args, ctx: ActionExecContext): readonly string[];

  /**
   * Undo command, given the snapshot captured before execute. Returns
   * `null` if rollback isn't representable (in which case verify failure
   * surfaces as a hard error and the user must intervene by hand).
   */
  buildRollbackCommand?(
    args: Args,
    ctx: ActionExecContext,
    preState: string,
  ): readonly string[] | null;
}
