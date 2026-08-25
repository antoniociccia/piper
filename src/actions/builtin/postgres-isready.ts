import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  host: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
  port: z.number().int().positive().max(65535).optional(),
  user: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface PostgresIsreadyResult {
  readonly raw: string;
  readonly accepting: boolean;
}

export const postgresIsready: Action<Args, PostgresIsreadyResult> = {
  name: 'postgres.pg_isready',
  tier: 'read',
  description:
    'Run `pg_isready` to check whether a PostgreSQL server is accepting connections. Default targets localhost:5432. Read-only health check, no credentials sent.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['pg_isready'];
    if (args.host !== undefined) argv.push('-h', args.host);
    if (args.port !== undefined) argv.push('-p', String(args.port));
    if (args.user !== undefined) argv.push('-U', args.user);
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => {
    const text = `${raw.stdout}\n${raw.stderr}`.trim();
    return { raw: text, accepting: /accepting connections/i.test(text) };
  },
};
