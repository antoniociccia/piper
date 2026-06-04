import { describe, expect, test } from 'bun:test';

import { createCatalog } from '../../../src/actions/catalog.ts';
import { registerBuiltins } from '../../../src/actions/builtin/index.ts';
import { parseSkill, validateSkillAgainstCatalog } from '../../../src/skills/loader.ts';
import { STOCK_SKILLS, DEFAULT_SKILL_NAME } from '../../../src/skills/stock.ts';

const catalog = (() => {
  const c = createCatalog();
  registerBuiltins(c);
  return c;
})();

describe('stock skills', () => {
  test('every stock skill parses and validates against the catalog', () => {
    for (const s of STOCK_SKILLS) {
      const parsed = parseSkill(s.text, 'stock');
      expect(() => validateSkillAgainstCatalog(parsed, catalog)).not.toThrow();
    }
  });

  test('the default skill is present and named', () => {
    const names = STOCK_SKILLS.map((s) => parseSkill(s.text, 'stock').name);
    expect(names).toContain(DEFAULT_SKILL_NAME);
  });
});
