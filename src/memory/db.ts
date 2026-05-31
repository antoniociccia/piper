import { mkdir, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import postgresWasmPath from '../../node_modules/@electric-sql/pglite/dist/postgres.wasm' with { type: 'file' };
import postgresDataPath from '../../node_modules/@electric-sql/pglite/dist/postgres.data' with { type: 'file' };
import vectorBundlePath from '../../node_modules/@electric-sql/pglite/dist/vector.tar.gz' with { type: 'file' };

import { runMigrations } from './migrations.ts';

// `bun build --compile` embeds assets inside a virtual FS (`/$bunfs/root/...`).
// `Bun.file()` and `fs.existsSync` can see those paths, but `fs.createReadStream`
// — which PGlite uses to read the gzipped extension bundle — cannot. Materialise
// the bundle on a real filesystem path the first time it's needed, then point
// the extension's `bundlePath` at the real path.
let cachedRealBundlePath: string | null = null;

async function materialiseVectorBundle(): Promise<string> {
  if (cachedRealBundlePath !== null) return cachedRealBundlePath;
  const cacheRoot = process.env['PIPER_CACHE_DIR'] ?? join(homedir(), '.piper', 'cache', 'extensions');
  let target = join(cacheRoot, 'vector.tar.gz');
  try {
    await mkdir(cacheRoot, { recursive: true });
  } catch {
    // Fall back to OS tmpdir if home isn't writable (CI, locked-down envs).
    const fallbackRoot = join(tmpdir(), 'piper', 'extensions');
    await mkdir(fallbackRoot, { recursive: true });
    target = join(fallbackRoot, 'vector.tar.gz');
  }
  const bytes = await Bun.file(vectorBundlePath).arrayBuffer();
  let needsWrite = true;
  try {
    const existing = await stat(target);
    if (existing.size === bytes.byteLength) needsWrite = false;
  } catch {
    // not present
  }
  if (needsWrite) await writeFile(target, new Uint8Array(bytes));
  cachedRealBundlePath = target;
  return target;
}

type VectorSetup = typeof vector.setup;
type EmscriptenOpts = Parameters<VectorSetup>[1];

const bundledVector = {
  name: vector.name,
  async setup(pg: Parameters<VectorSetup>[0], emscriptenOpts: EmscriptenOpts) {
    const upstream = await vector.setup(pg, emscriptenOpts);
    const realPath = await materialiseVectorBundle();
    return {
      ...upstream,
      bundlePath: new URL(`file://${realPath}`),
    };
  },
} satisfies typeof vector;

export type DbStorage =
  | { kind: 'memory' }
  | { kind: 'file'; path: string };

export interface OpenDbOptions {
  storage?: DbStorage;
}

let cachedWasm: WebAssembly.Module | null = null;
let cachedFsBundle: Blob | null = null;

async function loadPGliteAssets(): Promise<{
  wasmModule: WebAssembly.Module;
  fsBundle: Blob;
}> {
  if (cachedWasm === null) {
    const wasmBytes = await Bun.file(postgresWasmPath).arrayBuffer();
    cachedWasm = await WebAssembly.compile(wasmBytes);
  }
  if (cachedFsBundle === null) {
    const dataBytes = await Bun.file(postgresDataPath).arrayBuffer();
    cachedFsBundle = new Blob([dataBytes]);
  }
  return { wasmModule: cachedWasm, fsBundle: cachedFsBundle };
}

function storageToDataDir(storage: DbStorage | undefined): string | undefined {
  if (storage === undefined || storage.kind === 'memory') {
    return undefined;
  }
  const path = storage.path;
  return path.startsWith('file://') ? path : `file://${path}`;
}

export async function openDb(options: OpenDbOptions = {}): Promise<PGlite> {
  const { wasmModule, fsBundle } = await loadPGliteAssets();
  const dataDir = storageToDataDir(options.storage);

  // PGlite's NODEFS adapter calls mkdir on the cluster path itself but does
  // NOT recursively create the parent. If `~/.piper/data/pglite` is the
  // cluster path and `~/.piper/data` doesn't exist yet (fresh install or
  // wiped session), the constructor crashes with ENOENT. Create the parent
  // up front — cheap, idempotent, no behaviour change when it already exists.
  if (options.storage !== undefined && options.storage.kind === 'file') {
    const parent = dirname(options.storage.path);
    if (parent !== '' && parent !== '.' && parent !== '/') {
      await mkdir(parent, { recursive: true });
    }
  }

  const db = dataDir === undefined
    ? new PGlite({ wasmModule, fsBundle, extensions: { vector: bundledVector } })
    : new PGlite({ dataDir, wasmModule, fsBundle, extensions: { vector: bundledVector } });

  await db.waitReady;
  await runMigrations(db);

  return db;
}

export async function closeDb(db: PGlite): Promise<void> {
  await db.close();
}
