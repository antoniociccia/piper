import type { Catalog } from '../actions/catalog.ts';
import type { EnvironmentRegistry } from '../environments/registry.ts';
import type { ChatMessage } from '../memory/chat-history.ts';
import type { CostTracker } from '../models/cost.ts';
import type { ChatMessage as LlmChatMessage, CompleteRequest, ModelClient, ToolCall } from '../models/types.ts';
import type { SessionId } from '../memory/types.ts';
import type { PGlite } from '@electric-sql/pglite';

import {
  buildPlannerUserMessage,
  PLANNER_SYSTEM,
} from './prompts.ts';
import { catalogToToolDefs } from './tools.ts';
import { trackedComplete } from './tracked-complete.ts';
import type { Plan, PlanStep } from './types.ts';

import type { EmbeddingClient } from '../rag/embedding-client.ts';
import { formatRetrievalBlock, retrieveRelevant } from '../rag/retrieve.ts';

export interface PlanNodeInput {
  readonly userRequest: string;
  readonly sessionId: SessionId;
  readonly previousMessages?: readonly ChatMessage[];
}

export interface PlanNodeDeps {
  readonly client: ModelClient;
  readonly costTracker: CostTracker;
  readonly catalog: Catalog;
  readonly registry: EnvironmentRegistry;
  readonly db?: PGlite;
  readonly embedder?: EmbeddingClient;
  readonly onTrace?: (trace: {
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly toolCount: number;
    readonly systemSnippet: string;
    readonly userSnippet: string;
    readonly ragHits: readonly { source: string; similarity: number; headingPath: string }[];
    readonly historyMessages: number;
    readonly historyPreview: readonly { role: string; snippet: string }[];
  }) => void;
}

export interface PlanNodeOutput {
  readonly plan: Plan;
  readonly costUsd: number;
}

export class EmptyPlanError extends Error {
  /** The model's plain-text reply (instead of tool_calls). May be empty. */
  readonly assistantContent: string;
  constructor(message: string, assistantContent: string) {
    super(message);
    this.name = 'EmptyPlanError';
    this.assistantContent = assistantContent;
  }
}

function toolCallToStep(tc: ToolCall, index: number): PlanStep {
  return {
    id: `step-${index + 1}`,
    actionName: tc.name,
    args: tc.arguments ?? {},
    description: `Invoke ${tc.name}`,
  };
}

export async function planNode(
  input: PlanNodeInput,
  deps: PlanNodeDeps,
): Promise<PlanNodeOutput> {
  const tools = catalogToToolDefs(deps.catalog);
  const envBlock = await deps.registry.describeForLLM();

  // Optional RAG: retrieve relevant runbook / ADR / past-session chunks.
  let ragBlock = '';
  let ragHits: ReadonlyArray<{ source: string; similarity: number; headingPath: string }> = [];
  if (deps.db !== undefined && deps.embedder !== undefined) {
    try {
      const chunks = await retrieveRelevant({
        db: deps.db,
        embedder: deps.embedder,
        query: input.userRequest,
      });
      ragBlock = formatRetrievalBlock(chunks);
      ragHits = chunks.map((c) => ({
        source: c.source,
        similarity: c.similarity,
        headingPath: c.headingPath,
      }));
    } catch {
      // RAG is best-effort; never block planning on retrieval failure.
      ragBlock = '';
    }
  }

  const systemContent = ragBlock === '' ? PLANNER_SYSTEM : `${PLANNER_SYSTEM}\n\n${ragBlock}`;

  const messages: LlmChatMessage[] = [
    { role: 'system', content: systemContent },
  ];

  if (input.previousMessages !== undefined && input.previousMessages.length > 0) {
    for (const m of input.previousMessages) {
      messages.push({ role: m.role, content: m.content });
    }
  }

  messages.push({
    role: 'user',
    content: buildPlannerUserMessage({
      userRequest: input.userRequest,
      environmentsBlock: envBlock,
    }),
  });

  const req: CompleteRequest = {
    messages,
    tools,
    toolChoice: 'auto',
    temperature: 0.1,
  };

  const { completion, costUsd } = await trackedComplete({
    client: deps.client,
    costTracker: deps.costTracker,
    sessionId: input.sessionId,
    role: 'planner',
    req,
    ...(deps.onTrace === undefined
      ? {}
      : {
          onTrace: (t) => {
            const prevMsgs = input.previousMessages ?? [];
            const historyPreview = prevMsgs.map((m) => ({
              role: m.role,
              snippet: m.content.replace(/\s+/g, ' ').slice(0, 100),
            }));
            deps.onTrace!({
              ...t,
              ragHits,
              historyMessages: prevMsgs.length,
              historyPreview,
            });
          },
        }),
  });

  const calls = completion.toolCalls;
  if (calls.length === 0) {
    throw new EmptyPlanError(
      `planner produced no tool calls. assistant content: ${completion.content.slice(0, 200)}`,
      completion.content,
    );
  }

  const steps = calls.map((c, i) => toolCallToStep(c, i));
  const fanout = steps.length;
  const plan: Plan = {
    steps,
    parallelismHint: {
      fanout,
      reasoning: fanout > 1
        ? 'planner emitted multiple independent tool calls; default single-agent fan-in for M1'
        : 'single step',
    },
    rationale: completion.content,
  };
  return { plan, costUsd };
}
