import { join, normalize } from 'node:path';

/**
 * Filesystem-backed model cache for the transformers.js WEB build running in Bun.
 *
 * Why this exists: the web build ships with `node:fs` shimmed out, so its own
 * FileCache cannot work, and Bun has no browser Cache API — so with the web
 * build, NO cache is available and every boot re-downloads ~135 MB of model
 * assets. transformers.js supports `env.customCache` (Web Cache API shape:
 * `match` + `put`); this module implements it on top of Bun's file APIs,
 * reusing the same on-disk layout the old node-build FileCache used so
 * previously downloaded models keep working.
 */

export interface ModelFileCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

const RESOLVE_SEGMENT = /\/resolve\/[^/]+\//;

/**
 * Normalize the cache keys transformers.js uses (full HuggingFace resolve URLs,
 * `/models/...` local paths, or repo-relative paths) into one canonical
 * repo-relative path: `<org>/<model>/<file...>`.
 *
 * Returns null for keys that cannot be made safe (traversal, absolute paths
 * outside the recognized prefixes, empty).
 */
export function cacheKeyToRelativePath(key: string): string | null {
  if (key === '') return null;

  let path = key;

  // Full URL → keep only the pathname, collapse "/resolve/<revision>/".
  if (path.startsWith('https://') || path.startsWith('http://')) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  path = path.replace(RESOLVE_SEGMENT, '/');

  // Local-model prefix used when transformers.js probes env.localModelPath.
  if (path.startsWith('/models/')) {
    path = path.slice('/models/'.length);
  }
  path = path.startsWith('/') ? path.slice(1) : path;

  if (path === '') return null;

  // Reject anything that is not a clean relative path after normalization.
  const normalized = normalize(path);
  if (normalized.startsWith('..') || normalized.includes('../') || normalized.startsWith('/')) {
    return null;
  }
  // Original absolute keys outside the known prefixes are ambiguous — refuse
  // them rather than guess (the caller falls back to a re-download).
  if (key.startsWith('/') && !key.startsWith('/models/')) {
    return null;
  }

  return normalized;
}

export function createModelFileCache(cacheDir: string): ModelFileCache {
  function fileFor(key: string): string | null {
    const relative = cacheKeyToRelativePath(key);
    return relative === null ? null : join(cacheDir, relative);
  }

  return {
    async match(key) {
      const path = fileFor(key);
      if (path === null) return undefined;
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      const bytes = await file.arrayBuffer();
      // content-length lets transformers.js report progress on cached reads
      // without a network metadata round-trip.
      return new Response(bytes, {
        headers: { 'content-length': String(bytes.byteLength) },
      });
    },

    async put(key, response) {
      const path = fileFor(key);
      if (path === null) return; // unsafe key — skip caching, never write outside cacheDir
      const bytes = await response.arrayBuffer();
      await Bun.write(path, bytes);
    },
  };
}
