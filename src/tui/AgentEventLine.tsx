import { Box, Text } from 'ink';

import type { AgentEvent } from '../agent/types.ts';

interface Props {
  readonly event: AgentEvent;
  readonly tick?: number;
  /** When false, animated events stop animating (rendered as completed/static). */
  readonly live?: boolean;
  /** Show verbose noise (costs, synth status, verify result). Default false. */
  readonly debug?: boolean;
}

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function spinnerChar(tick: number | undefined): string {
  const t = tick ?? 0;
  return BRAILLE[t % BRAILLE.length] ?? '⠋';
}

function shorten(s: string, n = 80): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

/**
 * Empty span returned for events the user doesn't need to see by default.
 * Toggle to verbose via /debug to surface them.
 */
const HIDDEN = <Text> </Text>;

export function AgentEventLine({ event, tick, live = true, debug = false }: Props): JSX.Element {
  switch (event.type) {
    // -- Events ALWAYS hidden from default view (the streaming report is the UI) --
    case 'synthesize-chunk':
      return HIDDEN;

    // -- Events hidden in compact mode, shown in /debug --
    case 'session-started':
      return debug ? <Text dimColor>session {event.sessionId.slice(0, 12)}…</Text> : HIDDEN;
    case 'plan-started':
      return debug ? (
        <Text color="cyan">
          {'  '}
          {live ? `${spinnerChar(tick)} ` : '○ '}
          planning…
        </Text>
      ) : HIDDEN;
    case 'synthesize-started':
      return debug ? (
        <Text color="cyan">
          {'  '}
          {live ? `${spinnerChar(tick)} ` : '○ '}
          synthesizing report (streaming)…
        </Text>
      ) : HIDDEN;
    case 'synthesize-ready':
      return debug ? (
        <Text color="cyan">
          {'  '}report ready
          {event.costUsdDelta > 0 ? ` (+$${event.costUsdDelta.toFixed(4)})` : ''}
        </Text>
      ) : HIDDEN;
    case 'verify-passed':
      return debug ? <Text color="green">  ✓ verify passed — every claim is grounded</Text> : HIDDEN;
    case 'proposals-declined':
      return debug ? <Text dimColor>  follow-ups declined</Text> : HIDDEN;
    case 'done':
      return debug ? (
        <Text dimColor>
          done — evidence={event.result.evidence.length}, failures={event.result.failures.length}, cost=${event.result.costUsd.toFixed(4)}
        </Text>
      ) : HIDDEN;

    // -- Events shown in default view (the user wants these) --
    case 'plan-ready': {
      const desc = `plan ready: ${event.plan.steps.length} step(s)`;
      return (
        <Box flexDirection="column">
          <Text color="cyan">
            {'  '}
            {desc}
            {debug && event.costUsdDelta > 0 ? ` (+$${event.costUsdDelta.toFixed(4)})` : ''}
          </Text>
          {event.plan.steps.map((s, i) => (
            <Text key={s.id} dimColor>      {i + 1}. {s.actionName}({shorten(JSON.stringify(s.args), 60)})</Text>
          ))}
        </Box>
      );
    }
    case 'gather-step-started':
      return (
        <Text color="yellow">
          {'  '}
          {live ? `${spinnerChar(tick)} ` : '○ '}
          {event.step.actionName}…
        </Text>
      );
    case 'gather-step-done':
      return (
        <Text color="green">
          {'  ✓ '}
          {event.step.actionName}
          {debug
            ? ` (exit=${event.evidence.exitCode}, ${event.evidence.durationMs.toFixed(0)}ms)`
            : ''}
        </Text>
      );
    case 'gather-step-failed':
      return <Text color="red">  ✗ {event.step.actionName} — {shorten(event.failure.reason, 120)}</Text>;
    case 'verify-failed':
      // Compact view: only show the line at all if it's the FINAL failure (no
      // retry coming). The interleaved retries are noise. The agent-runner
      // already appends a "rewriting to ground every claim with citations…"
      // info entry for retries that explains things.
      if (!debug && event.retrying) return HIDDEN;
      return (
        <Box flexDirection="column">
          <Text color="yellow">  verify failed{event.retrying ? ' — retrying' : ' — ungrounded'}</Text>
          {debug &&
            event.issues.slice(0, 3).map((issue, i) => (
              <Text key={i} dimColor>      • {shorten(issue, 100)}</Text>
            ))}
        </Box>
      );
    case 'proposals-ready': {
      // iteration=0 is the initial plan awaiting approveSteps; iteration>=1
      // is a follow-up from the proposer. The label needs to disambiguate
      // or the user reads "follow-up" for what is actually their first
      // plan-approval prompt.
      const noun = event.iteration === 0
        ? (event.proposals.length === 1 ? 'plan step' : 'plan steps')
        : (event.proposals.length === 1 ? 'follow-up' : 'follow-ups');
      const verb = event.iteration === 0 ? 'pending approval' : 'proposed';
      return (
        <Text color="magenta">
          {`  ${event.proposals.length} ${noun} ${verb}`}
          {debug ? ` (iter ${event.iteration})` : ''}
        </Text>
      );
    }
    case 'compaction-applied':
      return (
        <Text color="gray">
          {`  ⤵ history compacted (covers up to #${event.coversUntilId}, ${event.summaryLength} chars)`}
        </Text>
      );
    case 'llm-trace':
      if (!debug) return HIDDEN;
      return (
        <Box flexDirection="column" marginY={0}>
          <Text color="magenta" bold>
            {'  ◇ '}
            {`llm-trace · ${event.role} · ${event.model}`}
          </Text>
          <Text dimColor>
            {'      tokens in='}
            <Text bold>{String(event.inputTokens)}</Text>
            {' out='}
            <Text bold>{String(event.outputTokens)}</Text>
            {' · tools='}
            <Text bold>{String(event.toolCount)}</Text>
            {' · history='}
            <Text bold>{String(event.historyMessages)}</Text>
            {event.evidenceCount > 0 ? ` · evidence=${event.evidenceCount}` : ''}
            {event.ragHits.length > 0 ? ` · RAG=${event.ragHits.length}` : ''}
          </Text>
          {event.ragHits.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>{'      RAG (per-chunk):'}</Text>
              {event.ragHits.slice(0, 5).map((h, i) => (
                <Text key={i} dimColor>
                  {'        · '}
                  {h.source}
                  {h.headingPath !== '' ? `  ▸ ${shorten(h.headingPath, 60)}` : ''}
                  {`  (sim ${h.similarity.toFixed(2)})`}
                </Text>
              ))}
            </Box>
          )}
          {event.historyPreview.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>{`      history (${event.historyMessages} messages injected):`}</Text>
              {event.historyPreview.map((h, i) => (
                <Text key={i} dimColor>
                  {'        · '}
                  <Text bold>{h.role}</Text>
                  {': '}
                  {shorten(h.snippet, 100).replace(/\n/g, ' ⏎ ')}
                </Text>
              ))}
            </Box>
          )}
          <Text dimColor>
            {'      sys: '}
            {shorten(event.systemSnippet, 160).replace(/\n/g, ' ⏎ ')}
          </Text>
          <Text dimColor>
            {'      usr: '}
            {shorten(event.userSnippet, 160).replace(/\n/g, ' ⏎ ')}
          </Text>
        </Box>
      );
    case 'aborted':
      return <Text color="red">  ABORTED: {event.reason}</Text>;
    default:
      return debug ? <Text dimColor>(unknown event)</Text> : HIDDEN;
  }
}
