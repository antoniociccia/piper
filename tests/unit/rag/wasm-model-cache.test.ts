import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cacheKeyToRelativePath, createModelFileCache } from '../../../src/rag/wasm-model-cache.ts';

describe('rag/wasm-model-cache — cacheKeyToRelativePath', () => {
  test('maps a HuggingFace resolve URL to the bare model file path', () => {
    expect(
      cacheKeyToRelativePath(
        'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/onnx/model_quantized.onnx',
      ),
    ).toBe('Xenova/multilingual-e5-small/onnx/model_quantized.onnx');
  });

  test('maps a plain repo-relative key unchanged', () => {
    expect(cacheKeyToRelativePath('Xenova/multilingual-e5-small/tokenizer.json')).toBe(
      'Xenova/multilingual-e5-small/tokenizer.json',
    );
  });

  test('strips a leading /models/ local-path prefix', () => {
    expect(cacheKeyToRelativePath('/models/Xenova/multilingual-e5-small/config.json')).toBe(
      'Xenova/multilingual-e5-small/config.json',
    );
  });

  test('rejects path traversal segments', () => {
    expect(cacheKeyToRelativePath('../../../etc/passwd')).toBeNull();
    expect(cacheKeyToRelativePath('Xenova/../../../etc/passwd')).toBeNull();
  });

  test('URL dot-segments cannot escape the cache dir', () => {
    // The URL parser resolves ../ segments before we ever see them; whatever
    // survives must be a clean relative path (or rejected outright).
    const result = cacheKeyToRelativePath('https://huggingface.co/a/../../etc/passwd');
    expect(result === null || (!result.startsWith('..') && !result.startsWith('/'))).toBe(true);
  });

  test('rejects empty and absolute keys', () => {
    expect(cacheKeyToRelativePath('')).toBeNull();
    expect(cacheKeyToRelativePath('/etc/passwd')).toBeNull();
  });
});

describe('rag/wasm-model-cache — createModelFileCache', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'piper-model-cache-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('match returns undefined for a missing entry', async () => {
    const cache = createModelFileCache(dir);
    expect(await cache.match('Xenova/some-model/config.json')).toBeUndefined();
  });

  test('put then match round-trips the bytes', async () => {
    const cache = createModelFileCache(dir);
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    await cache.put(
      'https://huggingface.co/Xenova/m/resolve/main/onnx/model.onnx',
      new Response(body, { headers: { 'content-length': '5' } }),
    );

    const hit = await cache.match('https://huggingface.co/Xenova/m/resolve/main/onnx/model.onnx');
    expect(hit).toBeDefined();
    const bytes = new Uint8Array(await (hit as Response).arrayBuffer());
    expect([...bytes]).toEqual([1, 2, 3, 4, 5]);
    // content-length set so transformers.js can report download progress without a metadata round-trip
    expect((hit as Response).headers.get('content-length')).toBe('5');
  });

  test('match resolves across key aliases (URL vs repo-relative)', async () => {
    const cache = createModelFileCache(dir);
    await cache.put(
      'https://huggingface.co/Xenova/m/resolve/main/tokenizer.json',
      new Response(new Uint8Array([7, 7])),
    );
    // The same file requested via the repo-relative key form must hit.
    const hit = await cache.match('Xenova/m/tokenizer.json');
    expect(hit).toBeDefined();
  });

  test('put refuses traversal keys without writing anything', async () => {
    const cache = createModelFileCache(dir);
    await cache.put('../../escape', new Response(new Uint8Array([1])));
    expect(await cache.match('../../escape')).toBeUndefined();
  });

  test('reads pre-existing files laid out by the old node-build FileCache', async () => {
    // The pre-dfb8262 cache layout: <dir>/<repo>/<file> — written by transformers.js
    // node build. The custom cache must keep reading those (no re-download).
    const legacyPath = join(dir, 'Xenova/multilingual-e5-small/onnx/model_quantized.onnx');
    await Bun.write(legacyPath, new Uint8Array([9, 9, 9]));

    const cache = createModelFileCache(dir);
    const hit = await cache.match(
      'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/onnx/model_quantized.onnx',
    );
    expect(hit).toBeDefined();
    const bytes = new Uint8Array(await (hit as Response).arrayBuffer());
    expect([...bytes]).toEqual([9, 9, 9]);
  });
});
