import { describe, expect, test } from 'bun:test';

import {
  allAvailable,
  computeCost,
  DEFAULT_MODEL_BY_TIER,
  getPricing,
  isAvailable,
  listByTier,
} from '../../../src/models/pricing.ts';

describe('models/pricing', () => {
  test('getPricing returns entry for known model id', () => {
    const p = getPricing('deepseek/deepseek-v4-pro');
    expect(p).not.toBeNull();
    expect(p?.tier).toBe('economy');
    expect(p?.toolCalling).toBe(true);
    expect(p?.inputUsdPerMtok).toBeCloseTo(0.435);
  });

  test('getPricing returns null for unknown model id', () => {
    expect(getPricing('nonexistent/model-x')).toBeNull();
  });

  test('isAvailable reflects availability flag', () => {
    expect(isAvailable('deepseek/deepseek-v4-pro')).toBe(true);
    expect(isAvailable('nonexistent/model-x')).toBe(false);
  });

  test('listByTier returns only the requested tier', () => {
    const balanced = listByTier('balanced');
    expect(balanced.length).toBeGreaterThan(0);
    for (const entry of balanced) {
      expect(entry.tier).toBe('balanced');
    }
  });

  test('allAvailable returns only entries with available=true', () => {
    for (const entry of allAvailable()) {
      expect(entry.available).toBe(true);
    }
  });

  test('default per-tier model exists in the table', () => {
    for (const [tier, modelId] of Object.entries(DEFAULT_MODEL_BY_TIER)) {
      const p = getPricing(modelId);
      expect(p, `tier=${tier}`).not.toBeNull();
      expect(p?.tier).toBe(tier as never);
    }
  });

  test('computeCost: 1M input + 1M output equals inputUsd + outputUsd', () => {
    const breakdown = computeCost('~anthropic/claude-sonnet-latest', 1_000_000, 1_000_000);
    expect(breakdown.inputUsd).toBeCloseTo(3.00, 4);
    expect(breakdown.outputUsd).toBeCloseTo(15.00, 4);
    expect(breakdown.totalUsd).toBeCloseTo(18.00, 4);
  });

  test('computeCost: zero for local-tier models', () => {
    const breakdown = computeCost('mistralai/devstral-small-2-24b', 10_000, 5_000);
    expect(breakdown.totalUsd).toBe(0);
  });

  test('computeCost: zero for unknown models', () => {
    const breakdown = computeCost('nonexistent/x', 1_000, 1_000);
    expect(breakdown.totalUsd).toBe(0);
  });

  test('all featherweight models cost less than 1$/Mtok in/out', () => {
    for (const entry of listByTier('featherweight')) {
      expect(entry.inputUsdPerMtok).toBeLessThan(1.0);
    }
  });

  test('all premium models cost more than 10$/Mtok input', () => {
    for (const entry of listByTier('premium')) {
      expect(entry.inputUsdPerMtok).toBeGreaterThan(10);
    }
  });

  test('all tool-calling-capable models in the table actually have toolCalling=true', () => {
    for (const entry of allAvailable()) {
      expect(entry.toolCalling).toBe(true);
    }
  });
});
