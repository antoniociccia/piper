import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerBuiltins } from '../../../src/actions/builtin/index.ts';
import { createCatalog } from '../../../src/actions/catalog.ts';
import { loadSkillsFromDir } from '../../../src/skills/loader.ts';

const catalog = (() => {
  const c = createCatalog();
  registerBuiltins(c);
  return c;
})();

const tmpDirs: string[] = [];
async function makeDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'piper-skills-'));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf8');
  }
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('loadSkillsFromDir', () => {
  test('a missing directory returns empty, never throws', async () => {
    const result = await loadSkillsFromDir('/nonexistent/piper/skills/path', catalog);
    expect(result).toEqual({ skills: [], failures: [] });
  });

  test('loads a valid skill and ignores non-.md files', async () => {
    const dir = await makeDir({
      'web.md': '---\nskill: web\ndescription: a web skill\n---\nrunbook body',
      'README.txt': 'not a skill',
    });
    const result = await loadSkillsFromDir(dir, catalog);
    expect(result.failures).toEqual([]);
    expect(result.skills.map((s) => s.skill.name)).toEqual(['web']);
  });

  test('accumulates a per-file failure (never throws) for a mutate-referencing skill', async () => {
    const dir = await makeDir({
      'bad.md':
        '---\nskill: bad\nextra_actions:\n  - action: docker.compose_restart\n    args: { environment: demo, project_dir: /opt/app }\n---\nbody',
      'good.md': '---\nskill: good\n---\nbody',
    });
    const result = await loadSkillsFromDir(dir, catalog);
    expect(result.skills.map((s) => s.skill.name)).toEqual(['good']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toMatch(/read-tier/);
    expect(result.failures[0]?.path).toMatch(/bad\.md$/);
  });

  test('accumulates a failure for malformed frontmatter without throwing', async () => {
    const dir = await makeDir({ 'broken.md': 'no frontmatter at all' });
    const result = await loadSkillsFromDir(dir, catalog);
    expect(result.skills).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });
});
