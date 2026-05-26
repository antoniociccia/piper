import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  container: z.string().regex(/^[A-Za-z0-9_.-]+$/, 'container must be a safe id or name'),
});

type Args = z.infer<typeof argsSchema>;

export interface DockerInspectResult {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: Readonly<Record<string, unknown>>;
  readonly mounts: readonly Readonly<Record<string, unknown>>[];
  readonly networks: Readonly<Record<string, unknown>>;
  readonly raw: unknown;
}

export const dockerInspect: Action<Args, DockerInspectResult | null> = {
  name: 'docker.inspect',
  tier: 'read',
  description:
    'Return `docker inspect` JSON for a single container on the remote environment, summarised to state, mounts, and networks.',
  argsSchema,
  buildCommand: (args, ctx) => buildSshArgvForEnv(requireEnv(ctx), ['docker', 'inspect', args.container]),
  parseResult: (raw) => {
    try {
      const parsed = JSON.parse(raw.stdout) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      const first = parsed[0] as Record<string, unknown>;
      return {
        id: String(first['Id'] ?? ''),
        name: String(first['Name'] ?? ''),
        image: String((first['Config'] as Record<string, unknown> | undefined)?.['Image'] ?? ''),
        state: (first['State'] as Record<string, unknown>) ?? {},
        mounts: (Array.isArray(first['Mounts']) ? first['Mounts'] : []) as readonly Readonly<Record<string, unknown>>[],
        networks: ((first['NetworkSettings'] as Record<string, unknown> | undefined)?.['Networks'] as Record<string, unknown> | undefined) ?? {},
        raw: first,
      };
    } catch {
      return null;
    }
  },
};
