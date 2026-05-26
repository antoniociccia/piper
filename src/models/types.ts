export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface ChatMessage {
  readonly role: Role;
  readonly content: string;
  readonly toolCallId?: string;
  readonly name?: string;
  readonly toolCalls?: readonly ToolCall[];
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { readonly type: 'function'; readonly name: string };

export interface CompleteRequest {
  readonly messages: readonly ChatMessage[];
  readonly model?: string;
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: ToolChoice;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stop?: readonly string[];
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'unknown';

export interface UsageStats {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface Completion {
  readonly id: string;
  readonly model: string;
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: UsageStats;
  readonly costUsd: number;
}

export interface CompletionChunk {
  readonly contentDelta?: string;
  readonly toolCallDeltas?: readonly ToolCallDelta[];
  readonly finishReason?: FinishReason;
  readonly usage?: UsageStats;
}

export interface ToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsDelta?: string;
}

export type CostEstimate =
  | { readonly free: true }
  | { readonly free: false; readonly minUsd: number; readonly maxUsd: number };

export interface ModelCapabilities {
  readonly toolCalling: boolean;
  readonly maxContextTokens: number;
  readonly streaming: boolean;
}

export interface RemoteCredit {
  /** Total credits added to the account (null = uncapped / pay-as-you-go). */
  readonly totalCredits: number | null;
  /** Total usage to date in USD. */
  readonly totalUsage: number;
  /** Remaining = totalCredits - totalUsage when totalCredits is set, else null. */
  readonly remaining: number | null;
  /** Provider that produced this snapshot. */
  readonly provider: string;
}

export interface ModelClient {
  readonly id: string;
  readonly modelId: string;
  readonly isLocal: boolean;
  readonly capabilities: ModelCapabilities;
  complete(req: CompleteRequest): Promise<Completion>;
  stream(req: CompleteRequest): AsyncIterable<CompletionChunk>;
  estimateCost(req: CompleteRequest): CostEstimate;
  /**
   * Optional: fetch the upstream provider's remaining credit/budget.
   * Implemented for OpenRouter; returns null for local providers or on error.
   */
  getRemoteCredit?(): Promise<RemoteCredit | null>;
}
