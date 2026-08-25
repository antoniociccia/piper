import { ENV_VARS } from '../config/env-vars.ts';
import { scrubText } from '../security/scrub.ts';

import { computeCost, getPricing } from './pricing.ts';
import {
  type ChatMessage,
  type CompleteRequest,
  type Completion,
  type CompletionChunk,
  type CostEstimate,
  type FinishReason,
  type ModelCapabilities,
  type ModelClient,
  type RemoteCredit,
  type ToolCall,
  type ToolCallDelta,
  type UsageStats,
} from './types.ts';

export type FetchLike = typeof fetch;

export interface OpenAIChatClientOptions {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly defaultModel: string;
  readonly capabilities: ModelCapabilities;
  readonly isLocal: boolean;
  /**
   * Sent as `reasoning_effort`. `'none'` is what makes a thinking model answer
   * instead of spending its whole token budget on a chain of thought that
   * never reaches `content` — ollama honours it, llama.cpp accepts it, and
   * `think: false` / `enable_thinking: false` are both ignored. Omitted from
   * the request entirely when unset.
   */
  readonly reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  readonly enforcePrivacyDeny?: boolean;
  readonly scrubUserPatterns?: readonly RegExp[];
  readonly fetch?: FetchLike;
  readonly headers?: Readonly<Record<string, string>>;
}

interface OpenAIChatChoiceMessage {
  readonly role?: string;
  readonly content?: string | null;
  /**
   * Non-standard, returned by ollama (and some proxies) for reasoning models:
   * the chain of thought goes here and `content` is left empty. Read only to
   * diagnose an empty answer — never used AS the answer.
   */
  readonly reasoning?: string | null;
  readonly reasoning_content?: string | null;
  readonly tool_calls?: ReadonlyArray<{
    readonly id?: string;
    readonly type?: string;
    readonly function?: { readonly name?: string; readonly arguments?: string };
  }>;
}

/**
 * Remove a reasoning model's thinking from an answer.
 *
 * Two shapes seen in the wild: a properly matched `<think>…</think>` block, and
 * — when reasoning is disabled but the chat template still emits the closing
 * marker — a preamble terminated by an orphan `</think>`. Both must go, or the
 * thinking ends up quoted in a user-facing report.
 *
 * An orphan tag is only treated as a terminator when nothing opened a block and
 * it sits on its own line, so prose that merely mentions the token mid-sentence
 * (a log line, say) survives intact.
 */
export function stripReasoning(content: string): string {
  const withoutBlocks = content.replace(/<think>[\s\S]*?<\/think>/g, '');

  if (!withoutBlocks.includes('</think>')) return withoutBlocks.trim();

  const orphan = /^[\s\S]*?(?:^|\n)\s*<\/think>\s*(?:\n|$)/;
  const match = orphan.exec(withoutBlocks);
  if (match !== null) return withoutBlocks.slice(match[0].length).trim();

  return withoutBlocks.trim();
}

interface OpenAIChatChoice {
  readonly index?: number;
  readonly message?: OpenAIChatChoiceMessage;
  readonly delta?: OpenAIChatChoiceMessage;
  readonly finish_reason?: string | null;
}

interface OpenAIChatResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices?: readonly OpenAIChatChoice[];
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
  };
}

function normalizeFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

function parseToolCalls(
  raw: OpenAIChatChoiceMessage | undefined,
): readonly ToolCall[] {
  const list = raw?.tool_calls;
  if (list === undefined) return [];
  return list.flatMap((tc) => {
    const name = tc.function?.name;
    if (name === undefined) return [];
    let args: unknown = {};
    if (typeof tc.function?.arguments === 'string' && tc.function.arguments !== '') {
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        args = { _rawArguments: tc.function.arguments };
      }
    }
    return [{ id: tc.id ?? `call_${Date.now()}`, name, arguments: args }];
  });
}

function buildMessagesBody(
  messages: readonly ChatMessage[],
  userPatterns: readonly RegExp[],
): unknown[] {
  return messages.map((m) => {
    const scrubbed = scrubText(m.content, userPatterns);
    const base: Record<string, unknown> = { role: m.role, content: scrubbed };
    if (m.name !== undefined) base['name'] = m.name;
    if (m.toolCallId !== undefined) base['tool_call_id'] = m.toolCallId;
    if (m.toolCalls !== undefined && m.toolCalls.length > 0) {
      base['tool_calls'] = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments ?? {}),
        },
      }));
    }
    return base;
  });
}

