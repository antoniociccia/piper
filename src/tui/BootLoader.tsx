import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

import { AlienFace } from './AlienFace.tsx';
import { spinnerFrame } from './theme.ts';

/**
 * Boot-time loader rendered before the main App mounts.
 *
 * Visual idiom: a "comic-book panel" with the PIPER alien on the left and a
 * speech-bubble that cycles PLAYFUL phrases — the user doesn't need to know
 * we're fetching an embedder; they need to know PIPER is alive and getting
 * ready. The real boot stage stays in the `message` prop (useful for tests
 * and debugging) but is not displayed; only a download progress detail line
 * surfaces, stripped of technical filenames. The whole panel is cleared by
 * the controller's hide() once boot completes.
 */
export interface BootLoaderProps {
  readonly message: string;
  /** Optional secondary line shown smaller under the main message. */
  readonly detail?: string;
}

/**
 * The boot small-talk. Order is shuffled per boot so the loader feels alive
 * across launches; phrases are deliberately generic — "we're doing our
 * things" — never implementation details.
 */
const PHRASES: readonly string[] = [
  'warming up the antennae…',
  'counting the containers twice…',
  'sharpening the read-only tools…',
  'teaching the gate to say no…',
  'polishing the audit log…',
  'calibrating professional skepticism…',
  'rehearsing the approval prompts…',
  'stretching the SSH fingers…',
  'dusting off the runbooks…',
  'lining up the evidence…',
  'doing our things…',
  'refusing to hallucinate…',
];

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

/** How long each phrase stays up before the next one slides in. */
const PHRASE_MS = 2400;

function speechBubble(width: number): { top: string; bottom: string } {
  const inner = '─'.repeat(width);
  return {
    top: `╭${inner}╮`,
    bottom: `╰${inner}╯`,
  };
}

export function BootLoader({ message: _message, detail }: BootLoaderProps): JSX.Element {
  const [tick, setTick] = useState(0);
  // One shuffle per boot: the carousel order differs every launch. The
  // component instance survives controller rerenders (same element type), so
  // the order and timer are stable across real boot-stage updates.
  const [phrases] = useState(() => shuffled(PHRASES));
  const [phraseIdx, setPhraseIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 90);
    const p = setInterval(() => setPhraseIdx((x) => x + 1), PHRASE_MS);
    return () => {
      clearInterval(t);
      clearInterval(p);
    };
  }, []);
  const spinner = spinnerFrame(tick);
  const phrase = phrases[phraseIdx % phrases.length] ?? 'doing our things…';

  // Fixed bubble width (sized to the longest phrase) so the panel doesn't
  // jitter when the carousel advances.
  const innerText = `${spinner}  ${phrase}`;
  const minWidth = Math.max(36, ...PHRASES.map((s) => s.length + 5));
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
