import { Box, Text } from 'ink';

import type { ElevationProposal } from '../exec/types.ts';

/**
 * The SUDO HUMAN-IN-THE-LOOP gate, rendered as a TUI panel.
 *
 * Orthogonal to {@link MutationApprovalPanel}: a `read` action can still need
 * sudo (e.g. `iptables -L`). Shows the verbatim `sudo -n …` command, the tier,
 * and whether the request is proactive (the action's defaultElevation) or
 * reactive (a re-run after a permission-denied). Footer prompts a/r/n.
 *
 * Tier semantics for the remember option:
 *   read / mutate  → [r] approve & remember for this session is offered
 *   destructive    → [r] is HIDDEN — destructive sudo is always fresh
 *
 * When `proposal.doubleConfirm` is true and the user has already pressed
 * approve once (`doubleConfirmArmed`), a second-line warning asks them to
 * press `a` AGAIN to actually run the command elevated.
 *
 * Render-only. Key handling lives in App.tsx next to the resolve() callback.
 */

interface Props {
  readonly proposal: ElevationProposal;
  readonly doubleConfirmArmed: boolean;
}

export function ElevationApprovalPanel({ proposal, doubleConfirmArmed }: Props): JSX.Element {
  const isDestructive = proposal.tier === 'destructive';
  const accent = isDestructive ? 'red' : 'yellow';
  const envLine =
    proposal.environment === undefined
      ? null
      : `${proposal.environment.name} (${proposal.environment.sshUser}@${proposal.environment.host}${
          proposal.environment.port !== undefined ? `:${proposal.environment.port}` : ''
        })`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginY={1}>
      <Box>
        <Text bold color="red" inverse>
          {' SUDO '}
        </Text>
        <Text dimColor>  ·  </Text>
        <Text bold color={accent}>
          {proposal.tier}
        </Text>
        <Text dimColor>  ·  </Text>
        <Text dimColor>{proposal.origin === 'reactive' ? 'reactive (re-run)' : 'proactive'}</Text>
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
        <Text dimColor>command (runs elevated):</Text>
        <Box marginLeft={2}>
          <Text color="white">{proposal.commandScrubbed}</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        {isDestructive ? (
          <Text bold>
            <Text color="green">[a]</Text>
            <Text> approve once   </Text>
            <Text color="red">[n]</Text>
            <Text> reject   </Text>
            <Text dimColor>(destructive sudo — cannot be remembered, ever)</Text>
          </Text>
        ) : (
          <Text bold>
            <Text color="green">[a]</Text>
            <Text> approve once   </Text>
            <Text color="cyan">[r]</Text>
            <Text> approve &amp; remember (this session)   </Text>
            <Text color="red">[n]</Text>
            <Text> reject</Text>
          </Text>
        )}
      </Box>

      {proposal.doubleConfirm && doubleConfirmArmed && (
        <Box marginTop={1}>
          <Text bold color="red">
            ⚠ press a or r AGAIN to confirm running this with sudo
          </Text>
        </Box>
      )}
    </Box>
  );
}
