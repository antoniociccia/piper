import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ENV_VARS, readEnv } from '../config/env-vars.ts';
import type { SessionId } from '../memory/types.ts';

function reportsBaseDir(): string {
  const base = readEnv(ENV_VARS.DATA_DIR) ?? join(homedir(), '.piper', 'data');
  return join(base, 'reports');
}

export interface ArchiveResult {
  readonly path: string;
}

/**
 * Persist a report to {PIPER_DATA_DIR or ~/.piper/data}/reports/{sessionId}/run-{utcMs}.md.
 * Best-effort: throws on filesystem errors so the caller can decide.
 */
export async function archiveReport(
  sessionId: SessionId,
  markdown: string,
): Promise<ArchiveResult> {
  const dir = join(reportsBaseDir(), sessionId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `run-${Date.now()}.md`);
  await writeFile(path, markdown, 'utf8');
  return { path };
}
