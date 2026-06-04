import { describe, expect, test } from 'bun:test';

import { detectAnalyzeIntent } from '../../../src/agent/analyze-intent.ts';

describe('detectAnalyzeIntent', () => {
  test('matches "analizza demo" and extracts the named env', () => {
    expect(detectAnalyzeIntent('analizza demo', ['demo', 'staging'])).toEqual({ environment: 'demo' });
  });
  test('matches English "analyze staging"', () => {
    expect(detectAnalyzeIntent('analyze staging please', ['demo', 'staging'])).toEqual({ environment: 'staging' });
  });
  test('matches "audit" and "diagnose" verbs', () => {
    expect(detectAnalyzeIntent('audit demo', ['demo'])).toEqual({ environment: 'demo' });
    expect(detectAnalyzeIntent('diagnose the demo host', ['demo'])).toEqual({ environment: 'demo' });
  });
  test('defaults to the only env when none is named', () => {
    expect(detectAnalyzeIntent('analizza tutto', ['demo'])).toEqual({ environment: 'demo' });
  });
  test('returns null when analyze verb names no env and several exist', () => {
    expect(detectAnalyzeIntent('analizza tutto', ['demo', 'staging'])).toBeNull();
  });
  test('returns null for a non-analyze request', () => {
    expect(detectAnalyzeIntent('uptime di demo', ['demo'])).toBeNull();
  });
  test('returns null for a slash command', () => {
    expect(detectAnalyzeIntent('/watch demo', ['demo'])).toBeNull();
  });

  // Prefix-match fallback
  test('resolves a prefix of an env name ("singularity" -> "singularityhive")', () => {
    expect(detectAnalyzeIntent('analizza singularity e dammi i log', ['singularityhive', 'staging'])).toEqual({ environment: 'singularityhive' });
  });
  test('an ambiguous prefix (matches 2+ envs) does not resolve', () => {
    expect(detectAnalyzeIntent('analizza prod', ['prod-01', 'prod-02'])).toBeNull();
  });
  test('a too-short token does not prefix-match', () => {
    // "x" is <4 chars; with 2 envs and no whole-word/long-prefix match, stays null
    expect(detectAnalyzeIntent('analizza x', ['singularityhive', 'staging'])).toBeNull();
  });
});