function buildToolsBody(req: CompleteRequest): unknown[] | undefined {
  if (req.tools === undefined || req.tools.length === 0) return undefined;
  return req.tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

function buildToolChoiceBody(req: CompleteRequest): unknown {
  const tc = req.toolChoice;
  if (tc === undefined) return undefined;
  if (tc === 'auto' || tc === 'none' || tc === 'required') return tc;
  return { type: 'function', function: { name: tc.name } };
}

function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function approxRequestInputTokens(req: CompleteRequest): number {
  let total = 0;
  for (const m of req.messages) {
    total += approxTokenCount(m.content);
    if (m.toolCalls !== undefined) {
      for (const tc of m.toolCalls) {
        total += approxTokenCount(JSON.stringify(tc.arguments ?? {}));
        total += approxTokenCount(tc.name);
      }
    }
  }
  if (req.tools !== undefined) {
    for (const t of req.tools) {
      total += approxTokenCount(t.name);
      total += approxTokenCount(t.description);
      total += approxTokenCount(JSON.stringify(t.parameters ?? {}));
    }
  }
  return total;
}

export class ModelClientError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = 'ModelClientError';
    this.status = status;
    this.body = body;
  }
}

export function createOpenAIChatClient(opts: OpenAIChatClientOptions): ModelClient {
  const userScrub = opts.scrubUserPatterns ?? [];
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const enforcePrivacyDeny = opts.enforcePrivacyDeny ?? false;

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(opts.headers ?? {}),
    };
    if (opts.apiKey !== undefined && opts.apiKey !== '') {
      h['Authorization'] = `Bearer ${opts.apiKey}`;
    }
    if (process.env[ENV_VARS.DEBUG_AUTH] === '1') {
      const hasAuth = h['Authorization'] !== undefined ? 'YES' : 'NO';
      const prefix = opts.apiKey === undefined ? 'undef' : `${opts.apiKey.slice(0, 12)}…(${opts.apiKey.length})`;
      process.stderr.write(`[piper:client] authHeader=${hasAuth} keyPrefix=${prefix}\n`);
    }
    return h;
  }

  function buildBody(req: CompleteRequest, streaming: boolean): unknown {
    const body: Record<string, unknown> = {
      model: req.model ?? opts.defaultModel,
      messages: buildMessagesBody(req.messages, userScrub),
    };
    const tools = buildToolsBody(req);
    if (tools !== undefined) body['tools'] = tools;
    const tc = buildToolChoiceBody(req);
    if (tc !== undefined) body['tool_choice'] = tc;
    if (req.maxTokens !== undefined) body['max_tokens'] = req.maxTokens;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.stop !== undefined && req.stop.length > 0) body['stop'] = req.stop;
    if (opts.reasoningEffort !== undefined) body['reasoning_effort'] = opts.reasoningEffort;
    if (streaming) {
      body['stream'] = true;
      body['stream_options'] = { include_usage: true };
    }
    if (enforcePrivacyDeny) {
      body['provider'] = { data_collection: 'deny' };
    }
    return body;
  }

  async function complete(req: CompleteRequest): Promise<Completion> {
    const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(buildBody(req, false)),
    });
    if (!response.ok) {
      const errorBody = await safeText(response);
      throw new ModelClientError(
        `${opts.id} upstream HTTP ${response.status}`,
        response.status,
        errorBody,
      );
    }
    const json = (await response.json()) as OpenAIChatResponse;
    const choice = json.choices?.[0];
    const msg = choice?.message ?? {};
    const usage: UsageStats = {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
    };
    const modelId = req.model ?? opts.defaultModel;
    const cost = computeCost(modelId, usage.inputTokens, usage.outputTokens).totalUsd;

    const rawContent = typeof msg.content === 'string' ? msg.content : '';
    const content = stripReasoning(rawContent);
    const toolCalls = parseToolCalls(msg);

    // A reasoning model that never stopped thinking returns empty content with
    // a populated `reasoning` field. Left alone it surfaces far downstream as
    // "the synthesizer failed to ground its report", which blames the model for
    // an answer it did produce and hides the real, fixable cause.
    const reasoning = msg.reasoning ?? msg.reasoning_content ?? '';
    if (content === '' && toolCalls.length === 0 && reasoning !== null && reasoning !== '') {
      throw new ModelClientError(
        `${opts.id} returned only reasoning and no answer ` +
          `(${reasoning.length} chars of chain-of-thought, finish_reason=${choice?.finish_reason ?? 'unknown'}). ` +
          `Set reasoning_effort to 'none' for this model, or raise its output token limit.`,
        200,
        reasoning.slice(0, 500),
      );
    }

    return {
      id: json.id ?? `local_${Date.now()}`,
      model: json.model ?? modelId,
      content,
      toolCalls,
      finishReason: normalizeFinishReason(choice?.finish_reason),
      usage,
      costUsd: cost,
    };
  }

  async function* stream(req: CompleteRequest): AsyncIterable<CompletionChunk> {
    const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(buildBody(req, true)),
    });
    if (!response.ok) {
      const errorBody = await safeText(response);
      throw new ModelClientError(
        `${opts.id} upstream HTTP ${response.status}`,
        response.status,
        errorBody,
      );
    }
    if (response.body === null) {
      throw new ModelClientError(`${opts.id} stream missing body`, response.status);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line === '' || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        let json: OpenAIChatResponse;
        try {
          json = JSON.parse(payload) as OpenAIChatResponse;
        } catch {
          continue;
        }
        const choice = json.choices?.[0];
        const delta = choice?.delta;
        const chunk: {
          contentDelta?: string;
          toolCallDeltas?: ToolCallDelta[];
          finishReason?: FinishReason;
          usage?: UsageStats;
        } = {};
        if (typeof delta?.content === 'string' && delta.content !== '') {
          chunk.contentDelta = delta.content;
        }
        if (delta?.tool_calls !== undefined) {
          chunk.toolCallDeltas = delta.tool_calls.map((tc, index) => ({
            index,
            ...(tc.id === undefined ? {} : { id: tc.id }),
            ...(tc.function?.name === undefined ? {} : { name: tc.function.name }),
            ...(tc.function?.arguments === undefined
              ? {}
              : { argumentsDelta: tc.function.arguments }),
          }));
        }
        if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
          chunk.finishReason = normalizeFinishReason(choice.finish_reason);
        }
        if (json.usage !== undefined) {
          chunk.usage = {
            inputTokens: json.usage.prompt_tokens ?? 0,
            outputTokens: json.usage.completion_tokens ?? 0,
          };
        }
        if (Object.keys(chunk).length > 0) yield chunk;
      }
    }
  }

  function estimateCost(req: CompleteRequest): CostEstimate {
    const modelId = req.model ?? opts.defaultModel;
    const pricing = getPricing(modelId);
    if (pricing === null || pricing.tier === 'local') {
      return { free: true };
    }
    const inputTokens = approxRequestInputTokens(req);
    const minOutputTokens = 16;
    const maxOutputTokens =
      req.maxTokens ?? Math.min(4096, pricing.maxContextTokens);
    const minCost = computeCost(modelId, inputTokens, minOutputTokens).totalUsd;
    const maxCost = computeCost(modelId, inputTokens, maxOutputTokens).totalUsd;
    return { free: false, minUsd: minCost, maxUsd: maxCost };
  }

  const baseFetch: FetchLike = opts.fetch ?? fetch;
  const baseUrl = opts.baseUrl;
  const apiKey = opts.apiKey;

  async function getRemoteCredit(): Promise<RemoteCredit | null> {
    if (opts.isLocal) return null;
    const looksLikeOpenRouter =
      opts.id === 'openrouter' || baseUrl.includes('openrouter.ai');
    if (!looksLikeOpenRouter) return null;
    if (apiKey === undefined || apiKey === '') return null;
    try {
      const res = await baseFetch(`${baseUrl.replace(/\/$/, '')}/credits`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        readonly data?: {
          readonly total_credits?: number;
          readonly total_usage?: number;
        };
      };
      const data = body.data;
      if (data === undefined) return null;
      const totalCredits = typeof data.total_credits === 'number' ? data.total_credits : null;
      const totalUsage = typeof data.total_usage === 'number' ? data.total_usage : 0;
      const remaining = totalCredits === null ? null : Math.max(0, totalCredits - totalUsage);
      return {
        totalCredits,
        totalUsage,
        remaining,
        provider: 'openrouter',
      };
    } catch {
      return null;
    }
  }

  return {
    id: opts.id,
    modelId: opts.defaultModel,
    isLocal: opts.isLocal,
    capabilities: opts.capabilities,
    complete,
    stream,
    estimateCost,
    getRemoteCredit,
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
