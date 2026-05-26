import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { closeDb, openDb } from '../../../src/memory/db.ts';
import { appliedVersions, MIGRATIONS, runMigrations } from '../../../src/memory/migrations.ts';

describe('memory/db', () => {
  test('openDb returns a ready instance with the schema applied', async () => {
    const db = await openDb();
    try {
      const result = await db.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'sessions'
         ) AS exists`,
      );
      expect(result.rows[0]?.exists).toBe(true);
    } finally {
      await closeDb(db);
    }
  });

  test('all expected tables are created', async () => {
    const db = await openDb();
    try {
      const expectedTables = [
        'sessions',
        'audit_log',
        'evidence',
        'env_state',
        'llm_calls',
        'config_overrides',
        'chat_messages',
        'rag_documents',
        '_migrations',
      ];
      for (const table of expectedTables) {
        const result = await db.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = $1
           ) AS exists`,
          [table],
        );
        expect(result.rows[0]?.exists, `table ${table} should exist`).toBe(true);
      }
    } finally {
      await closeDb(db);
    }
  });

  test('migrations are idempotent: running twice applies the new ones only once', async () => {
    const db = await openDb();
    try {
      const firstRunVersions = await appliedVersions(db);
      const expectedFinalVersions = MIGRATIONS.map((m) => m.version);
      expect(firstRunVersions).toEqual(expectedFinalVersions);

      const newlyApplied = await runMigrations(db);
      expect(newlyApplied).toEqual([]);

      const secondRunVersions = await appliedVersions(db);
      expect(secondRunVersions).toEqual(expectedFinalVersions);
    } finally {
      await closeDb(db);
    }
  });

  test('audit_log enforces the kind CHECK constraint', async () => {
    const db = await openDb();
    try {
      await db.query(
        `INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`,
        ['session-check', JSON.stringify({})],
      );
      await expect(
        db.query(
          `INSERT INTO audit_log (session_id, kind, action_name, args_scrubbed_json)
           VALUES ($1, $2, $3, $4::jsonb)`,
          ['session-check', 'not-a-valid-kind', 'noop', '{}'],
        ),
      ).rejects.toThrow();
    } finally {
      await closeDb(db);
    }
  });

  test('evidence requires a valid session and audit_log reference', async () => {
    const db = await openDb();
    try {
      await expect(
        db.query(
          `INSERT INTO evidence (session_id, action_id) VALUES ($1, $2)`,
          ['nonexistent-session', 1],
        ),
      ).rejects.toThrow();
    } finally {
      await closeDb(db);
    }
  });

  test('openDb on a file path whose PARENT directory does not exist creates it (no ENOENT)', async () => {
    // Reproduces the bug where `rm -rf $PIPER_DATA_DIR && bun dev` would
    // crash because PGlite's NODEFS only mkdirs the cluster path, not its
    // ancestors. We pass a 3-level-deep nonexistent path and verify openDb
    // creates the parent and produces a usable DB.
    const root = await mkdtemp(join(tmpdir(), 'piper-db-test-'));
    const clusterPath = join(root, 'never-existed', 'deeper', 'pglite');
    try {
      const db = await openDb({ storage: { kind: 'file', path: clusterPath } });
      try {
        await db.query('SELECT 1');
        const parentStat = await stat(join(root, 'never-existed', 'deeper'));
        expect(parentStat.isDirectory()).toBe(true);
      } finally {
        await closeDb(db);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('audit_log and evidence happy path with a real session', async () => {
    const db = await openDb();
    try {
      await db.query(
        `INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`,
        ['s1', JSON.stringify({ backend: 'ollama' })],
      );

      const auditInsert = await db.query<{ id: number }>(
        `INSERT INTO audit_log (session_id, kind, action_name, args_scrubbed_json, command_scrubbed, exit_code)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING id`,
        ['s1', 'exec', 'system.uptime', JSON.stringify({ host: 'h' }), 'ssh h uptime', 0],
      );
      const auditId = auditInsert.rows[0]?.id;
      expect(typeof auditId).toBe('number');

      await db.query(
        `INSERT INTO evidence (session_id, action_id, stdout_scrubbed, stderr_scrubbed)
         VALUES ($1, $2, $3, $4)`,
        ['s1', auditId, 'uptime: 10 days', ''],
      );

      const join = await db.query<{ action_name: string; stdout_scrubbed: string }>(
        `SELECT al.action_name, ev.stdout_scrubbed
         FROM audit_log al
         JOIN evidence ev ON ev.action_id = al.id
         WHERE al.session_id = $1`,
        ['s1'],
      );
      expect(join.rows).toEqual([
        { action_name: 'system.uptime', stdout_scrubbed: 'uptime: 10 days' },
      ]);
    } finally {
      await closeDb(db);
    }
  });
});
