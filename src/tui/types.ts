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
  | { readonly kind: 'report-end'; readonly id: string; readonly verified: boolean };

export type ViewState =
  | { readonly screen: 'chat'; readonly busy: boolean; readonly costUsd: number; readonly entries: readonly ChatEntry[] }
  | { readonly screen: 'help' };
