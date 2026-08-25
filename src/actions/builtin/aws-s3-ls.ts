import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

// Literal slashes are written as `[/]`, not `/` or `\/`. `RegExp#source` — which
// is what lands in the JSON schema we hand to the model — normalises a bare `/`
// outside a character class into `\/`, and llama.cpp's json-schema-to-grammar
// converter refuses that redundant escape, answering HTTP 400 to every request.
// Inside a class the slash needs no escape, so `[/]` survives the round-trip.
const S3_URI = new RegExp('^s3:[/][/][A-Za-z0-9._-]+([/][A-Za-z0-9._/-]*)?$');

const argsSchema = z.object({
  environment: z.string(),
  uri: z.string().regex(S3_URI, 'uri must be s3://bucket[/prefix]').optional(),
  profile: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  region: z.string().regex(/^[A-Za-z0-9-]+$/).optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface AwsS3LsResult {
  readonly raw: string;
}

export const awsS3Ls: Action<Args, AwsS3LsResult> = {
  name: 'aws.s3_ls',
  tier: 'read',
  description:
    'Run `aws s3 ls [uri]` to list buckets or objects. uri=s3://bucket/prefix is optional (default: list buckets). Uses the host\'s AWS CLI auth (~/.aws/credentials, IAM role, etc.) — PIPER never sees the keys.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['aws', 's3', 'ls'];
    if (args.uri !== undefined) argv.push(args.uri);
    if (args.profile !== undefined) argv.push('--profile', args.profile);
    if (args.region !== undefined) argv.push('--region', args.region);
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => ({ raw: raw.stdout.trim() }),
};
