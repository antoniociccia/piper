import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
  project: z.string().regex(/^[a-z0-9\-]+$/).optional(),
  zone: z.string().regex(/^[a-z0-9\-]+$/).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface GcloudComputeListResult {
  readonly raw: string;
}

export const gcloudComputeList: Action<Args, GcloudComputeListResult> = {
  name: 'gcloud.compute_list',
  tier: 'read',
  description:
    'Run `gcloud compute instances list` to see Compute Engine VMs (name, zone, status, internal/external IP). Uses the host\'s gcloud auth.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['gcloud', 'compute', 'instances', 'list'];
    if (args.project !== undefined) argv.push('--project', args.project);
    if (args.zone !== undefined) argv.push('--zones', args.zone);
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
