import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
});

type Args = z.infer<typeof argsSchema>;

export interface MemoryReading {
  readonly raw: string;
  readonly totalMb?: number;
  readonly usedMb?: number;
  readonly freeMb?: number;
  readonly availableMb?: number;
  readonly swapTotalMb?: number;
  readonly swapUsedMb?: number;
}

function parseSize(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const m = /^([\d.]+)([KMGTP]?)i?$/i.exec(token);
  if (m === null) return undefined;
  const num = Number(m[1]);
  if (!Number.isFinite(num)) return undefined;
  const unit = (m[2] ?? '').toUpperCase();
  const mult: Record<string, number> = { '': 1 / 1_000_000, K: 1 / 1000, M: 1, G: 1000, T: 1_000_000, P: 1_000_000_000 };
  return Math.round(num * (mult[unit] ?? 1));
}

export const systemMemory: Action<Args, MemoryReading> = {
  name: 'system.memory',
  tier: 'read',
  description: 'Report RAM and swap usage on the remote environment via `free -h` (Linux).',
  argsSchema,
  // `free` ships with procps and does not exist on macOS/BSD. Try it first so a
  // Linux host is unaffected, then fall back to the Darwin equivalents: `top`'s
  // PhysMem line is the readable one, `vm_stat` is the last resort.
  buildCommand: (_args, ctx) =>
    buildSshArgvForEnv(requireEnv(ctx), [
      'sh',
      '-c',
      'free -h 2>/dev/null || top -l 1 -s 0 2>/dev/null | grep -i "^PhysMem" || vm_stat',
    ]),
  parseResult: (raw) => {
    const out: {
      raw: string;
      totalMb?: number;
      usedMb?: number;
      freeMb?: number;
      availableMb?: number;
      swapTotalMb?: number;
      swapUsedMb?: number;
    } = { raw: raw.stdout };
    for (const line of raw.stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('Mem:')) {
        const cols = trimmed.split(/\s+/);
        const total = parseSize(cols[1]);
        const used = parseSize(cols[2]);
        const free = parseSize(cols[3]);
        const avail = parseSize(cols[6]);
        if (total !== undefined) out.totalMb = total;
        if (used !== undefined) out.usedMb = used;
        if (free !== undefined) out.freeMb = free;
        if (avail !== undefined) out.availableMb = avail;
      } else if (trimmed.startsWith('Swap:')) {
        const cols = trimmed.split(/\s+/);
        const stotal = parseSize(cols[1]);
        const sused = parseSize(cols[2]);
        if (stotal !== undefined) out.swapTotalMb = stotal;
        if (sused !== undefined) out.swapUsedMb = sused;
      }
    }
    return out;
  },
};
