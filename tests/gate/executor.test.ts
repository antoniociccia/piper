import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';

import { createCatalog, type Catalog } from '../../src/actions/catalog.ts';
import type { Action, Tier } from '../../src/actions/types.ts';
import { createEnvironmentRegistry, type EnvironmentRegistry } from '../../src/environments/registry.ts';
import { createExecutor, type Executor } from '../../src/exec/executor.ts';
import {
  ExecError,
  type MutationApprovalCallback,
} from '../../src/exec/types.ts';
import { closeDb, openDb } from '../../src/memory/db.ts';

interface Setup {
  readonly db: PGlite;
  readonly catalog: Catalog;
  readonly registry: EnvironmentRegistry;
  readonly executor: Executor;
  readonly sessionId: string;
  readonly makeExecutor: (overrides?: {
    allowedTiers?: readonly Tier[];
    onMutationProposal?: MutationApprovalCallback;
  }) => Executor;
}

let active: Setup | null = null;

async function setupTest(): Promise<Setup> {
  const db = await openDb();
  const catalog = createCatalog();
  const registry = createEnvironmentRegistry(db);
  const sessionId = `test-${crypto.randomUUID()}`;
  await db.query(
    `INSERT INTO sessions (id, config_snapshot_json) VALUES ($1, $2::jsonb)`,
    [sessionId, JSON.stringify({})],
  );
  await registry.upsert({ name: 'allowed', host: 'allowed.example.com', sshUser: 'deploy' });

  const executor = createExecutor({ db, catalog, registry });

  const setup: Setup = {
    db,
    catalog,
    registry,
    executor,
    sessionId,
    makeExecutor: (overrides) =>
      createExecutor({
        db,
        catalog,
        registry,
        ...(overrides?.allowedTiers === undefined ? {} : { allowedTiers: overrides.allowedTiers }),
        ...(overrides?.onMutationProposal === undefined
          ? {}
          : { onMutationProposal: overrides.onMutationProposal }),
      }),
  };
  active = setup;
  return setup;
}

beforeEach(() => {
  active = null;
});

afterEach(async () => {
  if (active !== null) {
    await closeDb(active.db);
    active = null;
  }
});

const echo: Action<{ line: string }, string> = {
  name: 'fake.echo',
  tier: 'read',
  description: 'echoes a single line',
  argsSchema: z.object({ line: z.string() }),
  buildCommand: (args) => ['echo', args.line],
  parseResult: (raw) => raw.stdout,
};

const echoEnv: Action<{ environment: string; line: string }, string> = {
  name: 'fake.echo_env',
  tier: 'read',
  description: 'echoes a line, requires an environment arg',
  argsSchema: z.object({ environment: z.string(), line: z.string() }),
  buildCommand: (args, ctx) => {
    const env = ctx.environment;
    if (env === undefined) {
      throw new Error('expected resolved environment in ctx');
    }
    return ['echo', `${env.sshUser}@${env.host}:${args.line}`];
  },
  parseResult: (raw) => raw.stdout,
};

const echoPath: Action<{ path: string }, string> = {
  name: 'fake.echo_path',
  tier: 'read',
  description: 'echoes a path',
  argsSchema: z.object({ path: z.string() }),
  buildCommand: (args) => ['echo', args.path],
  parseResult: (raw) => raw.stdout,
};

const sleepAction: Action<{ seconds: number }, string> = {
  name: 'fake.sleep',
  tier: 'read',
  description: 'sleeps N seconds',
  argsSchema: z.object({ seconds: z.number() }),
  buildCommand: (args) => ['sleep', String(args.seconds)],
  parseResult: (raw) => raw.stdout,
};

const mutateNoop: Action<Record<string, never>, string> = {
  name: 'fake.mutate_noop',
  tier: 'mutate',
  description: 'a mutate-tier no-op (echo)',
  argsSchema: z.object({}).strict(),
  buildCommand: () => ['echo', 'noop'],
  parseResult: (raw) => raw.stdout,
};

const echoFreeform: Action<{ payload: string }, string> = {
  name: 'fake.echo_freeform',
  tier: 'read',
  description: 'echoes any string payload',
  argsSchema: z.object({ payload: z.string() }),
  buildCommand: (args) => ['echo', args.payload],
  parseResult: (raw) => raw.stdout,
};

const echoSecretLiteral: Action<Record<string, never>, string> = {
  name: 'fake.echo_secret_literal',
  tier: 'read',
  description: 'echoes a fixed secret-shaped literal (output-scrub test fixture)',
  argsSchema: z.object({}).strict(),
  buildCommand: () => ['echo', 'leaked sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA tail'],
  parseResult: (raw) => raw.stdout,
};

