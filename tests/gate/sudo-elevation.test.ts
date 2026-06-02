import { afterEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';

import { createCatalog } from '../../src/actions/catalog.ts';
import type { Action } from '../../src/actions/types.ts';
import { createEnvironmentRegistry } from '../../src/environments/registry.ts';
import { createExecutor } from '../../src/exec/executor.ts';
import type { MutationDecision } from '../../src/exec/types.ts';
import { ExecError } from '../../src/exec/types.ts';
import { closeDb, openDb } from '../../src/memory/db.ts';
import { elevateRemoteCommand } from '../../src/security/elevation.ts';

let db: PGlite | undefined;

const echoElevated: Action<{ environment?: string; path?: string }, string> = {
  name: 'fake.echo_elevated',
  tier: 'read',
  defaultElevation: 'sudo',
  description: 'echo, elevated',
  argsSchema: z.object({ environment: z.string().optional(), path: z.string().optional() }),
  buildCommand: (_args, ctx) => [...elevateRemoteCommand(['echo', 'ok'], ctx.elevation ?? 'none')],
  parseResult: (raw) => raw.stdout,
};

// A sudo read action that takes a file under a NON-`path` arg name (`target`),
// to prove the denylist isn't fooled by the arg name when the value is a path.
const catTarget: Action<{ environment?: string; target: string }, string> = {
  name: 'fake.cat_target',
  tier: 'read',
  defaultElevation: 'sudo',
  description: 'cat a file, elevated',
  argsSchema: z.object({ environment: z.string().optional(), target: z.string() }),
  buildCommand: (args, ctx) => [...elevateRemoteCommand(['cat', args.target], ctx.elevation ?? 'none')],
  parseResult: (raw) => raw.stdout,
};

async function setup() {
  db = await openDb();
  const catalog = createCatalog();
  catalog.register(echoElevated);
  catalog.register(catTarget);
  const registry = createEnvironmentRegistry(db);
  await registry.upsert({ name: 'staging', host: 'staging.example.com', sshUser: 'deploy' });
  await registry.upsert({ name: 'prod', host: 'prod.example.com', sshUser: 'deploy' });
  const sessionId = `test-${crypto.randomUUID()}`;
  await db.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sessionId, '{}']);
  return { catalog, registry, sessionId };
}

afterEach(async () => {
  // Tests in the reactive-proposal describe block manage their own `dbx` and
  // close it themselves; guard against double-closing the stale module `db`.
  if (db !== undefined && !db.closed) await closeDb(db);
});

