import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import postgresWasmPath from '../../node_modules/@electric-sql/pglite/dist/postgres.wasm' with { type: 'file' };
import postgresDataPath from '../../node_modules/@electric-sql/pglite/dist/postgres.data' with { type: 'file' };

import { runMigrations } from './migrations.ts';

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
    ? new PGlite({ wasmModule, fsBundle, extensions: { vector } })
    : new PGlite({ dataDir, wasmModule, fsBundle, extensions: { vector } });

  await db.waitReady;
  await runMigrations(db);

  return db;
}

export async function closeDb(db: PGlite): Promise<void> {
  await db.close();
}
