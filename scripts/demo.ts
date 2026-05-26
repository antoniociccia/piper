#!/usr/bin/env bun
/**
 * Demo script — proves the M1 backbone end-to-end without a real LLM.
 *
 * Flow:
 *   1. Open in-memory PGlite (or persistent file if --persist is passed).
 *   2. Register a local "loopback" environment that points at the current host.
 *   3. Run the 7 builtin read actions through the Executor (no LLM in the loop).
 *   4. Print the EnvironmentRegistry's LLM-facing description.
 *   5. Print the audit log + evidence rows.
 *
 * Each action runs `ssh user@host …` against `loopback`. If your local ssh
 * server isn't running (`sshd` enabled, key in `~/.ssh/authorized_keys`), the
 * remote commands will fail with exit != 0 — the demo will still print all
 * the audit / evidence rows so you can see the gate behavior.
 *
 * Usage:
 *   bun run scripts/demo.ts                # in-memory, ephemeral
 *   bun run scripts/demo.ts --persist      # writes to ./data/piper-demo
 */

import { registerBuiltins } from '../src/actions/builtin/index.ts';
import { createCatalog } from '../src/actions/catalog.ts';
import { createEnvironmentRegistry } from '../src/environments/registry.ts';
import { createExecutor } from '../src/exec/executor.ts';
import { ExecError } from '../src/exec/types.ts';
import { createLogger } from '../src/logging/logger.ts';
import { closeDb, openDb } from '../src/memory/db.ts';

const persist = process.argv.includes('--persist');
const userInfo = await Bun.$`whoami`.text();
const localUser = userInfo.trim();

const logger = createLogger({ level: 'info' });
const db = await openDb(persist ? { storage: { kind: 'file', path: './data/piper-demo' } } : {});
const catalog = createCatalog();
const registry = createEnvironmentRegistry(db);
const executor = createExecutor({ db, catalog, registry, logger });

registerBuiltins(catalog);

// Register a "loopback" environment pointing at the current host.
await registry.upsert({
  name: 'loopback',
  host: '127.0.0.1',
  sshUser: localUser,
  description: 'demo: SSH to localhost as the current user',
  tags: ['demo', 'local'],
});

// Make a session
const sessionId = `demo-${crypto.randomUUID()}`;
await db.query(
  `INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`,
  [sessionId, JSON.stringify({ demo: true })],
);

const banner = (s: string) => process.stdout.write(`\n=== ${s} ===\n`);

banner('Catalog');
for (const a of catalog.list()) {
  process.stdout.write(`  - ${a.name.padEnd(22)} [${a.tier}]  ${a.description}\n`);
}

banner('Environments — what the LLM will see');
process.stdout.write(`${await registry.describeForLLM()}\n`);

interface Probe {
  readonly action: string;
  readonly args: Record<string, unknown>;
}

const probes: readonly Probe[] = [
  { action: 'ssh.connect',         args: { environment: 'loopback' } },
  { action: 'system.uptime',       args: { environment: 'loopback' } },
  { action: 'system.disk_usage',   args: { environment: 'loopback', path: '/' } },
  { action: 'system.process_list', args: { environment: 'loopback', limit: 5 } },
  { action: 'network.port_check',  args: { environment: 'loopback', target: '127.0.0.1', port: 22 } },
  // logs.tail intentionally targets a usually-readable system file
  { action: 'logs.tail',           args: { environment: 'loopback', path: '/etc/hostname', lines: 3 } },
  // docker.ps is best-effort: may fail if docker is not installed
  { action: 'docker.ps',           args: { environment: 'loopback' } },
];

banner('Executing read actions');
for (const probe of probes) {
  process.stdout.write(`\n→ ${probe.action} ${JSON.stringify(probe.args)}\n`);
  try {
    const result = await executor.exec(probe.action, probe.args, { sessionId, timeoutMs: 10_000 });
    process.stdout.write(`  exit=${result.exitCode} duration=${result.durationMs.toFixed(0)}ms\n`);
    const stdoutFirst = result.stdout.split('\n').slice(0, 4).join('\n').trim();
    if (stdoutFirst !== '') process.stdout.write(`  stdout: ${stdoutFirst}\n`);
    if (result.stderr.trim() !== '') {
      const stderrFirst = result.stderr.split('\n').slice(0, 2).join('\n').trim();
      process.stdout.write(`  stderr: ${stderrFirst}\n`);
    }
  } catch (err) {
    if (err instanceof ExecError) {
      process.stdout.write(`  REFUSED [${err.reason}] ${err.message}\n`);
    } else {
      process.stdout.write(`  ERROR ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}

banner('Persisted audit_log');
const audit = await db.query<{
  ts: string;
  kind: string;
  action_name: string;
  command_scrubbed: string | null;
  exit_code: number | null;
  refused_reason: string | null;
}>(
  `SELECT ts, kind, action_name, command_scrubbed, exit_code, refused_reason
     FROM audit_log WHERE session_id = $1 ORDER BY ts ASC`,
  [sessionId],
);
for (const row of audit.rows) {
  const tag = row.kind === 'refuse' ? `REFUSE (${row.refused_reason})` : `EXEC exit=${row.exit_code}`;
  process.stdout.write(`  [${row.ts}] ${row.action_name.padEnd(22)} ${tag}\n`);
  if (row.command_scrubbed !== null) {
    process.stdout.write(`      cmd: ${row.command_scrubbed}\n`);
  }
}

banner('Persisted evidence (first 200 chars of stdout per row)');
const evidence = await db.query<{ action_id: number; stdout_scrubbed: string }>(
  `SELECT action_id, stdout_scrubbed FROM evidence WHERE session_id = $1 ORDER BY ts ASC`,
  [sessionId],
);
for (const row of evidence.rows) {
  const preview = row.stdout_scrubbed.replace(/\s+/g, ' ').slice(0, 200);
  process.stdout.write(`  [audit#${row.action_id}] ${preview}${row.stdout_scrubbed.length > 200 ? '…' : ''}\n`);
}

await closeDb(db);
process.stdout.write('\nDemo complete.\n');
