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

/**
 * The fallback model matters more than it looks: it is what a user gets when
 * they point PIPER at a local server without naming a model. The value shipped
 * before this test was `mistralai/devstral-small-2-24b` — an OpenRouter-style
 * id, not a tag any local runtime can resolve. Ollama answered
 * `model 'mistralai/devstral-small-2-24b' not found`, so the very first
 * request of a fresh local setup failed.
 */
describe('providers — default model', () => {
  test('every local provider names a model its runtime can actually resolve', () => {
    for (const id of LOCAL_PROVIDERS) {
      const model = PROVIDERS[id].defaultModel;
      expect(model).toBeTruthy();
      // A vendor-prefixed path is an aggregator id (OpenRouter), never a local tag.
      expect(model).not.toContain('/');
    }
  });

  test('the remote default is a vendor-qualified aggregator id', () => {
    expect(PROVIDERS.openrouter.defaultModel).toContain('/');
  });

  test('custom endpoints get no model guess', () => {
    expect(PROVIDERS.custom.defaultModel).toBeNull();
  });
});
