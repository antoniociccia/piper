import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

import { AlienFace } from './AlienFace.tsx';

/**
 * Boot-time loader rendered before the main App mounts.
 *
 * Visual idiom: a "comic-book panel" with the PIPER alien on the left and a
 * speech-bubble on the right that shows whatever step is in progress
 * (loading the WASM embedder, re-indexing the knowledge base, etc.).
 *
 * Replaces the stderr boot log lines that used to scroll past the user.
 */
export interface BootLoaderProps {
  readonly message: string;
  /** Optional secondary line shown smaller under the main message. */
  readonly detail?: string;
}

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function speechBubble(width: number): { top: string; bottom: string } {
  const inner = '─'.repeat(width);
  return {
    top: `╭${inner}╮`,
    bottom: `╰${inner}╯`,
  };
}

export function BootLoader({ message, detail }: BootLoaderProps): JSX.Element {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 90);
    return () => clearInterval(t);
  }, []);
  const spinner = BRAILLE[tick % BRAILLE.length] ?? '⠋';

  // Pad the bubble to comfortably accommodate the longest typical message.
  // Caps at the terminal width minus the alien + tail glyph.
  const innerText = `${spinner}  ${message}`;
  const minWidth = 36;
  const innerWidth = Math.max(minWidth, innerText.length + 2);
  const bubble = speechBubble(innerWidth);
  const padded = ` ${innerText}${' '.repeat(Math.max(0, innerWidth - 1 - innerText.length))}`;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        {/* Alien on the left, "bubble tail" pointing at it. */}
        <Box marginRight={1} flexDirection="column" alignItems="center">
          <AlienFace busy bold />
          <Text color="gray">{'   '}</Text>
        </Box>
        <Text color="cyan">◀ </Text>
        <Box flexDirection="column">
          <Text color="cyan">{bubble.top}</Text>
          <Text color="cyan">│<Text color="white">{padded}</Text>│</Text>
          <Text color="cyan">{bubble.bottom}</Text>
        </Box>
      </Box>
      {detail !== undefined && detail !== '' && (
        <Box marginTop={1} marginLeft={2}>
          <Text dimColor>{detail}</Text>
        </Box>
      )}
    </Box>
  );
}
