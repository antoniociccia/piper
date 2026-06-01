import { describe, expect, test } from 'bun:test';

import { formatDownloadProgress } from '../../../src/tui/boot-loader-controller.ts';

describe('tui/boot-loader-controller — formatDownloadProgress', () => {
  test('renders a bar, percentage, and sizes when loaded/total are known', () => {
    // 60 MB of 120 MB → 50%
    const line = formatDownloadProgress('model_quantized.onnx', 60 * 1_048_576, 120 * 1_048_576);
    expect(line).toContain('model_quantized.onnx');
    expect(line).toContain('50%');
    expect(line).toContain('60.0 / 120.0 MB');
    expect(line).toContain('█');
    expect(line).toContain('░');
  });

  test('a complete download renders a full bar at 100%', () => {
    const line = formatDownloadProgress('tokenizer.json', 1000, 1000);
    expect(line).toContain('100%');
    expect(line).not.toContain('░');
  });

  test('an empty download renders an empty bar at 0%', () => {
    const line = formatDownloadProgress('config.json', 0, 1000);
    expect(line).toContain('0%');
    expect(line).not.toContain('█');
  });

  test('falls back to the plain filename when total is unknown', () => {
    expect(formatDownloadProgress('model.onnx')).toBe('downloading model.onnx');
    expect(formatDownloadProgress('model.onnx', 500)).toBe('downloading model.onnx');
    expect(formatDownloadProgress('model.onnx', 500, 0)).toBe('downloading model.onnx');
  });

  test('caps the percentage at 100 even if loaded overshoots total', () => {
    const line = formatDownloadProgress('model.onnx', 2000, 1000);
    expect(line).toContain('100%');
    expect(line).not.toContain('200%');
  });
});
