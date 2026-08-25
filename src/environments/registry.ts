import type { PGlite } from '@electric-sql/pglite';

import { LOCAL_ENVIRONMENT, isLocalEnvironmentName } from './local.ts';

import {
  type Environment,
  type EnvironmentInput,
  validateEnvironmentInput,
} from './types.ts';

interface EnvironmentRow {
  readonly name: string;
  readonly host: string;
  readonly ssh_user: string;
  readonly port: number | null;
  readonly identity_file: string | null;
  readonly description: string | null;
  readonly tags: unknown;
}

function rowToEnvironment(row: EnvironmentRow): Environment {
  const tags = Array.isArray(row.tags)
    ? row.tags.filter((t): t is string => typeof t === 'string')
    : [];
  const env: {
    name: string;
    host: string;
    sshUser: string;
    port?: number;
    identityFile?: string;
    description?: string;
    tags: readonly string[];
  } = {
    name: row.name,
    host: row.host,
    sshUser: row.ssh_user,
    tags,
  };
  if (row.port !== null) env.port = row.port;
  if (row.identity_file !== null) env.identityFile = row.identity_file;
  if (row.description !== null) env.description = row.description;
  return env;
}

export interface ListFilter {
  readonly tag?: string;
}

export interface EnvironmentRegistry {
  upsert(input: EnvironmentInput): Promise<Environment>;
  remove(name: string): Promise<boolean>;
  get(name: string): Promise<Environment | null>;
  list(filter?: ListFilter): Promise<readonly Environment[]>;
  describeForLLM(): Promise<string>;
}

export function createEnvironmentRegistry(db: PGlite): EnvironmentRegistry {
  async function upsert(input: EnvironmentInput): Promise<Environment> {
    validateEnvironmentInput(input);
    const tagsJson = JSON.stringify(input.tags ?? []);

    await db.query(
      `INSERT INTO environments
         (name, host, ssh_user, port, identity_file, description, tags, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
       ON CONFLICT (name) DO UPDATE SET
         host          = EXCLUDED.host,
         ssh_user      = EXCLUDED.ssh_user,
         port          = EXCLUDED.port,
         identity_file = EXCLUDED.identity_file,
         description   = EXCLUDED.description,
         tags          = EXCLUDED.tags,
         updated_at    = now()`,
      [
        input.name,
        input.host,
        input.sshUser,
        input.port ?? null,
        input.identityFile ?? null,
        input.description ?? null,
        tagsJson,
      ],
    );

    const result = await db.query<EnvironmentRow>(
      `SELECT name, host, ssh_user, port, identity_file, description, tags
         FROM environments WHERE name = $1`,
      [input.name],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`upsert succeeded but row not found: ${input.name}`);
    }
    return rowToEnvironment(row);
  }

  async function remove(name: string): Promise<boolean> {
    const result = await db.query(
      `DELETE FROM environments WHERE name = $1`,
      [name],
    );
    return (result.affectedRows ?? 0) > 0;
  }

  async function get(name: string): Promise<Environment | null> {
    // Resolved before the DB is consulted. `local` can never be a row — the
    // name is reserved in validateEnvironmentInput — but short-circuiting here
    // means a direct DB write could not shadow it either.
    if (isLocalEnvironmentName(name)) return LOCAL_ENVIRONMENT;

    const result = await db.query<EnvironmentRow>(
      `SELECT name, host, ssh_user, port, identity_file, description, tags
         FROM environments WHERE name = $1`,
      [name],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return rowToEnvironment(row);
  }

  async function list(filter?: ListFilter): Promise<readonly Environment[]> {
    const result = await db.query<EnvironmentRow>(
      `SELECT name, host, ssh_user, port, identity_file, description, tags
         FROM environments ORDER BY name ASC`,
    );
    const all = result.rows.map(rowToEnvironment);
    if (filter?.tag === undefined) return all;
    const wantedTag = filter.tag;
    return all.filter((e) => e.tags.includes(wantedTag));
  }

  async function describeForLLM(): Promise<string> {
    const envs = await list();
    const lines = envs.map((e) => {
      const port = e.port === undefined ? '' : `:${e.port}`;
      const tags = e.tags.length === 0 ? '' : ` [${e.tags.join(', ')}]`;
      const desc = e.description === undefined ? '' : ` — ${e.description}`;
      return `- ${e.name}: ${e.sshUser}@${e.host}${port}${tags}${desc}`;
    });

    // `local` is always available and always listed first. Before it existed,
    // a fresh install described itself as having nothing to work on, and the
    // planner correctly refused every request until an SSH host was registered.
    const localLine = `- ${LOCAL_ENVIRONMENT.name}: ${LOCAL_ENVIRONMENT.description}`;
    const hint =
      envs.length === 0
        ? '\n\nNo remote hosts are registered yet, so `local` is the only target.'
        : '';

    return `Available environments (${envs.length + 1}):\n${[localLine, ...lines].join('\n')}${hint}`;
  }

  return { upsert, remove, get, list, describeForLLM };
}
