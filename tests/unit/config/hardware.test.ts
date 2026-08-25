import { describe, expect, test } from 'bun:test';

import { LOCAL_MODEL_LADDER, recommendLocalModel } from '../../../src/config/hardware.ts';

/**
 * PIPER used to dead-end a first run: it detected Ollama, found no models, and
 * told the user to quit, run `ollama pull qwen3-coder:30b` themselves and start
 * over — suggesting an 18 GB download without knowing whether the machine had
 * the memory for it.
 *
 * The ladder only contains models measured against PIPER's own analyze flow.
 * Recommending something unmeasured would be guessing on the user's disk.
 */

const GB = 1024 ** 3;

describe('local model recommendation', () => {
  test('a 16 GB laptop gets the 9b', () => {
    const r = recommendLocalModel(16 * GB);
    expect(r.model?.tag).toBe('qwen3.5:9b');
  });

  test('an 8 GB laptop gets the 4b, not the 9b', () => {
    const r = recommendLocalModel(8 * GB);
    expect(r.model?.tag).toBe('qwen3.5:4b');
  });

  test('32 GB still gets the 9b — the 27b wants headroom this machine has not got', () => {
    // 17 GB of weights on a 32 GB machine leaves 15 GB for the OS, a browser,
    // Docker and PIPER itself. It technically fits and then swaps, which the
    // user experiences as the tool being broken rather than as a tight fit.
    const r = recommendLocalModel(32 * GB);
    expect(r.model?.tag).toBe('qwen3.5:9b');
  });

  test('a real workstation gets the largest measured model', () => {
    expect(recommendLocalModel(64 * GB).model?.tag).toBe('qwen3.5:27b');
  });

  test('the recommendation never exceeds the usable memory budget', () => {
    for (const totalGb of [4, 6, 8, 12, 16, 24, 32, 64, 128]) {
      const r = recommendLocalModel(totalGb * GB);
      if (r.model === null) continue;
      expect(r.model.sizeBytes).toBeLessThanOrEqual(r.usableBytes);
    }
  });

  test('a machine too small for even the floor model gets nothing, and says why', () => {
    const r = recommendLocalModel(4 * GB);
    expect(r.model).toBeNull();
    expect(r.reason).toMatch(/memory/i);
  });

  test('an unknown memory size falls back to the floor model rather than guessing big', () => {
    const r = recommendLocalModel(null);
    expect(r.model?.tag).toBe('qwen3.5:4b');
  });

  test('more memory never recommends a smaller model', () => {
    let previous = -1;
    for (const totalGb of [8, 12, 16, 24, 32, 64]) {
      const size = recommendLocalModel(totalGb * GB).model?.sizeBytes ?? 0;
      expect(size).toBeGreaterThanOrEqual(previous);
      previous = size;
    }
  });

  test('every rung carries the measurement that justifies it', () => {
    for (const rung of LOCAL_MODEL_LADDER) {
      expect(rung.tag).toContain(':');
      expect(rung.sizeBytes).toBeGreaterThan(0);
      expect(rung.minTotalBytes).toBeGreaterThan(rung.sizeBytes);
      expect(rung.note.length).toBeGreaterThan(0);
    }
  });

  test('the ladder is ordered smallest first', () => {
    const sizes = LOCAL_MODEL_LADDER.map((r) => r.sizeBytes);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });
});
