import { describe, expect, test } from 'bun:test';

import { createCatalog } from '../../../src/actions/catalog.ts';
import { registerBuiltins } from '../../../src/actions/builtin/index.ts';
import { parseSkill, validateSkillAgainstCatalog } from '../../../src/skills/loader.ts';
import { InvalidSkillError } from '../../../src/skills/types.ts';

const catalog = (() => {
  const c = createCatalog();
  registerBuiltins(c);
  return c;
})();

const DOC = `---
skill: sample
description: a sample skill
match:
  compose_services: ["redis"]
extra_logs: ["redis"]
focus:
  - "look at redis"
---
# Runbook
Redis down → trouble.
`;

describe('parseSkill', () => {
  test('parses frontmatter + runbook body', () => {
    const s = parseSkill(DOC, 'user');
    expect(s.name).toBe('sample');
    expect(s.description).toBe('a sample skill');
    expect(s.match.composeServices).toEqual(['redis']);
    expect(s.extraLogs).toEqual(['redis']);
    expect(s.focus).toEqual(['look at redis']);
    expect(s.runbook).toContain('Redis down');
    expect(s.source).toBe('user');
  });

  test('rejects a file not starting with frontmatter', () => {
    expect(() => parseSkill('no frontmatter here', 'user')).toThrow(InvalidSkillError);
  });

  test('rejects an invalid skill name', () => {
    const bad = '---\nskill: Not_Valid\n---\nbody';
    expect(() => parseSkill(bad, 'user')).toThrow(InvalidSkillError);
  });
});

describe('validateSkillAgainstCatalog', () => {
  test('accepts a skill with no extra_actions', () => {
    const s = parseSkill(DOC, 'user');
    expect(() => validateSkillAgainstCatalog(s, catalog)).not.toThrow();
  });

  test('rejects an extra_action that is not in the catalog', () => {
    const doc = `---
skill: bad
extra_actions:
  - action: does.not_exist
    args: { environment: demo }
---
body`;
    const s = parseSkill(doc, 'user');
    expect(() => validateSkillAgainstCatalog(s, catalog)).toThrow(/not in catalog/);
  });

  test('rejects an extra_action that is a mutate-tier action', () => {
    const doc = `---
skill: bad
extra_actions:
  - action: docker.compose_restart
    args: { environment: demo, project_dir: /opt/app }
---
body`;
    const s = parseSkill(doc, 'user');
    expect(() => validateSkillAgainstCatalog(s, catalog)).toThrow(/read-tier/);
  });
});
