import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const PATH_PATTERN = /^[A-Za-z0-9_./-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  repo: z
    .string()
    .regex(PATH_PATTERN, 'repo must be a safe absolute or relative path')
    .min(1),
});

type Args = z.infer<typeof argsSchema>;

export interface GitStatusResult {
  readonly branch: string | null;
  readonly clean: boolean;
  readonly raw: string;
}

export const gitStatus: Action<Args, GitStatusResult> = {
  name: 'git.status',
  tier: 'read',
  description:
    'Run `git status --short --branch` in a remote repository to see branch, ahead/behind, and uncommitted changes. `repo` is the absolute path to the repo directory.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    return buildSshArgvForEnv(env, ['git', '-C', args.repo, 'status', '--short', '--branch']);
  },
  parseResult: (raw) => {
    const text = raw.stdout.trim();
    const lines = text.split('\n');
    const branchLine = lines[0] ?? '';
    const m = /^## (?:(.+?))(?:\.\.\.|\s|$)/.exec(branchLine);
    const branch = m === null ? null : m[1] ?? null;
    const dirty = lines.slice(1).some((l) => l.trim() !== '');
    return { branch, clean: !dirty, raw: text };
  },
};