// Full-flow mutate fixture: every hook is wired and produces a known string,
// so the tests can assert which step ran (snapshot/dryrun/exec/verify/rollback)
// by inspecting the audit log and the result.mutation meta. `verifyShouldFail`
// flips the verify hook to exit 1, exercising the rollback path.
function makeMutateFixture(opts: { verifyShouldFail: boolean; tier?: 'mutate' | 'destructive' } = {
  verifyShouldFail: false,
}): Action<{ key: string }, string> {
  return {
    name: opts.tier === 'destructive' ? 'fake.destructive_full' : 'fake.mutate_full',
    tier: opts.tier ?? 'mutate',
    description: 'full-flow mutate fixture with snapshot/dryrun/verify/rollback',
    argsSchema: z.object({ key: z.string() }),
    buildSnapshotCommand: (args) => ['echo', `snapshot:${args.key}`],
    buildDryRunCommand: (args) => ['echo', `dryrun:${args.key}`],
    buildCommand: (args) => ['echo', `exec:${args.key}`],
    buildVerifyCommand: opts.verifyShouldFail
      ? () => ['sh', '-c', 'exit 1']
      : (args) => ['echo', `verify:${args.key}`],
    buildRollbackCommand: (args) => ['echo', `rollback:${args.key}`],
    parseResult: (raw) => raw.stdout,
  };
}

