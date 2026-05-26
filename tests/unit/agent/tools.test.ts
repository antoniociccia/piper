import { describe, expect, test } from 'bun:test';

import { actionToToolDef, catalogToToolDefs } from '../../../src/agent/tools.ts';
import { BUILTIN_ACTIONS, registerBuiltins } from '../../../src/actions/builtin/index.ts';
import { createCatalog } from '../../../src/actions/catalog.ts';

describe('agent/tools', () => {
  test('every builtin action converts to a ToolDefinition with name + description + parameters', () => {
    for (const action of BUILTIN_ACTIONS) {
      const def = actionToToolDef(action);
      expect(def.name).toBe(action.name);
      expect(def.description).toBe(action.description);
      expect(def.parameters).toBeDefined();
      expect((def.parameters as { type?: string }).type).toBe('object');
    }
  });

  test('catalogToToolDefs returns one definition per registered action', () => {
    const catalog = createCatalog();
    registerBuiltins(catalog);
    const defs = catalogToToolDefs(catalog);
    expect(defs).toHaveLength(BUILTIN_ACTIONS.length);
    const names = defs.map((d) => d.name).sort();
    const expected = BUILTIN_ACTIONS.map((a) => a.name).sort();
    expect(names).toEqual(expected);
  });

  test('parameters object surfaces argsSchema fields (environment, path, etc)', () => {
    const catalog = createCatalog();
    registerBuiltins(catalog);
    const defs = catalogToToolDefs(catalog);
    const tail = defs.find((d) => d.name === 'logs.tail');
    expect(tail).toBeDefined();
    const params = tail?.parameters as { properties?: Record<string, unknown> };
    expect(params.properties?.['environment']).toBeDefined();
    expect(params.properties?.['path']).toBeDefined();
    expect(params.properties?.['lines']).toBeDefined();
  });
});
