import { describe, expect, test } from 'bun:test';

import {
  getProvider,
  LOCAL_PROVIDERS,
  PROVIDERS,
  type ProviderId,
} from '../../../src/models/providers.ts';

describe('models/providers', () => {
  test('all six providers are present', () => {
    const expected: ProviderId[] = ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'openrouter', 'custom'];
    for (const id of expected) {
      expect(PROVIDERS[id]).toBeDefined();
      expect(PROVIDERS[id].id).toBe(id);
    }
  });

  test('all local providers have default base URLs on localhost', () => {
    for (const id of LOCAL_PROVIDERS) {
      const p = PROVIDERS[id];
      expect(p.kind).toBe('local');
      expect(p.defaultBaseUrl).toContain('localhost');
      expect(p.requiresApiKey).toBe(false);
    }
  });

  test('OpenRouter requires API key and enforces privacy-deny', () => {
    const or = PROVIDERS.openrouter;
    expect(or.kind).toBe('remote');
    expect(or.requiresApiKey).toBe(true);
    expect(or.enforcePrivacyDeny).toBe(true);
  });

  test('custom provider has no defaults', () => {
    const c = PROVIDERS.custom;
    expect(c.defaultBaseUrl).toBeNull();
    expect(c.defaultPort).toBeNull();
  });

  test('getProvider returns the same object as the PROVIDERS table', () => {
    expect(getProvider('ollama')).toBe(PROVIDERS.ollama);
  });

  test('local-providers list contains exactly the local ones', () => {
    expect([...LOCAL_PROVIDERS].sort()).toEqual(['llamacpp', 'lmstudio', 'ollama', 'vllm']);
  });
});
