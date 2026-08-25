import type { Catalog } from '../actions/catalog.ts';
import { stripReasoning } from '../models/client.ts';
import { hashPayload, type CostTracker } from '../models/cost.ts';
import type { CompleteRequest, ModelClient, ToolCall } from '../models/types.ts';
import type { SessionId } from '../memory/types.ts';

import {
  buildSynthesizerUserMessage,
  formatEvidenceBlock,
  PROPOSER_SYSTEM,
  SYNTHESIZER_SYSTEM,
} from './prompts.ts';
import { catalogToToolDefs } from './tools.ts';
import { trackedComplete } from './tracked-complete.ts';
import type { EvidenceRef, ProposedStep } from './types.ts';

export interface SynthesizeNodeInput {
  readonly userRequest: string;
  readonly sessionId: SessionId;
  readonly evidence: readonly EvidenceRef[];
  readonly previousAttemptIssues?: readonly string[];
  /**
   * Report produced by a previous follow-up iteration of THIS turn. When set,
   * the synthesizer is in INCREMENTAL mode: it extends the report instead of
   * rewriting it from scratch.
   */
  readonly previousReport?: string;
}

export interface SynthesizeNodeDeps {
  readonly client: ModelClient;
  readonly costTracker: CostTracker;
  readonly onTrace?: (trace: {
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly toolCount: number;
    readonly systemSnippet: string;
    readonly userSnippet: string;
    readonly evidenceCount: number;
  }) => void;
}

export interface SynthesizeNodeOutput {
  readonly reportMarkdown: string;
  readonly costUsd: number;
}

export type SynthesizeYield = { readonly type: 'chunk'; readonly delta: string };

function buildReportRequest(input: SynthesizeNodeInput): CompleteRequest {
  const incremental = input.previousReport !== undefined && input.previousReport.trim() !== '';
  return {
    messages: [
      { role: 'system', content: SYNTHESIZER_SYSTEM },
      {
        role: 'user',
        content: buildSynthesizerUserMessage({
          userRequest: input.userRequest,
          evidenceBlock: formatEvidenceBlock(input.evidence),
          ...(input.previousAttemptIssues === undefined
            ? {}
            : { previousAttemptIssues: input.previousAttemptIssues }),
          ...(input.previousReport === undefined ? {} : { previousReport: input.previousReport }),
        }),
      },
    ],
    temperature: 0.2,
    // Incremental reports may grow beyond the default cap; give them headroom.
    maxTokens: incremental ? 3072 : 2048,
  };
}

/**
 * Streams the report-writing LLM call. NO tools wired here — the model has a
 * single job: write the grounded markdown report given the evidence.
 *
 * Follow-up proposals are a SEPARATE call (proposeFollowups) made after the
 * report passes verification. Splitting the two prevents role confusion on
 * smaller models that otherwise emit "let me gather more" preambles when they
 * see tools available in the same call.
 */
export async function* synthesizeNodeStream(
  input: SynthesizeNodeInput,
  deps: SynthesizeNodeDeps,
): AsyncGenerator<SynthesizeYield, SynthesizeNodeOutput, void> {
  if (!deps.client.capabilities.streaming) {
    const out = await synthesizeNode(input, deps);
    yield { type: 'chunk', delta: out.reportMarkdown };
    return out;
  }

  const req = buildReportRequest(input);
  const estimate = deps.client.estimateCost(req);
  await deps.costTracker.guard(input.sessionId, estimate);

  let assembled = '';
  let inputTokens = 0;
  let outputTokens = 0;
  // Use the canonical model id (no provider prefix) so the pricing table matches.
  const modelId = deps.client.modelId;

  for await (const chunk of deps.client.stream(req)) {
    if (chunk.contentDelta !== undefined && chunk.contentDelta !== '') {
      assembled += chunk.contentDelta;
      yield { type: 'chunk', delta: chunk.contentDelta };
    }
    if (chunk.usage !== undefined) {
      inputTokens = chunk.usage.inputTokens;
      outputTokens = chunk.usage.outputTokens;
    }
  }

  const payloadHash = await hashPayload({ model: modelId, messages: req.messages });
  const { costUsd } = await deps.costTracker.record({
    sessionId: input.sessionId,
    model: modelId,
    role: 'synthesize',
    inputTokens,
    outputTokens,
    payloadHash,
  });
  if (deps.onTrace !== undefined) {
    const sysMsg = req.messages.find((m) => m.role === 'system');
    const usrMsg = [...req.messages].reverse().find((m) => m.role === 'user');
    deps.onTrace({
      model: modelId,
      inputTokens,
      outputTokens,
      toolCount: 0,
      systemSnippet: sysMsg?.content.slice(0, 240) ?? '',
      userSnippet: usrMsg?.content.slice(0, 240) ?? '',
      evidenceCount: input.evidence.length,
    });
  }

  // Reasoning models can leak a thinking preamble into the streamed content —
  // the chunks already reached the TUI, but the report that gets verified,
  // stored and shown as final must not carry it.
  return { reportMarkdown: stripReasoning(assembled), costUsd };
}

export async function synthesizeNode(
  input: SynthesizeNodeInput,
  deps: SynthesizeNodeDeps,
): Promise<SynthesizeNodeOutput> {
  const req = buildReportRequest(input);
  const { completion, costUsd } = await trackedComplete({
    client: deps.client,
    costTracker: deps.costTracker,
    sessionId: input.sessionId,
    role: 'synthesize',
    req,
  });
  return { reportMarkdown: stripReasoning(completion.content), costUsd };
}

