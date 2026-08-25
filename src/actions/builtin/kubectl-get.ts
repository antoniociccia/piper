import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const SAFE_TOKEN = /^[A-Za-z0-9_.-]+$/;

const argsSchema = z.object({
  environment: z.string(),
  resource: z
    .string()
    .regex(SAFE_TOKEN, 'resource must be a kubectl resource name (e.g. pods, deploy, svc)')
    .min(1),
  namespace: z.string().regex(SAFE_TOKEN, 'namespace must be a safe k8s name').optional(),
  all_namespaces: z.boolean().optional(),
  name: z
    .string()
    .regex(SAFE_TOKEN, 'name must be a safe k8s object name')
    .optional(),
  label_selector: z
    .string()
    .regex(/^[A-Za-z0-9=,!._/-]+$/, 'label_selector must be a kubectl label selector')
    .optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface KubectlGetResult {
  readonly raw: string;
  readonly lines: number;
}

export const kubectlGet: Action<Args, KubectlGetResult> = {
  name: 'kubectl.get',
  tier: 'read',
  description:
    'Run `kubectl get <resource>` on the remote environment with optional namespace / name / label-selector. Read-only: returns the table kubectl prints.',
  argsSchema,
  buildCommand: (args, ctx) => {
    const env = requireEnv(ctx);
    const argv: string[] = ['kubectl', 'get', args.resource];
    if (args.name !== undefined) argv.push(args.name);
    if (args.all_namespaces === true) argv.push('-A');
    else if (args.namespace !== undefined) argv.push('-n', args.namespace);
    if (args.label_selector !== undefined) argv.push('-l', args.label_selector);
    argv.push('-o', 'wide');
    return buildSshArgvForEnv(env, argv);
  },
  parseResult: (raw) => {
    const text = raw.stdout.trim();
    const lines = text === '' ? 0 : text.split('\n').length;
    return { raw: text, lines };
  },
};
