import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import { resolve } from 'node:path';

import { registerBuiltins } from '../../src/actions/builtin/index.ts';
import { createCatalog } from '../../src/actions/catalog.ts';
import { logsTail } from '../../src/actions/builtin/logs-tail.ts';
import { systemListDir } from '../../src/actions/builtin/system-list-dir.ts';
import { systemUptime } from '../../src/actions/builtin/system-uptime.ts';
import { sshConnect } from '../../src/actions/builtin/ssh-connect.ts';
import { networkPortCheck } from '../../src/actions/builtin/network-port-check.ts';
import { createEnvironmentRegistry, type EnvironmentRegistry } from '../../src/environments/registry.ts';
import { createExecutor, type Executor } from '../../src/exec/executor.ts';
import { ExecError } from '../../src/exec/types.ts';
import { closeDb, openDb } from '../../src/memory/db.ts';

const E2E_ENABLED = process.env['PIPER_E2E'] === '1';
const HOST = '127.0.0.1';
const PORT = 12222;
const USER = 'testuser';
const ENV_NAME = 'e2e-loopback';
const FIXTURE_DIR = resolve(import.meta.dir, '../fixtures/sshd-docker');
const PRIVATE_KEY = resolve(FIXTURE_DIR, 'keys/piper-e2e-test');

let db: PGlite | null = null;
let executor: Executor;
let registry: EnvironmentRegistry;
let sessionId: string;

beforeAll(async () => {
  if (!E2E_ENABLED) return;

  db = await openDb();
  const catalog = createCatalog();
  registerBuiltins(catalog);
  registry = createEnvironmentRegistry(db);
  await registry.upsert({
    name: ENV_NAME,
    host: HOST,
    sshUser: USER,
    port: PORT,
    identityFile: PRIVATE_KEY,
    description: 'PIPER e2e Docker fixture',
    tags: ['e2e'],
  });
  executor = createExecutor({ db, catalog, registry });
  sessionId = `e2e-${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`,
    [sessionId, JSON.stringify({ e2e: true })],
  );
});

afterAll(async () => {
  if (db !== null) {
    await closeDb(db);
    db = null;
  }
});

const describeE2E = E2E_ENABLED ? describe : describe.skip;

describeE2E('e2e/sshd — real container', () => {
  test('ssh.connect → reachable=true', async () => {
    const result = await executor.exec('ssh.connect', { environment: ENV_NAME }, { sessionId });
    expect(result.exitCode).toBe(0);
    const parsed = sshConnect.parseResult(
      { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      { environment: ENV_NAME },
    );
    expect(parsed.reachable).toBe(true);
  });

  test('system.uptime returns a parseable line', async () => {
    const result = await executor.exec('system.uptime', { environment: ENV_NAME }, { sessionId });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/load average|up/i);
    const parsed = systemUptime.parseResult(
      { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      { environment: ENV_NAME },
    );
    expect(parsed.summary.length).toBeGreaterThan(0);
  });

  test('system.list_dir /opt/piper-e2e-app shows the seeded files', async () => {
    const result = await executor.exec(
      'system.list_dir',
      { environment: ENV_NAME, path: '/opt/piper-e2e-app' },
      { sessionId },
    );
    expect(result.exitCode).toBe(0);
    const entries = systemListDir.parseResult(
      { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      { environment: ENV_NAME, path: '/opt/piper-e2e-app' },
    );
    const names = entries.map((e) => e.name);
    expect(names).toContain('app.log');
    expect(names).toContain('README.md');
  });

  test('logs.tail without grep returns the last N lines', async () => {
    const result = await executor.exec(
      'logs.tail',
      { environment: ENV_NAME, path: '/var/log/piper-e2e/app.log', lines: 5 },
      { sessionId },
    );
    expect(result.exitCode).toBe(0);
    const parsed = logsTail.parseResult(
      { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      { environment: ENV_NAME, path: '/var/log/piper-e2e/app.log', lines: 5 },
    );
    expect(parsed.lines.length).toBeLessThanOrEqual(5);
    expect(parsed.lines.length).toBeGreaterThan(0);
  });

  test('logs.tail with grep="ERROR" returns only error lines', async () => {
    const result = await executor.exec(
      'logs.tail',
      { environment: ENV_NAME, path: '/var/log/piper-e2e/app.log', lines: 50, grep: 'ERROR' },
      { sessionId },
    );
    expect(result.exitCode).toBe(0);
    const parsed = logsTail.parseResult(
      { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      { environment: ENV_NAME, path: '/var/log/piper-e2e/app.log', lines: 50, grep: 'ERROR' },
    );
    expect(parsed.matched).toBe(2);
    expect(parsed.lines.every((l) => l.includes('ERROR'))).toBe(true);
  });

  test('network.port_check 127.0.0.1:22 (inside container) → open', async () => {
    const result = await executor.exec(
      'network.port_check',
      { environment: ENV_NAME, target: '127.0.0.1', port: 22 },
      { sessionId },
    );
    const parsed = networkPortCheck.parseResult(
      { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      { environment: ENV_NAME, target: '127.0.0.1', port: 22 },
    );
    expect(parsed.status).toBe('open');
  });

  test('network.port_check 127.0.0.1:65535 → closed', async () => {
    const result = await executor.exec(
      'network.port_check',
      { environment: ENV_NAME, target: '127.0.0.1', port: 65535, timeoutSec: 2 },
      { sessionId },
    );
    const parsed = networkPortCheck.parseResult(
      { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
      { environment: ENV_NAME, target: '127.0.0.1', port: 65535 },
    );
    expect(['closed', 'refused', 'timeout']).toContain(parsed.status);
  });

  test('environment-not-found refusal for an unknown env name', async () => {
    let caught: unknown;
    try {
      await executor.exec('ssh.connect', { environment: 'does-not-exist' }, { sessionId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('environment-not-found');
  });

  test('path-denied refusal when trying to tail ~/.ssh/id_rsa via logs.tail', async () => {
    let caught: unknown;
    try {
      await executor.exec(
        'logs.tail',
        { environment: ENV_NAME, path: '~/.ssh/id_rsa', lines: 1 },
        { sessionId },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('path-denied');
  });

  test('audit_log accumulates rows for every exec + refusal in this session', async () => {
    if (db === null) throw new Error('db missing');
    const result = await db.query<{ kind: string; count: string }>(
      `SELECT kind, COUNT(*)::text AS count FROM audit_log WHERE session_id = $1 GROUP BY kind`,
      [sessionId],
    );
    const byKind = Object.fromEntries(result.rows.map((r) => [r.kind, Number(r.count)]));
    expect((byKind['exec'] ?? 0)).toBeGreaterThan(0);
    expect((byKind['refuse'] ?? 0)).toBeGreaterThanOrEqual(2);
  });
});
