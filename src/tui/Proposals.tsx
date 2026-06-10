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
            {'  '}
            <Text bold>[{i + 1}]</Text> {p.description}
            <Text dimColor> · {p.actionName}({shortenArgs(p.args)})</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          <Text bold>y</Text> run all · <Text bold>n</Text> skip · <Text bold>q</Text> stop · <Text bold>Esc</Text> decline · or type <Text bold>1,3</Text> then Enter to pick
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
