import { Box, Text } from 'ink';

import { AlienFace } from './AlienFace.tsx';

/**
 * Welcome banner shown only on a fresh session (entries.length === 0).
 * Minimal: animated alien glyph + tagline.
 */
export function Banner(): JSX.Element {
  return (
    <Box flexDirection="column" marginY={1} paddingX={2}>
      <Box>
        <AlienFace busy={false} bold />
        <Text dimColor> </Text>
        <Text bold color="cyan">PIPER</Text>
        <Text dimColor> — DevOps at the speed of thought.</Text>
      </Box>
      <Text dimColor>
        Type a question, or run <Text color="cyan">/help</Text> for slash commands.
      </Text>
    </Box>
  );
}
