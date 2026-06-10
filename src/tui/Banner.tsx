import { Box, Text } from 'ink';

import { AlienFace } from './AlienFace.tsx';
import { VERSION } from './theme.ts';

/**
 * Welcome banner shown only on a fresh session (entries.length === 0).
 * Masthead: animated alien + wordmark + version, the product contract as the
 * tagline, and the one hint a new user needs.
 */
export function Banner(): JSX.Element {
  return (
    <Box flexDirection="column" marginY={1} paddingX={2}>
      <Box>
        <AlienFace busy={false} bold />
        <Text dimColor> </Text>
        <Text bold color="cyan">PIPER</Text>
        <Text dimColor> v{VERSION} — DevOps at the speed of thought.</Text>
      </Box>
      <Box paddingLeft={9}>
        <Text dimColor>
          the LLM proposes · <Text color="cyan">the gate validates</Text> · you approve
        </Text>
      </Box>
      <Text dimColor>
        Type a question, or run <Text color="cyan">/help</Text> for slash commands.
      </Text>
    </Box>
  );
}
