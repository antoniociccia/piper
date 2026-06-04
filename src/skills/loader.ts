import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { Catalog } from '../actions/catalog.ts';
import {
  InvalidSkillError,
  type Skill,
  type SkillSource,
  skillFrontmatterSchema,
} from './types.ts';

interface SplitResult {
  readonly frontmatterRaw: string;
  readonly body: string;
}

function splitFrontmatter(text: string): SplitResult {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new InvalidSkillError('skill file must start with a "---" frontmatter block');
  }
  const closing = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (closing === -1) {
    throw new InvalidSkillError('frontmatter block is not closed (missing second "---")');
  }
  return {
    frontmatterRaw: lines.slice(1, closing).join('\n'),
    body: lines.slice(closing + 1).join('\n').trim(),
  };
}

export function parseSkill(text: string, source: SkillSource): Skill {
  const { frontmatterRaw, body } = splitFrontmatter(text);

  let rawYaml: unknown;
  try {
    rawYaml = Bun.YAML.parse(frontmatterRaw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new InvalidSkillError(`frontmatter is not valid YAML: ${msg}`);
  }

  const parsed = skillFrontmatterSchema.safeParse(rawYaml);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new InvalidSkillError(`invalid skill frontmatter: ${issues}`);
  }
  const fm = parsed.data;

  return {
    name: fm.skill,
    description: fm.description ?? '',
    match: {
      files: fm.match?.files ?? [],
      composeServices: fm.match?.compose_services ?? [],
      k8sNamespaces: fm.match?.k8s_namespaces ?? [],
      ports: fm.match?.ports ?? [],
      images: fm.match?.images ?? [],
    },
    extraLogs: fm.extra_logs ?? [],
    extraActions: (fm.extra_actions ?? []).map((a) => ({ action: a.action, args: a.args })),
    focus: fm.focus ?? [],
    runbook: body,
    source,
  };
}

/** Read-only gate: every extra_action must exist in the catalog, be read-tier,
 *  and have args valid for that action. Mirrors validateAgainstCatalog for
 *  watch plans. */
export function validateSkillAgainstCatalog(skill: Skill, catalog: Catalog): void {
  for (const extra of skill.extraActions) {
    const action = catalog.resolve(extra.action);
    if (action === undefined) {
      throw new InvalidSkillError(
        `skill "${skill.name}": action "${extra.action}" is not in catalog`,
      );
    }
    if (action.tier !== 'read') {
      throw new InvalidSkillError(
        `skill "${skill.name}": action "${extra.action}" is ${action.tier}-tier — skills may only use read-tier actions`,
      );
    }
    const argsResult = action.argsSchema.safeParse(extra.args);
    if (!argsResult.success) {
      const issues = argsResult.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new InvalidSkillError(
        `skill "${skill.name}": invalid args for "${extra.action}": ${issues}`,
      );
    }
  }
}

export interface LoadedSkillEntry {
  readonly skill: Skill;
  readonly path: string;
}
export interface SkillLoadFailure {
  readonly path: string;
  readonly message: string;
}
export interface LoadSkillsResult {
  readonly skills: readonly LoadedSkillEntry[];
  readonly failures: readonly SkillLoadFailure[];
}

export async function loadSkillsFromDir(
  dir: string,
  catalog: Catalog,
): Promise<LoadSkillsResult> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return { skills: [], failures: [] };
  }

  const skills: LoadedSkillEntry[] = [];
  const failures: SkillLoadFailure[] = [];

  for (const entry of entries.filter((e) => e.endsWith('.md')).sort()) {
    const path = join(dir, entry);
    try {
      const text = await Bun.file(path).text();
      const skill = parseSkill(text, 'user');
      validateSkillAgainstCatalog(skill, catalog);
      skills.push({ skill, path });
    } catch (err) {
      failures.push({ path, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { skills, failures };
}

export function defaultSkillsDir(): string {
  return join(homedir(), '.piper', 'skills');
}
