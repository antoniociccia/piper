import { z } from 'zod';

import { buildSshArgvForEnv } from '../../exec/ssh.ts';
import type { Action } from '../types.ts';
import { requireEnv } from './helpers.ts';

const argsSchema = z.object({
  environment: z.string(),
});

type Args = z.infer<typeof argsSchema>;

export interface OsInfo {
  readonly raw: string;
  readonly uname: string;
  readonly osRelease: Readonly<Record<string, string>>;
}

export const systemOsInfo: Action<Args, OsInfo> = {
  name: 'system.os_info',
  tier: 'read',
  description:
    'Identify the remote OS via `uname -a` and `/etc/os-release` in one call. Useful as the first probe on an unknown host.',
  argsSchema,
  buildCommand: (_args, ctx) =>
    buildSshArgvForEnv(requireEnv(ctx), [
      'sh',
      '-c',
      'echo "=== uname -a ==="; uname -a; echo "=== /etc/os-release ==="; cat /etc/os-release 2>/dev/null || true',
    ]),
  parseResult: (raw) => {
    const sections = raw.stdout.split(/===\s*([^=]+?)\s*===/g);
    const map: Record<string, string> = {};
    for (let i = 1; i < sections.length; i += 2) {
      const name = sections[i]?.trim() ?? '';
      const value = sections[i + 1]?.trim() ?? '';
      map[name] = value;
    }
    const osRelease: Record<string, string> = {};
    for (const line of (map['/etc/os-release'] ?? '').split('\n')) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      osRelease[k] = v;
    }
    return {
      raw: raw.stdout,
      uname: map['uname -a'] ?? '',
      osRelease,
    };
  },
};
