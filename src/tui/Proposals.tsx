import { Box, Text } from 'ink';

import type { ProposedStep } from '../agent/types.ts';

interface Props {
  readonly proposals: readonly ProposedStep[];
  readonly iteration: number;
  readonly input: string;
}

function shortenArgs(args: unknown): string {
  const s = JSON.stringify(args);
  if (s.length <= 70) return s;
  return `${s.slice(0, 69)}…`;
}

export function Proposals({ proposals, iteration, input }: Props): JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderColor="magenta">
      <Text bold color="magenta">
        PIPER suggests follow-ups · iteration {iteration}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {proposals.map((p, i) => (
          <Text key={p.id}>
            {`  [${i + 1}] ${p.actionName}(${shortenArgs(p.args)})`}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          y = run all · n = skip · 1,3 = pick by index · q = stop · Enter = decline
        </Text>
        <Box>
          <Text color="magenta" bold>{'› '}</Text>
          <Text>{input}</Text>
          <Text inverse> </Text>
        </Box>
      </Box>
    </Box>
  );
}
