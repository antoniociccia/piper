export type SessionId = string;
export type AuditLogId = number;
export type EvidenceId = number;
export type LlmCallId = number;

export type AuditKind = 'exec' | 'refuse' | 'error';

export interface SessionRow {
  id: SessionId;
  started_at: string;
  ended_at: string | null;
  cost_usd_total: string;
  config_snapshot_json: unknown;
}

export interface AuditLogRow {
  id: AuditLogId;
  session_id: SessionId;
  ts: string;
  kind: AuditKind;
  action_name: string;
  args_scrubbed_json: unknown;
  command_scrubbed: string | null;
  exit_code: number | null;
  refused_reason: string | null;
}

export interface EvidenceRow {
  id: EvidenceId;
  session_id: SessionId;
  action_id: AuditLogId;
  stdout_scrubbed: string;
  stderr_scrubbed: string;
  ts: string;
}

export interface EnvStateRow {
  key: string;
  value_json: unknown;
  updated_at: string;
}

export interface LlmCallRow {
  id: LlmCallId;
  session_id: SessionId;
  ts: string;
  model: string;
  role: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: string;
  payload_hash: string;
}

export interface ConfigOverrideRow {
  key: string;
  value_json: unknown;
  updated_at: string;
}

export interface MigrationRow {
  version: number;
  name: string;
  applied_at: string;
}

export type ChatRole = 'user' | 'assistant';
export type ChatKind = 'prompt' | 'report' | 'summary' | 'session-report';

export type RagDocKind = 'runbook' | 'adr' | 'session-summary' | 'note' | 'solved-case';

export interface RagDocumentRow {
  id: number;
  source: string;
  kind: RagDocKind;
  chunk_index: number;
  heading_path: string;
  content: string;
  embedding: unknown;
  content_hash: string;
  model_id: string;
  created_at: string;
}

export interface ChatMessageRow {
  id: number;
  session_id: SessionId;
  ts: string;
  role: ChatRole;
  kind: ChatKind;
  content: string;
}
