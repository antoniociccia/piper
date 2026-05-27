import { Box, Text } from 'ink';

import type { MutationProposal } from '../exec/types.ts';

/**
 * The HUMAN-IN-THE-LOOP gate, rendered as a TUI panel.
 *
 * Shows the user EXACTLY what is about to happen — verbatim command, the
 * dry-run preview the action emitted, the snapshot it took for rollback,
 * and the environment it targets. Footer prompts a/r/n.
 *
 * Tier semantics:
 *   mutate       → magenta border, [a]pprove once · [r]emember per env · [n]o
 *   destructive  → red border, [a]pprove once · [n]o   (no remember, ever)
 *
 * The component is render-only. Key handling lives in App.tsx so the
 * approval state lives next to the resolve() callback that wakes the
 * executor up.
 */

interface Props {
  readonly proposal: MutationProposal;
}

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  const lines = s.split('\n');
  if (lines.length > 14) {
    return `${lines.slice(0, 14).join('\n')}\n  …(${lines.length - 14} more lines, ${s.length - max} bytes truncated)`;
  }
  return `${s.slice(0, max)}\n  …(${s.length - max} bytes truncated)`;
}

export function MutationApprovalPanel({ proposal }: Props): JSX.Element {
  const isDestructive = proposal.tier === 'destructive';
  const accent = isDestructive ? 'red' : 'magenta';
  const titleVerb = isDestructive ? 'DESTRUCTIVE — confirm' : 'wants to run a mutation';
  const envLine =
    proposal.environment === undefined
      ? null
      : `${proposal.environment.name} (${proposal.environment.sshUser}@${proposal.environment.host}${
          proposal.environment.port !== undefined ? `:${proposal.environment.port}` : ''
        })`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginY={1}>
      <Box>
        <Text bold color={accent}>
          {isDestructive ? '⚠ ' : '◆ '}PIPER {titleVerb}
        </Text>
        <Text dimColor>  ·  </Text>
        <Text color={accent}>{proposal.actionName}</Text>
        {envLine !== null && (
          <>
            <Text dimColor>  on  </Text>
            <Text bold>{envLine}</Text>
          </>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text dimColor>command (will run locally, then over SSH):</Text>
        <Box marginLeft={2}>
          <Text color="white">{proposal.commandScrubbed}</Text>
        </Box>
      </Box>

      {proposal.dryRunOutput !== undefined && proposal.dryRunOutput.trim() !== '' && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>dry-run preview (the diff you're approving):</Text>
          <Box marginLeft={2} flexDirection="column">
            {shorten(proposal.dryRunOutput.trim(), 1200)
              .split('\n')
              .map((line, i) => (
                <Text key={i} color="yellow">{line}</Text>
              ))}
          </Box>
        </Box>
      )}

      {proposal.snapshotOutput !== undefined && proposal.snapshotOutput.trim() !== '' && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>pre-state snapshot (used for rollback on verify failure):</Text>
          <Box marginLeft={2} flexDirection="column">
            {shorten(proposal.snapshotOutput.trim(), 600)
              .split('\n')
              .map((line, i) => (
                <Text key={i} dimColor>{line}</Text>
              ))}
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        {isDestructive ? (
          <Text bold>
            <Text color="green">[a]</Text>
            <Text> approve once   </Text>
            <Text color="red">[n]</Text>
            <Text> reject   </Text>
            <Text dimColor>(destructive — cannot be remembered, ever)</Text>
          </Text>
        ) : (
          <Text bold>
            <Text color="green">[a]</Text>
            <Text> approve once   </Text>
            <Text color="cyan">[r]</Text>
            <Text> approve &amp; remember for </Text>
            <Text bold>{proposal.environment?.name ?? 'this env'}</Text>
            <Text>   </Text>
            <Text color="red">[n]</Text>
            <Text> reject</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
