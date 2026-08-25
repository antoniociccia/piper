import type { AgentEvent } from '../agent/types.ts';

export type ChatEntry =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'info'; readonly id: string; readonly text: string }
  | { readonly kind: 'error'; readonly id: string; readonly text: string }
  | { readonly kind: 'agent-event'; readonly id: string; readonly event: AgentEvent }
  | { readonly kind: 'report'; readonly id: string; readonly markdown: string; readonly verified: boolean }
  // Streaming report rendered as append-only line-by-line entries:
  | { readonly kind: 'report-start'; readonly id: string }
  | { readonly kind: 'report-line'; readonly id: string; readonly text: string }
  // An aligned table. Emitted only once its last row has arrived, because the
  // column widths depend on every row — a table cannot stream row by row.
  | { readonly kind: 'report-table'; readonly id: string; readonly lines: readonly string[] }
  // Carries the assembled markdown so `/save` and archiving have the report
  // even though it was rendered line by line and never as one block.
  | {
      readonly kind: 'report-end';
      readonly id: string;
      readonly verified: boolean;
      readonly markdown: string;
    };

export type ViewState =
  | { readonly screen: 'chat'; readonly busy: boolean; readonly costUsd: number; readonly entries: readonly ChatEntry[] }
  | { readonly screen: 'help' };
