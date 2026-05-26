import type { PGlite, Transaction } from '@electric-sql/pglite';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: `
      CREATE EXTENSION IF NOT EXISTS vector;

      CREATE TABLE sessions (
        id                   TEXT        PRIMARY KEY,
        started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        ended_at             TIMESTAMPTZ,
        cost_usd_total       NUMERIC(12, 6) NOT NULL DEFAULT 0,
        config_snapshot_json JSONB       NOT NULL,
        title                TEXT,
        last_active_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE audit_log (
        id                   BIGSERIAL   PRIMARY KEY,
        session_id           TEXT        NOT NULL REFERENCES sessions(id),
        ts                   TIMESTAMPTZ NOT NULL DEFAULT now(),
        kind                 TEXT        NOT NULL CHECK (kind IN ('exec', 'refuse', 'error')),
        action_name          TEXT        NOT NULL,
        args_scrubbed_json   JSONB       NOT NULL,
        command_scrubbed     TEXT,
        exit_code            INTEGER,
        refused_reason       TEXT
      );
      CREATE INDEX audit_log_session_ts ON audit_log (session_id, ts);

      CREATE TABLE evidence (
        id                   BIGSERIAL   PRIMARY KEY,
        session_id           TEXT        NOT NULL REFERENCES sessions(id),
        action_id            BIGINT      NOT NULL REFERENCES audit_log(id),
        stdout_scrubbed      TEXT        NOT NULL DEFAULT '',
        stderr_scrubbed      TEXT        NOT NULL DEFAULT '',
        ts                   TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX evidence_session ON evidence (session_id);

      CREATE TABLE env_state (
        key                  TEXT        PRIMARY KEY,
        value_json           JSONB       NOT NULL,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE llm_calls (
        id                   BIGSERIAL   PRIMARY KEY,
        session_id           TEXT        NOT NULL REFERENCES sessions(id),
        ts                   TIMESTAMPTZ NOT NULL DEFAULT now(),
        model                TEXT        NOT NULL,
        role                 TEXT        NOT NULL,
        input_tokens         INTEGER     NOT NULL,
        output_tokens        INTEGER     NOT NULL,
        cost_usd             NUMERIC(12, 6) NOT NULL DEFAULT 0,
        payload_hash         TEXT        NOT NULL
      );
      CREATE INDEX llm_calls_session_ts ON llm_calls (session_id, ts);

      CREATE TABLE config_overrides (
        key                  TEXT        PRIMARY KEY,
        value_json           JSONB       NOT NULL,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE environments (
        name             TEXT        PRIMARY KEY,
        host             TEXT        NOT NULL,
        ssh_user         TEXT        NOT NULL,
        port             INTEGER,
        identity_file    TEXT,
        description      TEXT,
        tags             JSONB       NOT NULL DEFAULT '[]'::jsonb,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE chat_messages (
        id            BIGSERIAL   PRIMARY KEY,
        session_id    TEXT        NOT NULL REFERENCES sessions(id),
        ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
        role          TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
        kind          TEXT        NOT NULL CHECK (kind IN ('prompt', 'report', 'summary', 'session-report')),
        content       TEXT        NOT NULL,
        covers_until  BIGINT
      );
      CREATE INDEX chat_messages_session_ts ON chat_messages (session_id, ts);

      CREATE TABLE rag_documents (
        id            BIGSERIAL   PRIMARY KEY,
        source        TEXT        NOT NULL,
        kind          TEXT        NOT NULL CHECK (kind IN ('runbook', 'adr', 'session-summary', 'note', 'solved-case')),
        chunk_index   INTEGER     NOT NULL,
        heading_path  TEXT        NOT NULL DEFAULT '',
        content       TEXT        NOT NULL,
        embedding     vector(768) NOT NULL,
        content_hash  TEXT        NOT NULL,
        model_id      TEXT        NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (source, chunk_index)
      );

      CREATE INDEX rag_documents_source     ON rag_documents (source);
      CREATE INDEX rag_documents_kind       ON rag_documents (kind);
      CREATE INDEX rag_documents_embedding  ON rag_documents
        USING hnsw (embedding vector_cosine_ops);

      -- /resume + listRecent sort by last activity descending.
      CREATE INDEX sessions_last_active_at  ON sessions (last_active_at DESC);

      -- FK column on evidence — joins from audit_log → evidence are common.
      CREATE INDEX evidence_action_id       ON evidence (action_id);

      -- Compaction looks up the most recent summary per session.
      CREATE INDEX chat_messages_session_kind_id
        ON chat_messages (session_id, kind, id);
    `,
  },
];

const MIGRATIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    version    INTEGER     PRIMARY KEY,
    name       TEXT        NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

export async function runMigrations(db: PGlite): Promise<readonly Migration[]> {
  await db.exec(MIGRATIONS_TABLE_DDL);

  const current = await db.query<{ version: number }>(
    'SELECT version FROM _migrations ORDER BY version DESC LIMIT 1',
  );
  const currentVersion = current.rows[0]?.version ?? 0;

  const pending = [...MIGRATIONS]
    .sort((a, b) => a.version - b.version)
    .filter((m) => m.version > currentVersion);
  const applied: Migration[] = [];

  for (const migration of pending) {
    await db.transaction(async (tx: Transaction) => {
      await tx.exec(migration.up);
      await tx.query('INSERT INTO _migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
    });
    applied.push(migration);
  }

  return applied;
}

export async function appliedVersions(db: PGlite): Promise<number[]> {
  await db.exec(MIGRATIONS_TABLE_DDL);
  const result = await db.query<{ version: number }>(
    'SELECT version FROM _migrations ORDER BY version ASC',
  );
  return result.rows.map((r) => r.version);
}
