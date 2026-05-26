import { useEffect, useState } from 'react';
import { Text } from 'ink';

/**
 * Small animated alien glyph matching the PIPER mascot:
 *   - Two antennae (Y …  Y)
 *   - Two big black eyes (◉ ◉)
 *
 * Blinks/squints AND cycles through neon colours.
 *
 *   busy=true  → quick eye-cycle to suggest thinking
 *   busy=false → very slow blink with slow colour drift
 *
 * If `color` is supplied, the colour cycle is overridden and the glyph stays
 * one hue.
 */
export interface AlienFaceProps {
  readonly busy?: boolean;
  readonly color?: 'green' | 'cyan' | 'yellow' | 'red' | 'magenta';
  /** Optional bold. */
  readonly bold?: boolean;
}

const BUSY_FRAMES = [
  'Y(◉ ◉)Y',
  'Y(◐ ◐)Y',
  'Y(◑ ◑)Y',
  'Y(◒ ◒)Y',
];

// 5 "open eyes" frames then a single blink — most of the time looks alert.
const IDLE_FRAMES = [
  'Y(◉ ◉)Y',
  'Y(◉ ◉)Y',
  'Y(◉ ◉)Y',
  'Y(◉ ◉)Y',
  'Y(◉ ◉)Y',
  'Y(- -)Y',
];

const COLOR_CYCLE: ReadonlyArray<'green' | 'cyan' | 'magenta' | 'yellow'> = [
  'green',
  'cyan',
  'magenta',
  'yellow',
];

export function AlienFace({ busy = false, color, bold = false }: AlienFaceProps): JSX.Element {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const intervalMs = busy ? 220 : 700;
    const t = setInterval(() => setTick((x) => x + 1), intervalMs);
    return () => clearInterval(t);
  }, [busy]);
  const frames = busy ? BUSY_FRAMES : IDLE_FRAMES;
  const frame = frames[tick % frames.length] ?? 'Y(◉ ◉)Y';
  // Colour cycle: busy → fast (every tick), idle → slow (every 4 ticks).
  const colorTick = busy ? tick : Math.floor(tick / 4);
  const effectiveColor = color ?? COLOR_CYCLE[colorTick % COLOR_CYCLE.length] ?? 'green';
  return (
    <Text color={effectiveColor} bold={bold}>{frame}</Text>
  );
}
