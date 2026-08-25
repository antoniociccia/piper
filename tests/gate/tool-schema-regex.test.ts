import { describe, expect, test } from 'bun:test';

import { registerBuiltins } from '../../src/actions/builtin/index.ts';
import { createCatalog } from '../../src/actions/catalog.ts';
import { actionToToolDef } from '../../src/agent/tools.ts';

/**
 * Tool schemas are handed verbatim to local inference servers. llama.cpp
 * converts every `pattern` into a GBNF grammar before sampling, and its
 * json-schema-to-grammar converter rejects REDUNDANT escapes — a backslash in
 * front of a character that is not special in that position. Measured against
 * llama.cpp b9960:
 *
 *   inside [...]   `\\` ok, `\xNN` ok — `\-` `\.` `\/` `\+` `\w` `\d` all fail
 *   outside [...]  `\.` ok (the dot IS a metacharacter there) — `\-` `\/` fail
 *
 * A single offending schema makes the server answer HTTP 400 to EVERY request,
 * so one bad pattern bricks the whole catalog for llama.cpp users.
 *
 * The offending escapes are redundant by definition, so removing them preserves
 * behaviour. MOVING a dash out of the middle of a class does not — see the
 * second describe block.
 */

const catalog = createCatalog();
registerBuiltins(catalog);

/** Every `pattern` string anywhere in a JSON schema, with the path that holds it. */
function collectPatterns(node: unknown, path: string, out: { path: string; pattern: string }[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectPatterns(item, `${path}[${i}]`, out));
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'pattern' && typeof value === 'string') {
      out.push({ path, pattern: value });
    } else {
      collectPatterns(value, `${path}.${key}`, out);
    }
  }
}

/** Escapes llama.cpp's grammar converter refuses. Empty means the pattern is safe. */
function unsupportedEscapes(pattern: string): string[] {
  const found: string[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1] ?? '';
      const escape = `\\${next}`;
      // `\\` (literal backslash) and `\xNN` (hex) convert cleanly everywhere.
      const alwaysSafe = next === '\\' || next === 'x';
      // Outside a class the dot is a metacharacter, so escaping it is meaningful.
      const meaningfulOutsideClass = !inClass && next === '.';
      if (!alwaysSafe && !meaningfulOutsideClass) found.push(escape);
      i += 1; // skip the escaped character
      continue;
    }
    if (ch === '[' && !inClass) inClass = true;
    else if (ch === ']' && inClass) inClass = false;
  }
  return found;
}

describe('tool schemas are llama.cpp grammar-safe', () => {
  test('no action schema uses a redundant regex escape', () => {
    const offenders: string[] = [];

    for (const action of catalog.list()) {
      const def = actionToToolDef(action);
      const patterns: { path: string; pattern: string }[] = [];
      collectPatterns(def.parameters, action.name, patterns);

      for (const { path, pattern } of patterns) {
        const escapes = unsupportedEscapes(pattern);
        if (escapes.length > 0) {
          offenders.push(`${path}: /${pattern}/ contains ${[...new Set(escapes)].join(', ')}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  test('the detector recognises exactly what llama.cpp b9960 accepts', () => {
    // Safe — measured OK against a live llama.cpp server.
    expect(unsupportedEscapes(String.raw`^[a\\]+$`)).toEqual([]);
    expect(unsupportedEscapes(String.raw`^[\x41-\x5a]+$`)).toEqual([]);
    expect(unsupportedEscapes(String.raw`^[^\\"\x00-\x1f\x7f]*$`)).toEqual([]);
    expect(unsupportedEscapes(String.raw`^a\.b$`)).toEqual([]);
    // Rejected — measured HTTP 400 against the same server.
    expect(unsupportedEscapes(String.raw`^[a\-]+$`)).toEqual([String.raw`\-`]);
    expect(unsupportedEscapes(String.raw`^[a\.]+$`)).toEqual([String.raw`\.`]);
    expect(unsupportedEscapes(String.raw`^[a\w]+$`)).toEqual([String.raw`\w`]);
    expect(unsupportedEscapes(String.raw`^s3:\/\/x$`)).toEqual([String.raw`\/`, String.raw`\/`]);
  });
});

/**
 * Behaviour guards. Dropping a backslash is safe ONLY when the dash already
 * sits at the end of the class. Where it sits in the middle — `[.\-_]`,
 * `[9\-.]`, `[_\-+]` — deleting the backslash turns it into a RANGE:
 * `[.-_]` silently admits `; < = > ? @ [ \ ] ^` and the whole A-Z block.
 * These tests fail loudly if a fix widens a validation pattern.
 */
describe('validation patterns still reject shell/injection metacharacters', () => {
  const schemaFor = (name: string) => {
    const action = catalog.list().find((a) => a.name === name);
    if (action === undefined) throw new Error(`action not in catalog: ${name}`);
    return action.argsSchema;
  };

  test('kubectl.get label_selector rejects characters inside the . to _ range', () => {
    const schema = schemaFor('kubectl.get');
    // `;` `<` `>` `?` `@` `[` `\` `^` all live between `.` (0x2E) and `_` (0x5F).
    for (const bad of ['app;rm -rf /', 'app\\x', 'app^y', 'app<y', 'app@y', 'app[y]']) {
      expect(
        schema.safeParse({ environment: 'e', resource: 'pods', label_selector: bad }).success,
      ).toBe(false);
    }
    expect(
      schema.safeParse({ environment: 'e', resource: 'pods', label_selector: 'app=web,tier!=db' })
        .success,
    ).toBe(true);
  });

  test('network.dns_lookup hostname accepts dots and dashes, rejects metacharacters', () => {
    const schema = schemaFor('network.dns_lookup');
    expect(schema.safeParse({ environment: 'e', hostname: 'api.example-1.com' }).success).toBe(true);
    for (const bad of ['api;rm', 'api$(id)', 'api|cat', 'api&x', 'api/x']) {
      expect(schema.safeParse({ environment: 'e', hostname: bad }).success).toBe(false);
    }
  });

  test('system.package_list filter accepts +, ., - and rejects metacharacters', () => {
    const schema = schemaFor('system.package_list');
    expect(schema.safeParse({ environment: 'e', filter: 'libstdc++-12.dev' }).success).toBe(true);
    for (const bad of ['pkg;id', 'pkg`id`', 'pkg$(id)', 'pkg/x']) {
      expect(schema.safeParse({ environment: 'e', filter: bad }).success).toBe(false);
    }
  });

  test('aws.s3_ls uri stays anchored to s3:// and rejects metacharacters', () => {
    const schema = schemaFor('aws.s3_ls');
    expect(schema.safeParse({ environment: 'e', uri: 's3://my-bucket/some.prefix/' }).success).toBe(
      true,
    );
    for (const bad of ['s3://bucket;id', 's3://bucket$(id)', 'https://evil.com', 's3://bu cket']) {
      expect(schema.safeParse({ environment: 'e', uri: bad }).success).toBe(false);
    }
  });

  test('git.status repo accepts safe paths and rejects metacharacters', () => {
    const schema = schemaFor('git.status');
    expect(schema.safeParse({ environment: 'e', repo: '/opt/my-app_1.2' }).success).toBe(true);
    for (const bad of ['/opt/app;id', '/opt/$(id)', '/opt/app|x', '/opt/app x']) {
      expect(schema.safeParse({ environment: 'e', repo: bad }).success).toBe(false);
    }
  });
});
