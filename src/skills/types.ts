import { z } from 'zod';

export class InvalidSkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSkillError';
  }
}

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** A single extra read action a skill runs in addition to the baseline. */
const extraActionSchema = z.object({
  action: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
});

/** Stack signature for the (M3) deterministic matcher. Parsed now, used later. */
const matchSchema = z
  .object({
    files: z.array(z.string()).optional(),
    compose_services: z.array(z.string()).optional(),
    k8s_namespaces: z.array(z.string()).optional(),
    ports: z.array(z.number().int()).optional(),
    images: z.array(z.string()).optional(),
  })
  .optional();

export const skillFrontmatterSchema = z.object({
  skill: z.string().regex(SKILL_NAME_PATTERN, 'lowercase, digits and dashes only'),
  description: z.string().min(1).optional(),
  match: matchSchema,
  /** Container/service names whose logs the orchestrator tails for this skill. */
  extra_logs: z.array(z.string()).optional(),
  /** Extra read actions (validated against the catalog at load). */
  extra_actions: z.array(extraActionSchema).optional(),
  /** Prose hints injected into the (M4) drill phase. */
  focus: z.array(z.string()).optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
export type SkillSource = 'stock' | 'user';

export interface SkillExtraAction {
  readonly action: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface SkillMatch {
  readonly files: readonly string[];
  readonly composeServices: readonly string[];
  readonly k8sNamespaces: readonly string[];
  readonly ports: readonly number[];
  readonly images: readonly string[];
}

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly match: SkillMatch;
  readonly extraLogs: readonly string[];
  readonly extraActions: readonly SkillExtraAction[];
  readonly focus: readonly string[];
  readonly runbook: string;
  readonly source: SkillSource;
}
