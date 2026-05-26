export type SecretKind =
  | 'private-key'
  | 'anthropic-key'
  | 'openrouter-key'
  | 'openai-key'
  | 'github-token'
  | 'slack-token'
  | 'aws-access-key'
  | 'jwt'
  | 'bearer-token'
  | 'basic-auth'
  | 'connection-string'
  | 'kv-secret'
  | 'env-secret'
  | 'user';

export interface SecretMatch {
  readonly kind: SecretKind;
  readonly index: number;
  readonly length: number;
}

interface Pattern {
  readonly kind: Exclude<SecretKind, 'user'>;
  readonly regex: RegExp;
  readonly replace: (match: string, ...groups: string[]) => string;
}

const tag = (kind: SecretKind): string => `[REDACTED:${kind}]`;

const PATTERNS: readonly Pattern[] = [
  {
    kind: 'private-key',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => tag('private-key'),
  },
  {
    kind: 'anthropic-key',
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replace: () => tag('anthropic-key'),
  },
  {
    kind: 'openrouter-key',
    regex: /\bsk-or-[A-Za-z0-9_-]{20,}\b/g,
    replace: () => tag('openrouter-key'),
  },
  {
    kind: 'openai-key',
    regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replace: () => tag('openai-key'),
  },
  {
    kind: 'github-token',
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    replace: () => tag('github-token'),
  },
  {
    kind: 'slack-token',
    regex: /\bxox[abps]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => tag('slack-token'),
  },
  {
    kind: 'aws-access-key',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => tag('aws-access-key'),
  },
  {
    kind: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
    replace: () => tag('jwt'),
  },
  {
    kind: 'bearer-token',
    regex: /(Authorization:\s*Bearer\s+)([A-Za-z0-9_.~+/=-]{8,})/gi,
    replace: (_match, prefix) => `${prefix ?? ''}${tag('bearer-token')}`,
  },
  {
    kind: 'basic-auth',
    regex: /(Authorization:\s*Basic\s+)([A-Za-z0-9+/=]{8,})/gi,
    replace: (_match, prefix) => `${prefix ?? ''}${tag('basic-auth')}`,
  },
  {
    kind: 'connection-string',
    regex: /([a-z][a-z0-9+]*:\/\/)([^:\s/@]+):([^@\s]+)(@[^\s/]+)/gi,
    replace: (_match, scheme, user, _password, hostPart) =>
      `${scheme ?? ''}${user ?? ''}:${tag('connection-string')}${hostPart ?? ''}`,
  },
  {
    kind: 'kv-secret',
    regex: /(\b(?:password|passwd|secret|token|api[_-]?key|apikey|auth|credential)\s*[:=]\s*)(['"]?)(?!\[REDACTED:)([^\s'";]+)\2/gi,
    replace: (_match, keyAndSep, quote) =>
      `${keyAndSep ?? ''}${quote ?? ''}${tag('kv-secret')}${quote ?? ''}`,
  },
  {
    kind: 'env-secret',
    regex: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)=(?!\[REDACTED:)(\S+)/g,
    replace: (_match, varName) => `${varName ?? ''}=${tag('env-secret')}`,
  },
];

function freshGlobal(re: RegExp): RegExp {
  const flags = re.global ? re.flags : `${re.flags}g`;
  return new RegExp(re.source, flags);
}

/**
 * Cheap pre-pass: if the input contains NO substring that looks remotely like
 * a secret marker, skip the full pattern scan. Empirically this short-circuits
 * the vast majority of streaming chunks (log lines, "uptime", numeric output)
 * which trims noticeable work during high-throughput streaming.
 *
 * The pattern is intentionally permissive — false positives just fall through
 * to the full scan, false negatives would be a security bug. When adding new
 * secret patterns to PATTERNS, make sure their identifying substring is also
 * matched here.
 */
const SECRET_SENTINEL = new RegExp(
  [
    '[A-Z0-9]{16,}',                  // long alphanumeric runs (AKIA…, base64, hex tokens, JWT segments)
    'sk-',                            // OpenAI / Anthropic / OpenRouter key prefixes
    'gh[pousr]_',                     // GitHub PAT prefixes
    'xox[bopas]-',                    // Slack tokens
    'eyJ',                            // base64 start of a JWT header
    '-----BEGIN',                     // PEM blocks
    '[a-z]+://[^@\\s]+:[^@\\s]+@',    // scheme://user:pwd@ — postgres/mysql/mongo/redis/http/etc.
    'Bearer\\s+\\S',                  // Bearer header (case-insensitive flag below)
    'Basic\\s+[A-Za-z0-9+/=]',        // Basic auth header
    'authoriz(?:ation)?\\s*[:=]',     // Authorization: …
    '(?:password|token|key|secret|credential|api[_-]?key)\\w*\\s*[:=]',
  ].join('|'),
  'i',
);

export function scrubText(input: string, userPatterns: readonly RegExp[] = []): string {
  if (input.length < 8) return input;
  if (userPatterns.length === 0 && !SECRET_SENTINEL.test(input)) {
    return input;
  }
  let out = input;
  for (const { regex, replace } of PATTERNS) {
    out = out.replace(freshGlobal(regex), replace);
  }
  for (const re of userPatterns) {
    out = out.replace(freshGlobal(re), tag('user'));
  }
  return out;
}

export function detectSecrets(
  input: string,
  userPatterns: readonly RegExp[] = [],
): SecretMatch[] {
  const matches: SecretMatch[] = [];

  for (const { kind, regex } of PATTERNS) {
    for (const m of input.matchAll(freshGlobal(regex))) {
      const matched = m[0];
      if (matched === undefined) continue;
      matches.push({ kind, index: m.index ?? 0, length: matched.length });
    }
  }

  for (const re of userPatterns) {
    for (const m of input.matchAll(freshGlobal(re))) {
      const matched = m[0];
      if (matched === undefined) continue;
      matches.push({ kind: 'user', index: m.index ?? 0, length: matched.length });
    }
  }

  return matches.sort((a, b) => a.index - b.index);
}

export function hasSecret(input: string, userPatterns: readonly RegExp[] = []): boolean {
  for (const { regex } of PATTERNS) {
    if (freshGlobal(regex).test(input)) return true;
  }
  for (const re of userPatterns) {
    if (freshGlobal(re).test(input)) return true;
  }
  return false;
}
