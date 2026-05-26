import type { ActionExecContext } from '../types.ts';
import type { Environment } from '../../environments/types.ts';

export function requireEnv(ctx: ActionExecContext): Environment {
  if (ctx.environment === undefined) {
    throw new Error('expected resolved environment in ctx (executor must populate from args.environment)');
  }
  return ctx.environment;
}
