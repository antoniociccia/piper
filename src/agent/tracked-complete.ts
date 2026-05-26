import type { SessionId } from '../memory/types.ts';
import {
  type CostTracker,
  hashPayload,
  type RecordCostInput,
} from '../models/cost.ts';
import type {
  CompleteRequest,
  Completion,
  ModelClient,
} from '../models/types.ts';

export interface TrackedCallTrace {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCount: number;
  readonly systemSnippet: string;
  readonly userSnippet: string;
}

export interface TrackedCompleteOptions {
  readonly client: ModelClient;
  readonly costTracker: CostTracker;
  readonly sessionId: SessionId;
  readonly role: RecordCostInput['role'];
  readonly req: CompleteRequest;
  /** Optional trace callback invoked AFTER the call returns with summary info. */
  readonly onTrace?: (trace: TrackedCallTrace) => void;
}

export interface TrackedCompletion {
  readonly completion: Completion;
  readonly costUsd: number;
}

export async function trackedComplete(opts: TrackedCompleteOptions): Promise<TrackedCompletion> {
  const estimate = opts.client.estimateCost(opts.req);
  await opts.costTracker.guard(opts.sessionId, estimate);

  const completion = await opts.client.complete(opts.req);
  const payloadHash = await hashPayload({
    model: completion.model,
    messages: opts.req.messages,
    tools: opts.req.tools,
  });
  const { costUsd } = await opts.costTracker.record({
    sessionId: opts.sessionId,
    model: completion.model,
    role: opts.role,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    payloadHash,
  });
  if (opts.onTrace !== undefined) {
    const sysMsg = opts.req.messages.find((m) => m.role === 'system');
    const usrMsg = [...opts.req.messages].reverse().find((m) => m.role === 'user');
    opts.onTrace({
      model: completion.model,
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      toolCount: opts.req.tools?.length ?? 0,
      systemSnippet: sysMsg?.content.slice(0, 240) ?? '',
      userSnippet: usrMsg?.content.slice(0, 240) ?? '',
    });
  }
  return { completion, costUsd };
}
