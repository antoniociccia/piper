export type SlashCommand =
  | { readonly kind: 'env-add'; readonly name: string; readonly host: string; readonly sshUser: string; readonly port?: number; readonly identityFile?: string; readonly description?: string; readonly tags?: readonly string[] }
  | { readonly kind: 'env-list' }
  | { readonly kind: 'env-remove'; readonly name: string }
  | { readonly kind: 'help' }
  | { readonly kind: 'quit' }
  | { readonly kind: 'save'; readonly filename?: string }
  | { readonly kind: 'session-report'; readonly filename?: string }
  | { readonly kind: 'annex'; readonly title?: string }
  | { readonly kind: 'skill'; readonly target?: string }
  | { readonly kind: 'model'; readonly target?: string }
  | { readonly kind: 'resume' }
  | { readonly kind: 'memory' }
  | { readonly kind: 'watch'; readonly target?: string }
  | { readonly kind: 'debug' };

export type ParseResult =
  | { readonly ok: true; readonly command: SlashCommand }
  | { readonly ok: false; readonly message: string };

const TARGET_PATTERN = /^([A-Za-z0-9_-]+)@([A-Za-z0-9._-]+)(?::(\d+))?$/;
const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

interface TokenIterator {
  readonly tokens: readonly string[];
  index: number;
}

function nextToken(it: TokenIterator): string | undefined {
  const t = it.tokens[it.index];
  it.index += 1;
  return t;
}

function consumeFlag(it: TokenIterator): string | undefined {
  return nextToken(it);
}

function consumeBalancedQuotedRest(rest: string): string {
  // If the rest starts with a quote, return the content between matching quotes.
  if (rest.length >= 2 && (rest.startsWith('"') || rest.startsWith("'"))) {
    const q = rest[0];
    const end = rest.indexOf(q!, 1);
    if (end !== -1) return rest.slice(1, end);
  }
  return rest;
}

function tokenize(input: string): readonly string[] {
  // Split on whitespace but keep quoted segments together.
  const result: string[] = [];
  let i = 0;
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i] ?? '')) i += 1;
    if (i >= input.length) break;
    const ch = input[i];
    if (ch === '"' || ch === "'") {
      const end = input.indexOf(ch, i + 1);
      if (end === -1) {
        result.push(input.slice(i + 1));
        break;
      }
      result.push(input.slice(i + 1, end));
      i = end + 1;
    } else {
      const start = i;
      while (i < input.length && !/\s/.test(input[i] ?? '')) i += 1;
      result.push(input.slice(start, i));
    }
  }
  return result;
}