describe('GATE: sudo elevation requires approval', () => {
  test('a read action with sudo elevation is NOT run silently — it prompts, reject → refuse', async () => {
    const { catalog, registry, sessionId } = await setup();
    let prompted = false;
    const executor = createExecutor({
      db,
      catalog,
      registry,
      onElevationProposal: async () => {
        prompted = true;
        return { kind: 'reject', reason: 'test' } as MutationDecision;
      },
    });
    let caught: unknown;
    try {
      await executor.exec('fake.echo_elevated', { environment: 'staging' }, { sessionId });
    } catch (e) {
      caught = e;
    }
    expect(prompted).toBe(true);
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('elevation-rejected');
  });

  test('approve-once runs WITH sudo and audits the verbatim sudo command', async () => {
    const { catalog, registry, sessionId } = await setup();
    const executor = createExecutor({
      db,
      catalog,
      registry,
      onElevationProposal: async () => ({ kind: 'approve-once' }),
    });
    // The command reaches execution (no refuse thrown). Its exit code depends on
    // the host's sudoers and is not the gate property under test — what matters
    // is that the verbatim `sudo -n …` was audited, i.e. sudo carried through
    // approval into execution.
    const result = await executor.exec('fake.echo_elevated', { environment: 'staging' }, { sessionId });
    expect(result.auditId).toBeDefined();
    const audit = await db.query<{ command_scrubbed: string | null }>(
      `SELECT command_scrubbed FROM audit_log WHERE session_id = $1 AND kind = 'exec'`,
      [sessionId],
    );
    expect(audit.rows.some((r) => (r.command_scrubbed ?? '').includes('sudo -n'))).toBe(true);
  });

  test('approve-remember auto-approves the SAME action+env for the rest of the session', async () => {
    const { catalog, registry, sessionId } = await setup();
    let prompts = 0;
    const executor = createExecutor({
      db,
      catalog,
      registry,
      onElevationProposal: async () => {
        prompts += 1;
        return { kind: 'approve-remember' };
      },
    });
    await executor.exec('fake.echo_elevated', { environment: 'staging' }, { sessionId });
    await executor.exec('fake.echo_elevated', { environment: 'staging' }, { sessionId });
    expect(prompts).toBe(1);
  });

  test('a remembered sudo on staging does NOT fire on prod', async () => {
    const { catalog, registry, sessionId } = await setup();
    let prompts = 0;
    const executor = createExecutor({
      db,
      catalog,
      registry,
      onElevationProposal: async () => {
        prompts += 1;
        return { kind: 'approve-remember' };
      },
    });
    await executor.exec('fake.echo_elevated', { environment: 'staging' }, { sessionId });
    await executor.exec('fake.echo_elevated', { environment: 'prod' }, { sessionId });
    expect(prompts).toBe(2);
  });

  test('the path denylist refuses a sudo command whose path arg is denied, even with approval', async () => {
    const { catalog, registry, sessionId } = await setup();
    const executor = createExecutor({
      db,
      catalog,
      registry,
      onElevationProposal: async () => ({ kind: 'approve-once' }),
    });
    let caught: unknown;
    try {
      await executor.exec(
        'fake.echo_elevated',
        { environment: 'staging', path: '/Users/x/.ssh/id_rsa' },
        { sessionId },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('path-denied');
  });

  test('the denylist refuses a denied file passed under a NON-path arg name (e.g. target)', async () => {
    const { catalog, registry, sessionId } = await setup();
    const executor = createExecutor({
      db,
      catalog,
      registry,
      onElevationProposal: async () => ({ kind: 'approve-once' }),
    });
    let caught: unknown;
    try {
      await executor.exec(
        'fake.cat_target',
        { environment: 'staging', target: '/home/deploy/.ssh/id_rsa' },
        { sessionId },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('path-denied');
  });

  test('a non-path string arg that is NOT a filesystem path is NOT denied (no false positive)', async () => {
    const { catalog, registry, sessionId } = await setup();
    const executor = createExecutor({
      db,
      catalog,
      registry,
      onElevationProposal: async () => ({ kind: 'approve-once' }),
    });
    // `target` is a harmless relative token, not a /path or ~/path → must pass the denylist.
    let caught: unknown;
    try {
      await executor.exec('fake.cat_target', { environment: 'staging', target: 'nginx.conf' }, { sessionId });
    } catch (e) {
      caught = e;
    }
    // It may fail for other reasons (sudo -n needs a password in CI), but NOT path-denied.
    if (caught instanceof ExecError) {
      expect(caught.reason).not.toBe('path-denied');
    }
  });

  test('NO approver wired + sudo action → refuse (never run unprompted)', async () => {
    const { catalog, registry, sessionId } = await setup();
    const executor = createExecutor({ db, catalog, registry }); // no onElevationProposal
    let caught: unknown;
    try {
      await executor.exec('fake.echo_elevated', { environment: 'staging' }, { sessionId });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExecError);
  });
});

describe('GATE: reactive sudo proposal', () => {
  test('a non-elevated permission-denied failure proposes a reactive sudo re-run', async () => {
    const { z } = await import('zod');
    const { createCatalog } = await import('../../src/actions/catalog.ts');
    const { createEnvironmentRegistry } = await import('../../src/environments/registry.ts');
    const { createExecutor } = await import('../../src/exec/executor.ts');

    const dbx = await openDb();
    const cat = createCatalog();
    // A read action with NO defaultElevation whose command fails permission-denied.
    // Elevation-aware so the reactive guard lets the proposal through (a non-aware
    // action is intentionally skipped — see the dedicated guard test below).
    const { elevateRemoteCommand } = await import('../../src/security/elevation.ts');
    cat.register({
      name: 'fake.denies',
      tier: 'read',
      description: 'always permission denied',
      argsSchema: z.object({ environment: z.string().optional() }),
      buildCommand: (_a, ctx) => [
        ...elevateRemoteCommand(['sh', '-c', 'echo "permission denied" 1>&2; exit 1'], ctx.elevation ?? 'none'),
      ],
      parseResult: (raw) => raw.stdout,
    });
    const reg = createEnvironmentRegistry(dbx);
    await reg.upsert({ name: 'staging', host: 'h', sshUser: 'u' });
    const sid = `t-${crypto.randomUUID()}`;
    await dbx.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sid, '{}']);

    let reactiveFor: string | null = null;
    let calls = 0;
    const executor = createExecutor({
      db: dbx, catalog: cat, registry: reg,
      onElevationProposal: async (p) => {
        calls += 1;
        if (p.origin === 'reactive') reactiveFor = p.actionName;
        return { kind: 'reject', reason: 'test' };
      },
    });
    const result = await executor.exec('fake.denies', { environment: 'staging' }, { sessionId: sid });
    // Original failed result is returned (reject keeps the failure visible).
    expect(result.exitCode).toBe(1);
    expect(reactiveFor).toBe('fake.denies');
    expect(calls).toBe(1); // proposed exactly once — no recursion storm
    await closeDb(dbx);
  });

  test('reactive approve-once prompts exactly once (no double prompt on the re-run)', async () => {
    const { z } = await import('zod');
    const { createCatalog } = await import('../../src/actions/catalog.ts');
    const { createEnvironmentRegistry } = await import('../../src/environments/registry.ts');
    const { createExecutor } = await import('../../src/exec/executor.ts');

    const dbx = await openDb();
    const cat = createCatalog();
    cat.register({
      name: 'fake.denies2',
      tier: 'read',
      description: 'permission denied then succeeds under sudo',
      argsSchema: z.object({ environment: z.string().optional() }),
      // Always permission-denied (even the sudo re-run fails locally — fine; we
      // only care about how many times the user is PROMPTED, not the exit code).
      // Must carry 'sudo' when elevation='sudo' to pass argvCarriesSudo check.
      buildCommand: (_args, ctx) =>
        ctx.elevation === 'sudo'
          ? ['sudo', '-n', 'sh', '-c', 'echo "permission denied" 1>&2; exit 1']
          : ['sh', '-c', 'echo "permission denied" 1>&2; exit 1'],
      parseResult: (raw) => raw.stdout,
    });
    const reg = createEnvironmentRegistry(dbx);
    await reg.upsert({ name: 'staging', host: 'h', sshUser: 'u' });
    const sid = `t-${crypto.randomUUID()}`;
    await dbx.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sid, '{}']);

    let prompts = 0;
    const executor = createExecutor({
      db: dbx, catalog: cat, registry: reg,
      onElevationProposal: async () => { prompts += 1; return { kind: 'approve-once' }; },
    });
    await executor.exec('fake.denies2', { environment: 'staging' }, { sessionId: sid });
    // Reactive proposal (1) → approve-once → re-run gate must NOT prompt again.
    expect(prompts).toBe(1);
    await closeDb(dbx);
  });

  test('reactive approve-once does NOT persist — a later call prompts again', async () => {
    const { z } = await import('zod');
    const { createCatalog } = await import('../../src/actions/catalog.ts');
    const { createEnvironmentRegistry } = await import('../../src/environments/registry.ts');
    const { createExecutor } = await import('../../src/exec/executor.ts');
    const dbx = await openDb();
    const cat = createCatalog();
    cat.register({
      name: 'fake.denies3',
      tier: 'read',
      description: 'permission denied',
      argsSchema: z.object({ environment: z.string().optional() }),
      // Must carry 'sudo' when elevation='sudo' to pass argvCarriesSudo check.
      buildCommand: (_args, ctx) =>
        ctx.elevation === 'sudo'
          ? ['sudo', '-n', 'sh', '-c', 'echo "permission denied" 1>&2; exit 1']
          : ['sh', '-c', 'echo "permission denied" 1>&2; exit 1'],
      parseResult: (raw) => raw.stdout,
    });
    const reg = createEnvironmentRegistry(dbx);
    await reg.upsert({ name: 'staging', host: 'h', sshUser: 'u' });
    const sid = `t-${crypto.randomUUID()}`;
    await dbx.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sid, '{}']);
    let prompts = 0;
    const executor = createExecutor({
      db: dbx, catalog: cat, registry: reg,
      onElevationProposal: async () => { prompts += 1; return { kind: 'approve-once' }; },
    });
    await executor.exec('fake.denies3', { environment: 'staging' }, { sessionId: sid });
    await executor.exec('fake.denies3', { environment: 'staging' }, { sessionId: sid });
    // Two separate reactive flows, each one-shot → two prompts (one per call),
    // NOT one (which would mean approve-once wrongly persisted).
    expect(prompts).toBe(2);
    await closeDb(dbx);
  });

  test('an elevated run that needs a password offers the TTY passthrough; declining returns the failure', async () => {
    const { z } = await import('zod');
    const { createCatalog } = await import('../../src/actions/catalog.ts');
    const { createEnvironmentRegistry } = await import('../../src/environments/registry.ts');
    const { createExecutor } = await import('../../src/exec/executor.ts');
    const dbx = await openDb();
    const cat = createCatalog();
    // Elevated action whose sudo -n run prints the password-required message.
    cat.register({
      name: 'fake.needs_password',
      tier: 'read',
      defaultElevation: 'sudo',
      description: 'sudo -n needs a password',
      argsSchema: z.object({ environment: z.string().optional() }),
      // Must carry 'sudo' when elevation='sudo' to pass the argvCarriesSudo gate;
      // the inner command just prints the password-required message and fails so
      // detectSudoPasswordRequired fires.
      buildCommand: (_args, ctx) =>
        ctx.elevation === 'sudo'
          ? ['sudo', '-n', 'sh', '-c', 'echo "sudo: a password is required" 1>&2; exit 1']
          : ['sh', '-c', 'echo "sudo: a password is required" 1>&2; exit 1'],
      parseResult: (raw) => raw.stdout,
    });
    const reg = createEnvironmentRegistry(dbx);
    await reg.upsert({ name: 'staging', host: 'h', sshUser: 'u' });
    const sid = `t-${crypto.randomUUID()}`;
    await dbx.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sid, '{}']);
    let ttyOffered = false;
    const executor = createExecutor({
      db: dbx, catalog: cat, registry: reg,
      onElevationProposal: async () => ({ kind: 'approve-once' }),
      onSudoPasswordRequired: async () => { ttyOffered = true; return false; }, // decline → no interactive spawn
    });
    const result = await executor.exec('fake.needs_password', { environment: 'staging' }, { sessionId: sid });
    expect(ttyOffered).toBe(true);
    expect(result.exitCode).toBe(1); // original sudo -n failure returned on decline
    await closeDb(dbx);
  });

  test('a non-permission failure does NOT propose sudo', async () => {
    const { z } = await import('zod');
    const { createCatalog } = await import('../../src/actions/catalog.ts');
    const { createEnvironmentRegistry } = await import('../../src/environments/registry.ts');
    const { createExecutor } = await import('../../src/exec/executor.ts');

    const dbx = await openDb();
    const cat = createCatalog();
    cat.register({
      name: 'fake.notfound',
      tier: 'read',
      description: 'fails with a non-permission error',
      argsSchema: z.object({ environment: z.string().optional() }),
      buildCommand: () => ['sh', '-c', 'echo "no such file or directory" 1>&2; exit 2'],
      parseResult: (raw) => raw.stdout,
    });
    const reg = createEnvironmentRegistry(dbx);
    await reg.upsert({ name: 'staging', host: 'h', sshUser: 'u' });
    const sid = `t-${crypto.randomUUID()}`;
    await dbx.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sid, '{}']);

    let proposed = false;
    const executor = createExecutor({
      db: dbx, catalog: cat, registry: reg,
      onElevationProposal: async () => { proposed = true; return { kind: 'reject' }; },
    });
    const result = await executor.exec('fake.notfound', { environment: 'staging' }, { sessionId: sid });
    expect(result.exitCode).toBe(2);
    expect(proposed).toBe(false);
    await closeDb(dbx);
  });
});