// ── Follow-up proposals (separate call) ──────────────────────────────────

export interface ProposeFollowupsInput {
  readonly userRequest: string;
  readonly sessionId: SessionId;
  readonly evidence: readonly EvidenceRef[];
  readonly reportMarkdown: string;
  /**
   * Listing of the environments currently registered in PIPER (passed
   * verbatim into the proposer's user message). The proposer MUST pick
   * environment args from this list — without it, models happily invent
   * names like "production" when only "demo" is registered, and the
   * Executor refuses the action.
   */
  readonly environmentsBlock: string;
}

export interface ProposeFollowupsDeps {
  readonly client: ModelClient;
  readonly costTracker: CostTracker;
  readonly catalog: Catalog;
  readonly onTrace?: (trace: {
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly toolCount: number;
    readonly systemSnippet: string;
    readonly userSnippet: string;
    readonly evidenceCount: number;
  }) => void;
}

export interface ProposeFollowupsOutput {
  readonly proposals: readonly ProposedStep[];
  readonly costUsd: number;
}

function formatAlreadyExecuted(evidence: readonly EvidenceRef[]): string {
  if (evidence.length === 0) return '(nothing yet)';
  // Deduplicate by (actionName + JSON.stringify(args)) so the model sees each
  // unique invocation once even if it ran multiple times.
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const ev of evidence) {
    const key = `${ev.actionName}::${JSON.stringify(ev.args)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${ev.actionName}(${JSON.stringify(ev.args)})`);
  }
  return lines.join('\n');
}

function buildProposerRequest(
  input: ProposeFollowupsInput,
  deps: ProposeFollowupsDeps,
): CompleteRequest {
  const userBody = [
    input.environmentsBlock,
    '',
    `User request: ${input.userRequest}`,
    '',
    'Already executed in this turn (do NOT propose any of these again):',
    formatAlreadyExecuted(input.evidence),
    '',
    'Evidence collected:',
    formatEvidenceBlock(input.evidence),
    '',
    'Report just produced:',
    input.reportMarkdown,
    '',
    'Emit tool_calls for follow-ups that would close gaps. Skip anything in the "Already executed" list. If nothing useful to add, emit zero tool_calls. Any environment name in a tool call MUST come from the registered list above — do NOT invent host names.',
  ].join('\n');
  return {
    messages: [
      { role: 'system', content: PROPOSER_SYSTEM },
      { role: 'user', content: userBody },
    ],
    tools: catalogToToolDefs(deps.catalog),
    toolChoice: 'auto',
    temperature: 0.1,
    maxTokens: 512,
  };
}

function toolCallsToProposals(calls: readonly ToolCall[]): ProposedStep[] {
  return calls.map((tc, i) => ({
    id: `proposal-${i + 1}`,
    actionName: tc.name,
    args: tc.arguments ?? {},
    description: `Follow-up: ${tc.name}`,
    rationale: 'Synthesizer suggested this action',
  }));
}

export async function proposeFollowups(
  input: ProposeFollowupsInput,
  deps: ProposeFollowupsDeps,
): Promise<ProposeFollowupsOutput> {
  const req = buildProposerRequest(input, deps);
  const { completion, costUsd } = await trackedComplete({
    client: deps.client,
    costTracker: deps.costTracker,
    sessionId: input.sessionId,
    role: 'synthesize',
    req,
    ...(deps.onTrace === undefined
      ? {}
      : {
          onTrace: (t) => {
            deps.onTrace!({ ...t, evidenceCount: input.evidence.length });
          },
        }),
  });
  let proposals = toolCallsToProposals(completion.toolCalls);
  if (proposals.length === 0) {
    const fallback = extractInlineProposals(completion.content);
    if (fallback.proposals.length > 0) {
      proposals = [...fallback.proposals];
    }
  }
  return { proposals, costUsd };
}

// ── Inline JSON fallback (used by proposeFollowups for non-compliant models) ──

const FENCED_JSON_PATTERN = /(?:^|\n)\s*```(?:json)?\s*\n?(\[[\s\S]*?\])\s*```\s*$/i;

interface InlineProposalParseResult {
  readonly cleanedMarkdown: string;
  readonly proposals: readonly ProposedStep[];
}

export function extractInlineProposals(markdown: string): InlineProposalParseResult {
  const match = FENCED_JSON_PATTERN.exec(markdown);
  if (match === null || match[1] === undefined) {
    return { cleanedMarkdown: markdown, proposals: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { cleanedMarkdown: markdown, proposals: [] };
  }
  if (!Array.isArray(parsed)) return { cleanedMarkdown: markdown, proposals: [] };

  const proposals: ProposedStep[] = [];
  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const actionName =
      typeof r['action'] === 'string'
        ? r['action']
        : typeof r['name'] === 'string'
          ? r['name']
          : null;
    if (actionName === null || actionName === '') continue;
    const args =
      typeof r['args'] === 'object' && r['args'] !== null ? r['args'] :
      typeof r['arguments'] === 'object' && r['arguments'] !== null ? r['arguments'] :
      {};
    const rationale = typeof r['rationale'] === 'string' ? r['rationale'] : `Synthesizer suggested ${actionName}`;
    proposals.push({
      id: `proposal-${proposals.length + 1}`,
      actionName,
      args,
      description: `Follow-up: ${actionName}`,
      rationale,
    });
  }

  if (proposals.length === 0) return { cleanedMarkdown: markdown, proposals: [] };

  const cleanedMarkdown = markdown.slice(0, match.index).trimEnd();
  return { cleanedMarkdown, proposals };
}
