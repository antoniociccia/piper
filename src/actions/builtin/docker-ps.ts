import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  all: z.boolean().optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface DockerContainer {
  readonly id: string;
  readonly image: string;
  readonly name: string;
  readonly state: string;
  readonly status: string;
}

export const dockerPs: Action<Args, readonly DockerContainer[]> = {
  name: 'docker.ps',
  tier: 'read',
  description:
    'List Docker containers on the remote environment (`docker ps`, JSON output). Set `all: true` to include stopped containers (`docker ps -a`).',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const cmd = ['docker', 'ps', '--format', 'json'];
    if (args.all === true) cmd.splice(2, 0, '-a');
    return buildSshArgvForEnv(env, cmd);
  },
  parseResult: (raw) => {
    const out: DockerContainer[] = [];
    for (const line of raw.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        out.push({
          id: String(parsed['ID'] ?? parsed['Id'] ?? ''),
          image: String(parsed['Image'] ?? ''),
          name: String(parsed['Names'] ?? parsed['Name'] ?? ''),
          state: String(parsed['State'] ?? ''),
          status: String(parsed['Status'] ?? ''),
        });
      } catch {
        // skip malformed line
      }
    }
    return out;
  },
};
