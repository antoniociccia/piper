import type { z } from 'zod';

import type { Environment } from '../environments/types.ts';
import type { SessionId } from '../memory/types.ts';

export type Tier = 'read' | 'mutate' | 'destructive';

export const ALL_TIERS: readonly Tier[] = ['read', 'mutate', 'destructive'];

export interface ActionExecContext {
  readonly sessionId: SessionId;
  readonly environment?: Environment;
}

export interface RawExecOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface Action<Args = unknown, Result = unknown> {
  readonly name: string;
  readonly tier: Tier;
  readonly description: string;
  readonly argsSchema: z.ZodType<Args>;
  buildCommand(args: Args, ctx: ActionExecContext): readonly string[];
  parseResult(raw: RawExecOutput, args: Args): Result;
}