export function parseSlashCommand(line: string): ParseResult | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;

  const tokens = tokenize(trimmed.slice(1));
  const it: TokenIterator = { tokens, index: 0 };
  const head = nextToken(it);
  if (head === undefined) return { ok: false, message: 'empty command' };

  if (head === 'help' || head === '?') return { ok: true, command: { kind: 'help' } };
  if (head === 'quit' || head === 'q' || head === 'exit') return { ok: true, command: { kind: 'quit' } };

  if (head === 'save' || head === 's') {
    const filename = nextToken(it);
    return { ok: true, command: { kind: 'save', ...(filename === undefined ? {} : { filename }) } };
  }

  if (head === 'model' || head === 'models' || head === 'm') {
    const rest = trimmed.slice(1 + head.length).trim();
    return {
      ok: true,
      command: { kind: 'model', ...(rest === '' ? {} : { target: rest }) },
    };
  }

  if (head === 'resume' || head === 'sessions') {
    return { ok: true, command: { kind: 'resume' } };
  }

  if (head === 'memory' || head === 'mem' || head === 'rag') {
    return { ok: true, command: { kind: 'memory' } };
  }

  if (head === 'watch') {
    // Everything after the verb is the target: a single token names a plan,
    // multiple words are a free-text compile request. Either way it rides as
    // one opaque string and the App decides how to interpret it.
    const rest = trimmed.slice(1 + head.length).trim();
    return {
      ok: true,
      command: { kind: 'watch', ...(rest === '' ? {} : { target: rest }) },
    };
  }

  if (head === 'debug' || head === 'verbose') {
    return { ok: true, command: { kind: 'debug' } };
  }

  if (head === 'session-report' || head === 'summary' || head === 'recap') {
    const filename = nextToken(it);
    return {
      ok: true,
      command: { kind: 'session-report', ...(filename === undefined ? {} : { filename }) },
    };
  }

  if (head === 'env') {
    const sub = nextToken(it);
    if (sub === undefined) {
      return { ok: false, message: 'usage: /env add | list | remove' };
    }
    if (sub === 'list' || sub === 'ls') return { ok: true, command: { kind: 'env-list' } };
    if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
      const name = nextToken(it);
      if (name === undefined) return { ok: false, message: 'usage: /env remove <name>' };
      return { ok: true, command: { kind: 'env-remove', name } };
    }
    if (sub === 'add') {
      const name = nextToken(it);
      const target = nextToken(it);
      if (name === undefined || target === undefined) {
        return { ok: false, message: 'usage: /env add <name> <user@host[:port]> [--key path] [--desc text] [--tag t1,t2]' };
      }
      if (!NAME_PATTERN.test(name)) {
        return { ok: false, message: `invalid env name: ${name}` };
      }
      const targetMatch = TARGET_PATTERN.exec(target);
      if (targetMatch === null) {
        return { ok: false, message: `target must be user@host or user@host:port, got: ${target}` };
      }
      const sshUser = targetMatch[1] ?? '';
      const host = targetMatch[2] ?? '';
      const portStr = targetMatch[3];
      const port = portStr === undefined ? undefined : Number(portStr);

      let identityFile: string | undefined;
      let description: string | undefined;
      let tags: readonly string[] | undefined;

      while (it.index < it.tokens.length) {
        const flag = consumeFlag(it);
        if (flag === undefined) break;
        if (flag === '--key' || flag === '-i') {
          identityFile = nextToken(it);
        } else if (flag === '--desc' || flag === '--description') {
          description = nextToken(it);
        } else if (flag === '--tag' || flag === '--tags') {
          const v = nextToken(it);
          if (v !== undefined) tags = v.split(',').map((t) => t.trim()).filter((t) => t !== '');
        } else {
          return { ok: false, message: `unknown flag: ${flag}` };
        }
      }

      const cmd: Extract<SlashCommand, { kind: 'env-add' }> = {
        kind: 'env-add',
        name,
        host,
        sshUser,
        ...(port === undefined ? {} : { port }),
        ...(identityFile === undefined ? {} : { identityFile }),
        ...(description === undefined ? {} : { description: consumeBalancedQuotedRest(description) }),
        ...(tags === undefined ? {} : { tags }),
      };
      return { ok: true, command: cmd };
    }
    return { ok: false, message: `unknown env subcommand: ${sub}` };
  }

  return { ok: false, message: `unknown command: /${head}` };
}

export interface SlashCompletion {
  readonly command: string; // text inserted, includes leading slash
  readonly hint: string; // shown to the right
}

const SLASH_COMMANDS: readonly SlashCompletion[] = [
  { command: '/help', hint: 'show help' },
  { command: '/env add ', hint: '<name> <user@host[:port]> [--key …] [--desc …]' },
  { command: '/env list', hint: 'list registered environments' },
  { command: '/env remove ', hint: '<name>' },
  { command: '/save ', hint: '[filename] — save last report' },
  { command: '/session-report ', hint: '[filename] — recap whole session' },
  { command: '/annex ', hint: '[title] — annex this session as solved-case' },
  { command: '/model', hint: 'switch active model (local or OpenRouter)' },
  { command: '/memory', hint: 'inspect / manage the knowledge base (runbooks, ADRs, annex)' },
  { command: '/watch', hint: '[plan|description] — start a continuous monitoring loop' },
  { command: '/debug', hint: 'toggle verbose agent events (costs, synth status, verify result)' },
  { command: '/resume', hint: 'resume a previous session' },
  { command: '/compact', hint: 'force history compaction now' },
  { command: '/quit', hint: 'exit PIPER' },
];

/**
 * Returns ranked completions for an input line that starts with `/`.
 * Exact prefix matches first, then substring matches. Capped at 8 results.
 */
export function slashCompletions(line: string): readonly SlashCompletion[] {
  if (!line.startsWith('/')) return [];
  const lower = line.toLowerCase();
  const prefix = lower.split(' ')[0] ?? lower;
  const exact: SlashCompletion[] = [];
  const fuzzy: SlashCompletion[] = [];
  for (const c of SLASH_COMMANDS) {
    const cmdLower = c.command.toLowerCase();
    if (cmdLower.startsWith(prefix)) {
      exact.push(c);
    } else if (cmdLower.includes(prefix.slice(1))) {
      fuzzy.push(c);
    }
  }
  return [...exact, ...fuzzy].slice(0, 16);
}
