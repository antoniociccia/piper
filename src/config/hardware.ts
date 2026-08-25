/**
 * Picks a local model the machine can actually run, so a first run does not
 * dead-end on "no models available — pull one yourself and start over".
 *
 * The policy here is pure and unit-tested; the probe that reads real memory is
 * the only part that touches the OS.
 */

const GB = 1024 ** 3;

/**
 * Fraction of total RAM a model's weights may occupy. The rest has to hold the
 * KV cache (which grows with context), the OS, and PIPER itself — Ink, PGlite
 * and the embedder are not free. Erring low costs a little quality; erring high
 * makes the machine swap, which reads to the user as "this tool is broken".
 */
const USABLE_FRACTION = 0.55;

export interface ModelRung {
  readonly tag: string;
  /** Download size, which is also roughly the resident weight size. */
  readonly sizeBytes: number;
  /** Total system memory below which this rung should not be offered. */
  readonly minTotalBytes: number;
  /** What we actually observed. Shown to the user so the choice is inspectable. */
  readonly note: string;
}

/**
 * Only models measured against PIPER's own analyze flow appear here.
 * granite4.1:3b and phi4-mini:3.8b were tested and deliberately left out: both
 * called tools correctly but produced zero evidence citations, so the verifier
 * refused every report they wrote. A smaller download is no bargain when the
 * result never reaches the screen.
 */
export const LOCAL_MODEL_LADDER: readonly ModelRung[] = [
  {
    tag: 'qwen3.5:4b',
    sizeBytes: Math.round(3.4 * GB),
    minTotalBytes: 8 * GB,
    note: 'the floor — handles a focused health check with grounded citations',
  },
  {
    tag: 'qwen3.5:9b',
    sizeBytes: Math.round(6.6 * GB),
    minTotalBytes: 16 * GB,
    note: 'best value — found the most incidents per gigabyte in testing',
  },
  {
    tag: 'qwen3.5:27b',
    sizeBytes: 17 * GB,
    minTotalBytes: 48 * GB,
    note: 'most capable of the measured set; wants a workstation',
  },
];

export interface Recommendation {
  readonly model: ModelRung | null;
  readonly usableBytes: number;
  readonly totalBytes: number | null;
  readonly reason: string;
}

/**
 * The largest rung that fits the memory budget. `null` total memory means the
 * probe failed, in which case we take the floor rung rather than gamble a
 * multi-gigabyte download on a guess.
 */
export function recommendLocalModel(totalBytes: number | null): Recommendation {
  const floor = LOCAL_MODEL_LADDER[0];
  if (floor === undefined) {
    return { model: null, usableBytes: 0, totalBytes, reason: 'no models are configured' };
  }

  if (totalBytes === null || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return {
      model: floor,
      usableBytes: 0,
      totalBytes: null,
      reason: `could not read system memory — defaulting to the smallest measured model (${floor.tag})`,
    };
  }

  const usableBytes = Math.floor(totalBytes * USABLE_FRACTION);

  let chosen: ModelRung | null = null;
  for (const rung of LOCAL_MODEL_LADDER) {
    if (totalBytes >= rung.minTotalBytes && rung.sizeBytes <= usableBytes) chosen = rung;
  }

  if (chosen === null) {
    const gb = (totalBytes / GB).toFixed(1);
    return {
      model: null,
      usableBytes,
      totalBytes,
      reason:
        `this machine reports ${gb} GB of memory, below what the smallest measured ` +
        `model (${floor.tag}, ${(floor.sizeBytes / GB).toFixed(1)} GB) needs to run comfortably. ` +
        `Use a remote provider, or pull a smaller model yourself if you want to experiment.`,
    };
  }

  return {
    model: chosen,
    usableBytes,
    totalBytes,
    reason: `${(totalBytes / GB).toFixed(0)} GB of memory — ${chosen.note}`,
  };
}

/**
 * Total physical memory in bytes, or null when it cannot be determined.
 * Deliberately separate from the policy above so the recommendation stays
 * testable without a machine to run it on.
 */
export async function detectTotalMemoryBytes(): Promise<number | null> {
  try {
    if (process.platform === 'darwin') {
      const out = await new Response(
        Bun.spawn(['sysctl', '-n', 'hw.memsize'], { stdout: 'pipe' }).stdout,
      ).text();
      const n = Number(out.trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    }

    if (process.platform === 'linux') {
      const text = await Bun.file('/proc/meminfo').text();
      const match = /^MemTotal:\s+(\d+)\s+kB/m.exec(text);
      if (match?.[1] === undefined) return null;
      return Number(match[1]) * 1024;
    }

    // Windows and anything else: os.totalmem is good enough and needs no shell.
    const os = await import('node:os');
    const total = os.totalmem();
    return Number.isFinite(total) && total > 0 ? total : null;
  } catch {
    return null;
  }
}

/** Human-readable size, for the wizard's download prompt. */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