describe('GATE: sudo re-validation, never-remember, and double-gating', () => {
  test('re-validation: approved sudo but buildCommand drops it → refuse execution-failed', async () => {
    const { z } = await import('zod');
    const { createCatalog } = await import('../../src/actions/catalog.ts');
    const { createEnvironmentRegistry } = await import('../../src/environments/registry.ts');
    const { createExecutor } = await import('../../src/exec/executor.ts');
    const dbx = await openDb();
    const cat = createCatalog();
    cat.register({
      name: 'fake.drops_sudo',
      tier: 'read',
      defaultElevation: 'sudo',
      description: 'claims sudo but builds a non-sudo command',
      argsSchema: z.object({ environment: z.string().optional() }),
      buildCommand: () => ['echo', 'ok'], // ignores ctx.elevation → no sudo
      parseResult: (raw) => raw.stdout,
    });
    const reg = createEnvironmentRegistry(dbx);
    await reg.upsert({ name: 'staging', host: 'h', sshUser: 'u' });
    const sid = `t-${crypto.randomUUID()}`;
    await dbx.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sid, '{}']);
    const executor = createExecutor({
      db: dbx, catalog: cat, registry: reg,
      onElevationProposal: async () => ({ kind: 'approve-once' }),
    });
    let caught: unknown;
    try { await executor.exec('fake.drops_sudo', { environment: 'staging' }, { sessionId: sid }); }
    catch (e) { caught = e; }
    const { ExecError } = await import('../../src/exec/types.ts');
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as InstanceType<typeof ExecError>).reason).toBe('execution-failed');
    await closeDb(dbx);
  });

  test('destructive+sudo is never remembered — approve-remember still prompts next time', async () => {
    const { z } = await import('zod');
    const { createCatalog } = await import('../../src/actions/catalog.ts');
    const { createEnvironmentRegistry } = await import('../../src/environments/registry.ts');
    const { createExecutor } = await import('../../src/exec/executor.ts');
    const { elevateRemoteCommand } = await import('../../src/security/elevation.ts');
    const dbx = await openDb();
    const cat = createCatalog();
    cat.register({
      name: 'fake.destroy_elevated',
      tier: 'destructive',
      defaultElevation: 'sudo',
      description: 'destructive, elevated',
      argsSchema: z.object({ environment: z.string().optional() }),
      buildCommand: (_a, ctx) => [...elevateRemoteCommand(['echo', 'boom'], ctx.elevation ?? 'none')],
      parseResult: (raw) => raw.stdout,
    });
    const reg = createEnvironmentRegistry(dbx);
    await reg.upsert({ name: 'staging', host: 'h', sshUser: 'u' });
    const sid = `t-${crypto.randomUUID()}`;
    await dbx.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sid, '{}']);
    let elevationPrompts = 0;
    const executor = createExecutor({
      db: dbx, catalog: cat, registry: reg,
      onElevationProposal: async () => { elevationPrompts += 1; return { kind: 'approve-remember' }; },
      onMutationProposal: async () => ({ kind: 'approve-once' }),
    });
    await executor.exec('fake.destroy_elevated', { environment: 'staging' }, { sessionId: sid });
    await executor.exec('fake.destroy_elevated', { environment: 'staging' }, { sessionId: sid });
    expect(elevationPrompts).toBe(2); // destructive sudo never remembered → prompts each time
    await closeDb(dbx);
  });

  test('reactive sudo on an elevation-aware action re-runs WITH sudo (no execution-failed)', async () => {
    const { z } = await import('zod');
    const { createCatalog } = await import('../../src/actions/catalog.ts');
    const { createEnvironmentRegistry } = await import('../../src/environments/registry.ts');
    const { createExecutor } = await import('../../src/exec/executor.ts');
    const { elevateRemoteCommand } = await import('../../src/security/elevation.ts');
    const dbx = await openDb();
    const cat = createCatalog();
    let pass = 0;
    cat.register({
      name: 'fake.docker_like',
      tier: 'read',
      description: 'permission denied unprivileged; elevation-aware',
      argsSchema: z.object({ environment: z.string().optional() }),
      buildCommand: (_a, ctx) => {
        // First (unelevated) call prints the docker permission-denied + exits 1.
        // The elevated re-run carries sudo and "succeeds".
        pass += 1;
        if ((ctx.elevation ?? 'none') === 'sudo') {
          return [...elevateRemoteCommand(['sh', '-c', 'echo ok'], 'sudo')];
        }
        return ['sh', '-c', 'echo "Got permission denied while trying to connect to the Docker daemon socket" 1>&2; exit 1'];
      },
      parseResult: (raw) => raw.stdout,
    });
    const reg = createEnvironmentRegistry(dbx);
    await reg.upsert({ name: 'staging', host: 'h', sshUser: 'u' });
    const sid = `t-${crypto.randomUUID()}`;
    await dbx.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sid, '{}']);
    let reactive = false;
    const { ExecError } = await import('../../src/exec/types.ts');
    const executor = createExecutor({
      db: dbx, catalog: cat, registry: reg,
      onElevationProposal: async (p) => { if (p.origin === 'reactive') reactive = true; return { kind: 'approve-once' }; },
    });
    let caught: unknown;
    try { await executor.exec('fake.docker_like', { environment: 'staging' }, { sessionId: sid }); }
    catch (e) { caught = e; }
    expect(reactive).toBe(true);
    expect(pass).toBeGreaterThanOrEqual(2); // unelevated attempt + elevated re-run
    // The re-run carried sudo → re-validation passed → no execution-failed.
    if (caught instanceof ExecError) expect(caught.reason).not.toBe('execution-failed');
    await closeDb(dbx);
  });

  test('reactive sudo is NOT proposed for an action that ignores ctx.elevation (guard)', async () => {
    const { z } = await import('zod');
    const { createCatalog } = await import('../../src/actions/catalog.ts');
    const { createEnvironmentRegistry } = await import('../../src/environments/registry.ts');
    const { createExecutor } = await import('../../src/exec/executor.ts');
    const dbx = await openDb();
    const cat = createCatalog();
    cat.register({
      name: 'fake.not_elevatable',
      tier: 'read',
      description: 'permission denied but ignores ctx.elevation',
      argsSchema: z.object({ environment: z.string().optional() }),
      buildCommand: () => ['sh', '-c', 'echo "permission denied" 1>&2; exit 1'], // never sudo
      parseResult: (raw) => raw.stdout,
    });
    const reg = createEnvironmentRegistry(dbx);
    await reg.upsert({ name: 'staging', host: 'h', sshUser: 'u' });
    const sid = `t-${crypto.randomUUID()}`;
    await dbx.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sid, '{}']);
    let proposed = false;
    const executor = createExecutor({
      db: dbx, catalog: cat, registry: reg,
      onElevationProposal: async () => { proposed = true; return { kind: 'approve-once' }; },
    });
    const result = await executor.exec('fake.not_elevatable', { environment: 'staging' }, { sessionId: sid });
    // The action can't be elevated → no sudo proposal → the original failure is returned.
    expect(proposed).toBe(false);
    expect(result.exitCode).toBe(1);
    await closeDb(dbx);
  });

  test('mutate+sudo: elevation proposal has doubleConfirm and the mutation gate also runs', async () => {
    const { z } = await import('zod');
    const { createCatalog } = await import('../../src/actions/catalog.ts');
    const { createEnvironmentRegistry } = await import('../../src/environments/registry.ts');
    const { createExecutor } = await import('../../src/exec/executor.ts');
    const { elevateRemoteCommand } = await import('../../src/security/elevation.ts');
    const dbx = await openDb();
    const cat = createCatalog();
    cat.register({
      name: 'fake.mutate_elevated',
      tier: 'mutate',
      defaultElevation: 'sudo',
      description: 'mutate, elevated',
      argsSchema: z.object({ environment: z.string().optional() }),
      buildCommand: (_a, ctx) => [...elevateRemoteCommand(['echo', 'change'], ctx.elevation ?? 'none')],
      parseResult: (raw) => raw.stdout,
    });
    const reg = createEnvironmentRegistry(dbx);
    await reg.upsert({ name: 'staging', host: 'h', sshUser: 'u' });
    const sid = `t-${crypto.randomUUID()}`;
    await dbx.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sid, '{}']);
    let sawDoubleConfirm: boolean | null = null;
    let mutationGateRan = false;
    const executor = createExecutor({
      db: dbx, catalog: cat, registry: reg,
      onElevationProposal: async (p) => { sawDoubleConfirm = p.doubleConfirm; return { kind: 'approve-once' }; },
      onMutationProposal: async () => { mutationGateRan = true; return { kind: 'approve-once' }; },
    });
    await executor.exec('fake.mutate_elevated', { environment: 'staging' }, { sessionId: sid });
    expect(sawDoubleConfirm).toBe(true);
    expect(mutationGateRan).toBe(true);
    await closeDb(dbx);
  });

  test('reactive sudo for mutations: snapshot permission-denied → execute runs WITH sudo', async () => {
    const { z } = await import('zod');
    const { createCatalog } = await import('../../src/actions/catalog.ts');
    const { createEnvironmentRegistry } = await import('../../src/environments/registry.ts');
    const { createExecutor } = await import('../../src/exec/executor.ts');
    const { elevateRemoteCommand } = await import('../../src/security/elevation.ts');
    const dbx = await openDb();
    const cat = createCatalog();
    cat.register({
      name: 'fake.mutate_docker',
      tier: 'mutate',
      description: 'mutate that needs sudo (snapshot denies unprivileged)',
      argsSchema: z.object({ environment: z.string().optional() }),
      // snapshot: read-only probe that prints permission-denied unprivileged.
      buildSnapshotCommand: (_a, ctx) =>
        (ctx.elevation ?? 'none') === 'sudo'
          ? [...elevateRemoteCommand(['sh', '-c', 'echo snapshot-ok'], 'sudo')]
          : ['sh', '-c', 'echo "permission denied" 1>&2; exit 1'],
      buildCommand: (_a, ctx) => [...elevateRemoteCommand(['sh', '-c', 'echo up'], ctx.elevation ?? 'none')],
      parseResult: (raw) => raw.stdout,
    });
    const reg = createEnvironmentRegistry(dbx);
    await reg.upsert({ name: 'staging', host: 'h', sshUser: 'u' });
    const sid = `t-${crypto.randomUUID()}`;
    await dbx.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sid, '{}']);
    let elevReactive = false;
    const executor = createExecutor({
      db: dbx, catalog: cat, registry: reg,
      onElevationProposal: async (p) => { if (p.origin === 'reactive') elevReactive = true; return { kind: 'approve-once' }; },
      onMutationProposal: async () => ({ kind: 'approve-once' }),
    });
    try { await executor.exec('fake.mutate_docker', { environment: 'staging' }, { sessionId: sid }); } catch { /* verify may fail; we only assert sudo carried */ }
    expect(elevReactive).toBe(true);
    const audit = await dbx.query<{ command_scrubbed: string | null }>(
      `SELECT command_scrubbed FROM audit_log WHERE session_id = $1 AND kind = 'mutate-execute'`, [sid]);
    expect(audit.rows.some((r) => (r.command_scrubbed ?? '').includes('sudo'))).toBe(true);
    await closeDb(dbx);
  });

  test('reactive sudo for mutations is NOT offered when the action ignores elevation', async () => {
    const { z } = await import('zod');
    const { createCatalog } = await import('../../src/actions/catalog.ts');
    const { createEnvironmentRegistry } = await import('../../src/environments/registry.ts');
    const { createExecutor } = await import('../../src/exec/executor.ts');
    const dbx = await openDb();
    const cat = createCatalog();
    cat.register({
      name: 'fake.mutate_plain',
      tier: 'mutate',
      description: 'mutate, snapshot denies, but ignores elevation',
      argsSchema: z.object({ environment: z.string().optional() }),
      buildSnapshotCommand: () => ['sh', '-c', 'echo "permission denied" 1>&2; exit 1'],
      buildCommand: () => ['sh', '-c', 'echo up'], // never sudo
      parseResult: (raw) => raw.stdout,
    });
    const reg = createEnvironmentRegistry(dbx);
    await reg.upsert({ name: 'staging', host: 'h', sshUser: 'u' });
    const sid = `t-${crypto.randomUUID()}`;
    await dbx.query(`INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`, [sid, '{}']);
    let elevProposed = false;
    const executor = createExecutor({
      db: dbx, catalog: cat, registry: reg,
      onElevationProposal: async () => { elevProposed = true; return { kind: 'approve-once' }; },
      onMutationProposal: async () => ({ kind: 'approve-once' }),
    });
    try { await executor.exec('fake.mutate_plain', { environment: 'staging' }, { sessionId: sid }); } catch { /* fine */ }
    expect(elevProposed).toBe(false);
    await closeDb(dbx);
  });
});
