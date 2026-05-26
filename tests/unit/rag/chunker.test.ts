import { describe, expect, test } from 'bun:test';

import { chunkMarkdown, hashContent } from '../../../src/rag/chunker.ts';

describe('rag/chunker', () => {
  test('splits at H1/H2/H3 boundaries, tracking heading path', () => {
    const md = `# Title
Intro paragraph.

## Section A
A body.

### Sub A1
nested.

## Section B
B body.`;
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(4);
    expect(chunks[0]?.headingPath).toBe('Title');
    expect(chunks[0]?.content).toContain('Intro paragraph.');
    expect(chunks[1]?.headingPath).toBe('Title > Section A');
    expect(chunks[2]?.headingPath).toBe('Title > Section A > Sub A1');
    expect(chunks[3]?.headingPath).toBe('Title > Section B');
  });

  test('drops empty leading content (just heading and nothing under it)', () => {
    const md = `# Empty\n\n## A\nbody`;
    const chunks = chunkMarkdown(md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.headingPath).toBe('Empty > A');
  });

  test('sub-splits oversized chunks on paragraph boundaries', () => {
    const para = 'word '.repeat(600); // ~3000 chars
    const md = `# T\n\n${para}\n\n${para}`;
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(2500);
    }
  });

  test('hashContent is sha256 hex, deterministic', async () => {
    const a = await hashContent('hello');
    const b = await hashContent('hello');
    const c = await hashContent('hellp');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
