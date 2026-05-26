import { encode, encodeChat } from 'gpt-tokenizer';

import type { ChatMessage, ToolDefinition } from '../models/types.ts';

/**
 * Token-counting helpers used by the compaction trigger and the TUI meter.
 *
 * We use `gpt-tokenizer` with the `cl100k_base` encoding (GPT-4 family) as a
 * universal approximation across providers — actual token counts on Anthropic,
 * DeepSeek, Qwen and Moonshot diverge by ~5–10% but the meter only needs to be
 * directionally correct to drive compaction. For per-call billing we always
 * use the provider-returned `usage` field, never this estimate.
 */

/** Count tokens in a single text blob. */
export function countTokens(text: string): number {
  if (text === '') return 0;
  try {
    return encode(text).length;
  } catch {
    // Defensive: in case gpt-tokenizer hiccups on a weird input, fall back to chars/4.
    return Math.ceil(text.length / 4);
  }
}

/**
 * Count tokens for a full chat-completions request: messages + tool definitions.
 * Uses encodeChat for the messages (handles role overhead), then adds per-tool overhead.
 */
export function countMessagesTokens(
  messages: readonly ChatMessage[],
  tools?: readonly ToolDefinition[],
): number {
  let total = 0;

  if (messages.length > 0) {
    // encodeChat expects role + content; tool messages get content '' if absent.
    const formatted = messages.map((m) => ({
      role: m.role === 'tool' ? 'tool' : m.role,
      content: m.content,
      ...(m.name === undefined ? {} : { name: m.name }),
    }));
    try {
      total += encodeChat(formatted as never, 'gpt-4').length;
    } catch {
      for (const m of messages) total += countTokens(m.content) + 4;
    }
  }

  if (tools !== undefined && tools.length > 0) {
    // Empirical: each tool def with name + description + JSON schema costs
    // roughly 30 tokens of overhead plus content.
    for (const tool of tools) {
      const blob = `${tool.name}\n${tool.description}\n${JSON.stringify(tool.parameters ?? {})}`;
      total += countTokens(blob) + 12;
    }
    // The "tools array wrapper" overhead in the API.
    total += 10;
  }

  return total;
}

/** Format a token count for display: `12,345` / `200k`. */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return n.toLocaleString('en-US');
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatTokenLimit(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
