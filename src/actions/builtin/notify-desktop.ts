import { z } from 'zod';

import type { Action } from '../types.ts';

/**
 * Printable text only: no backslash, no double quote, no control characters,
 * no leading dash. This is the schema-level cage (Layer 2) — it rejects the
 * AppleScript breakout characters (`"` and `\`) and the `notify-send` flag
 * prefix (a leading `-`) before args ever reach `buildCommand`. Spaces and
 * single quotes are allowed so the notifier's sanitized strings still pass.
 */
const SAFE_TEXT = new RegExp('^(?![-])[^\\\\"\\x00-\\x1f\\x7f]*$');
const SAFE_TEXT_MESSAGE =
  'must not contain quotes, backslashes, or control characters, and must not start with a dash';

const argsSchema = z.object({
  title: z.string().min(1).max(120).regex(SAFE_TEXT, `title ${SAFE_TEXT_MESSAGE}`),
  message: z.string().min(1).max(500).regex(SAFE_TEXT, `message ${SAFE_TEXT_MESSAGE}`),
});

type Args = z.infer<typeof argsSchema>;

/**
 * AppleScript string literals have no escape sequences: a double quote always
 * terminates the string, and a backslash is a literal character. The only safe
 * way to embed untrusted text is to remove the breakout characters entirely.
 * This is the Layer-1 net: even if `buildCommand` is called directly without
 * schema validation, the produced AppleScript cannot break out of its literal.
 */
function sanitizeForAppleScript(text: string): string {
  // Replace double quotes with a typographic quote (visually equivalent, inert
  // inside an AppleScript string) and strip backslashes.
  return text.replaceAll('"', '’').replaceAll('\\', '');
}

/**
 * Local desktop notification (macOS osascript / Linux notify-send). Lives in
 * the catalog because ALL process spawning must go through the Executor —
 * which also means every notification is audit-logged. No SSH, no environment:
 * this always runs on the user's own machine.
 *
 * Tier `read`: it mutates nothing in any managed environment.
 *
 * This action intentionally has no `environment` arg. The executor only
 * looks up an environment when `argsObj['environment']` is a string; if that
 * field is absent, it leaves `resolvedEnvironment` as the ctx default. The
 * `buildCommand` below ignores `ctx` entirely and returns a local argv —
 * the Executor's `runProcess` then spawns it directly on the user's machine,
 * which is the intended behavior.
 */
export const notifyDesktop: Action<Args, string> = {
  name: 'notify.desktop',
  tier: 'read',
  description:
    'Show a desktop notification on the local machine (macOS Notification Center via osascript, or Linux libnotify via notify-send). Used by watch mode to alert on anomalies; can also be called to tell the user a long diagnostic finished.',
  argsSchema,
  buildCommand: (args) => {
    if (process.platform === 'darwin') {
      // AppleScript literals have no escapes — sanitize, then wrap in plain
      // double quotes. After sanitizing, the text cannot contain `"` or `\`,
      // so it can never break out of the string literal into live code.
      const message = sanitizeForAppleScript(args.message);
      const title = sanitizeForAppleScript(args.title);
      const script = `display notification "${message}" with title "${title}"`;
      return ['osascript', '-e', script];
    }
    // Linux / everything else: notify-send. Title and message are separate
    // argv entries, so shell injection is not possible — but a title starting
    // with `-` would be parsed as a flag. `--` ends option parsing so the
    // title/message are always treated as positional arguments.
    return ['notify-send', '--', args.title, args.message];
  },
  parseResult: (raw) =>
    raw.exitCode === 0 ? 'notified' : `notification failed: ${raw.stderr.trim()}`,
};
