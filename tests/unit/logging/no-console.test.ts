import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dir, '../../..');

interface Offense {
  readonly file: string;
  readonly line: number;
  readonly content: string;
}

const CONSOLE_PATTERN = /(^|[^.\w])console\s*\./;

async function scanForConsole(): Promise<Offense[]> {
  const glob = new Glob('src/**/*.{ts,tsx}');
  const offenses: Offense[] = [];

  for await (const relPath of glob.scan({ cwd: PROJECT_ROOT })) {
    const fullPath = resolve(PROJECT_ROOT, relPath);
    const content = await Bun.file(fullPath).text();
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      if (CONSOLE_PATTERN.test(line)) {
        offenses.push({ file: relPath, line: i + 1, content: line.trim() });
      }
    }
  }

  return offenses;
}

describe('logging/no-console — src/ must not use console.*', () => {
  test('no console.log / console.warn / etc. in src/', async () => {
    const offenses = await scanForConsole();
    if (offenses.length > 0) {
      const message = offenses
        .map((o) => `  ${o.file}:${o.line}: ${o.content}`)
        .join('\n');
      throw new Error(
        `forbidden console.* usage in src/ (use the structured logger instead):\n${message}`,
      );
    }
    expect(offenses).toEqual([]);
  });

  test('the scanner can spot a planted console.log (sanity check)', () => {
    const planted = '  console.log("oops")';
    expect(CONSOLE_PATTERN.test(planted)).toBe(true);
  });

  test('the scanner does NOT flag innocent words containing "console"', () => {
    expect(CONSOLE_PATTERN.test('// the consoler module is fine')).toBe(false);
    expect(CONSOLE_PATTERN.test('const myconsole = "x"')).toBe(false);
    expect(CONSOLE_PATTERN.test('// see the console for output')).toBe(false);
  });
});