describe('exec/executor — refusals', () => {
  test('unknown action is refused with reason unknown-action', async () => {
    const { executor, sessionId, db } = await setupTest();

    let caught: unknown;
    try {
      await executor.exec('not.registered', {}, { sessionId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('unknown-action');

    const audit = await db.query<{ kind: string; refused_reason: string | null }>(
      `SELECT kind, refused_reason FROM audit_log WHERE session_id = $1`,
      [sessionId],
    );
    expect(audit.rows[0]?.kind).toBe('refuse');
    expect(audit.rows[0]?.refused_reason).toContain('unknown-action');
  });

  test('args that fail the zod schema are refused with reason invalid-args', async () => {
    const { catalog, executor, sessionId } = await setupTest();
    catalog.register(echo);

    let caught: unknown;
    try {
      await executor.exec('fake.echo', { line: 42 }, { sessionId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('invalid-args');
  });

  test('args containing a recognizable secret are refused with reason secret-in-args', async () => {
    const { catalog, executor, sessionId } = await setupTest();
    catalog.register(echoFreeform);

    let caught: unknown;
    try {
      await executor.exec(
        'fake.echo_freeform',
        { payload: 'AKIAIOSFODNN7EXAMPLE' },
        { sessionId },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecError);
    const e = caught as ExecError;
    expect(e.reason).toBe('secret-in-args');
    expect(e.details['kinds']).toContain('aws-access-key');
  });

  test('args.path in the denylist is refused with reason path-denied', async () => {
    const { catalog, executor, sessionId } = await setupTest();
    catalog.register(echoPath);

    let caught: unknown;
    try {
      await executor.exec('fake.echo_path', { path: '~/.ssh/id_rsa' }, { sessionId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('path-denied');
    expect((caught as ExecError).details['path']).toBe('~/.ssh/id_rsa');
  });

  test('args.environment not in the registry is refused with reason environment-not-found', async () => {
    const { catalog, executor, sessionId } = await setupTest();
    catalog.register(echoEnv);

    let caught: unknown;
    try {
      await executor.exec(
        'fake.echo_env',
        { environment: 'ghost', line: 'x' },
        { sessionId },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('environment-not-found');
    expect((caught as ExecError).details['environment']).toBe('ghost');
  });

  test('mutate-tier action is refused when allowedTiers = [read]', async () => {
    const { catalog, sessionId, makeExecutor } = await setupTest();
    catalog.register(mutateNoop);
    const executor = makeExecutor({ allowedTiers: ['read'] });

    let caught: unknown;
    try {
      await executor.exec('fake.mutate_noop', {}, { sessionId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('tier-not-allowed');
  });

  test('long-running action exceeding timeoutMs is killed with reason timeout', async () => {
    const { catalog, executor, sessionId } = await setupTest();
    catalog.register(sleepAction);

    let caught: unknown;
    try {
      await executor.exec('fake.sleep', { seconds: 5 }, { sessionId, timeoutMs: 100 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('timeout');
  });
});

describe('exec/executor — happy path', () => {
  test('successful exec returns scrubbed result, writes exec audit row + evidence row', async () => {
    const { catalog, executor, sessionId, db } = await setupTest();
    catalog.register(echo);

    const result = await executor.exec('fake.echo', { line: 'hello' }, { sessionId });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
    expect(typeof result.auditId).toBe('number');
    expect(typeof result.evidenceId).toBe('number');
    expect(result.durationMs).toBeGreaterThan(0);

    const audit = await db.query<{
      kind: string;
      action_name: string;
      command_scrubbed: string | null;
      exit_code: number | null;
    }>(
      `SELECT kind, action_name, command_scrubbed, exit_code
         FROM audit_log WHERE session_id = $1`,
      [sessionId],
    );
    expect(audit.rows[0]?.kind).toBe('exec');
    expect(audit.rows[0]?.action_name).toBe('fake.echo');
    expect(audit.rows[0]?.command_scrubbed).toContain('echo hello');
    expect(audit.rows[0]?.exit_code).toBe(0);

    const evidence = await db.query<{ stdout_scrubbed: string }>(
      `SELECT stdout_scrubbed FROM evidence WHERE session_id = $1`,
      [sessionId],
    );
    expect(evidence.rows[0]?.stdout_scrubbed.trim()).toBe('hello');
  });

  test('output containing a known secret is scrubbed before reaching evidence and result', async () => {
    const { catalog, executor, sessionId, db } = await setupTest();
    catalog.register(echoSecretLiteral);

    const result = await executor.exec('fake.echo_secret_literal', {}, { sessionId });

    expect(result.stdout).toContain('[REDACTED:anthropic-key]');
    expect(result.stdout).not.toContain('sk-ant-api03');

    const evidence = await db.query<{ stdout_scrubbed: string }>(
      `SELECT stdout_scrubbed FROM evidence WHERE session_id = $1`,
      [sessionId],
    );
    expect(evidence.rows[0]?.stdout_scrubbed).toContain('[REDACTED:anthropic-key]');
    expect(evidence.rows[0]?.stdout_scrubbed).not.toContain('sk-ant-api03');

    const audit = await db.query<{ command_scrubbed: string | null }>(
      `SELECT command_scrubbed FROM audit_log WHERE session_id = $1 AND kind = 'exec'`,
      [sessionId],
    );
    expect(audit.rows[0]?.command_scrubbed).not.toContain('sk-ant-api03');
    expect(audit.rows[0]?.command_scrubbed).toContain('[REDACTED:anthropic-key]');
  });

  test('args.environment present in the registry resolves and runs', async () => {
    const { catalog, executor, sessionId } = await setupTest();
    catalog.register(echoEnv);

    const result = await executor.exec(
      'fake.echo_env',
      { environment: 'allowed', line: 'ok' },
      { sessionId },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('deploy@allowed.example.com:ok');
  });
});

describe('exec/executor — audit-log invariants', () => {
  test('every refusal persists exactly one audit_log row with kind=refuse', async () => {
    const { catalog, executor, sessionId, db } = await setupTest();
    catalog.register(echo);

    const attempts: { name: string; args: unknown }[] = [
      { name: 'not.in.catalog', args: {} },
      { name: 'fake.echo', args: { line: 99 } },
    ];
    for (const a of attempts) {
      try {
        await executor.exec(a.name, a.args, { sessionId });
      } catch {
        // expected
      }
    }

    const audit = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_log
         WHERE session_id = $1 AND kind = 'refuse'`,
      [sessionId],
    );
    expect(Number(audit.rows[0]?.count ?? '0')).toBe(attempts.length);
  });

  test('refused args are scrubbed before persistence (no secret in audit row)', async () => {
    const { catalog, executor, sessionId, db } = await setupTest();
    catalog.register(echoFreeform);

    try {
      await executor.exec(
        'fake.echo_freeform',
        { payload: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA' },
        { sessionId },
      );
    } catch {
      // expected
    }

    const audit = await db.query<{ args_scrubbed_json: unknown }>(
      `SELECT args_scrubbed_json FROM audit_log WHERE session_id = $1`,
      [sessionId],
    );
    const serialized = JSON.stringify(audit.rows[0]?.args_scrubbed_json ?? null);
    expect(serialized).not.toContain('sk-ant-api03');
  });
});

describe('exec/executor — mutation HITL flow (M2)', () => {
  test('mutate action with no approval callback is refused with mutation-no-approval', async () => {
    const { catalog, sessionId, makeExecutor } = await setupTest();
    const fixture = makeMutateFixture();
    catalog.register(fixture);
    const executor = makeExecutor(); // no onMutationProposal

    let caught: unknown;
    try {
      await executor.exec(fixture.name, { key: 'a' }, { sessionId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('mutation-no-approval');
  });

  test('mutate action rejected by user surfaces mutation-rejected and runs neither execute nor verify', async () => {
    const { catalog, db, sessionId, makeExecutor } = await setupTest();
    const fixture = makeMutateFixture();
    catalog.register(fixture);
    const executor = makeExecutor({
      onMutationProposal: async () => ({ kind: 'reject', reason: 'no thanks' }),
    });

    let caught: unknown;
    try {
      await executor.exec(fixture.name, { key: 'a' }, { sessionId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('mutation-rejected');

    const kinds = await db.query<{ kind: string }>(
      `SELECT kind FROM audit_log WHERE session_id = $1 ORDER BY id`,
      [sessionId],
    );
    const kindList = kinds.rows.map((r) => r.kind);
    expect(kindList).toContain('mutate-snapshot');
    expect(kindList).toContain('mutate-dryrun');
    expect(kindList).toContain('mutate-proposed');
    expect(kindList).toContain('mutate-rejected');
    expect(kindList).not.toContain('mutate-execute');
    expect(kindList).not.toContain('mutate-verify');
    expect(kindList).not.toContain('mutate-rollback');
  });

  test('approval callback receives scrubbed command + dry-run + snapshot output', async () => {
    const { catalog, sessionId, makeExecutor } = await setupTest();
    const fixture = makeMutateFixture();
    catalog.register(fixture);

    const captured: { proposal?: unknown } = {};
    const executor = makeExecutor({
      onMutationProposal: async (proposal) => {
        captured.proposal = proposal;
        return { kind: 'reject' };
      },
    });

    try {
      await executor.exec(fixture.name, { key: 'banana' }, { sessionId });
    } catch {
      // rejected — expected
    }

    const p = captured.proposal as {
      actionName: string;
      tier: string;
      commandScrubbed: string;
      snapshotOutput?: string;
      dryRunOutput?: string;
    };
    expect(p.actionName).toBe(fixture.name);
    expect(p.tier).toBe('mutate');
    expect(p.commandScrubbed).toContain('exec:banana');
    expect(p.snapshotOutput).toContain('snapshot:banana');
    expect(p.dryRunOutput).toContain('dryrun:banana');
  });

  test('mutate approved + verify OK: execute runs, no rollback, no remembered flag for approve-once', async () => {
    const { catalog, db, sessionId, makeExecutor } = await setupTest();
    const fixture = makeMutateFixture();
    catalog.register(fixture);
    const executor = makeExecutor({
      onMutationProposal: async () => ({ kind: 'approve-once' }),
    });

    const result = await executor.exec(fixture.name, { key: 'x' }, { sessionId });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('exec:x');
    expect(result.mutation?.rolledBack).toBe(false);
    expect(result.mutation?.remembered).toBe(false);
    expect(result.mutation?.verifyExitCode).toBe(0);

    const kinds = await db.query<{ kind: string }>(
      `SELECT kind FROM audit_log WHERE session_id = $1 ORDER BY id`,
      [sessionId],
    );
    const kindList = kinds.rows.map((r) => r.kind);
    expect(kindList).toEqual([
      'mutate-snapshot',
      'mutate-dryrun',
      'mutate-proposed',
      'mutate-execute',
      'mutate-verify',
    ]);
  });

  test('mutate approved + verify FAILS: rollback fires, ExecError reason=verify-failed, mutation.rolledBack=true', async () => {
    const { catalog, db, sessionId, makeExecutor } = await setupTest();
    const fixture = makeMutateFixture({ verifyShouldFail: true });
    catalog.register(fixture);
    const executor = makeExecutor({
      onMutationProposal: async () => ({ kind: 'approve-once' }),
    });

    let caught: unknown;
    try {
      await executor.exec(fixture.name, { key: 'x' }, { sessionId });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExecError);
    expect((caught as ExecError).reason).toBe('verify-failed');
    expect(((caught as ExecError).details as { rolledBack?: boolean }).rolledBack).toBe(true);

    const kinds = await db.query<{ kind: string }>(
      `SELECT kind FROM audit_log WHERE session_id = $1 ORDER BY id`,
      [sessionId],
    );
    const kindList = kinds.rows.map((r) => r.kind);
    expect(kindList).toContain('mutate-execute');
    expect(kindList).toContain('mutate-verify');
    expect(kindList).toContain('mutate-rollback');
  });

  test('mutate approve-remember: mutation.remembered=true on tier=mutate', async () => {
    const { catalog, sessionId, makeExecutor } = await setupTest();
    const fixture = makeMutateFixture();
    catalog.register(fixture);
    const executor = makeExecutor({
      onMutationProposal: async () => ({ kind: 'approve-remember' }),
    });

    const result = await executor.exec(fixture.name, { key: 'x' }, { sessionId });
    expect(result.mutation?.remembered).toBe(true);
  });

  test('destructive approve-remember is downgraded to approve-once (never remembered)', async () => {
    const { catalog, sessionId, makeExecutor } = await setupTest();
    const fixture = makeMutateFixture({ verifyShouldFail: false, tier: 'destructive' });
    catalog.register(fixture);
    const executor = makeExecutor({
      onMutationProposal: async () => ({ kind: 'approve-remember' }),
    });

    const result = await executor.exec(fixture.name, { key: 'x' }, { sessionId });
    // remembered MUST stay false for destructive — this is the central
    // safety property of the three-tier permission model.
    expect(result.mutation?.remembered).toBe(false);
  });
});
