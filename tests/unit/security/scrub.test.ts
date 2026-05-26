import { describe, expect, test } from 'bun:test';

import { detectSecrets, hasSecret, scrubText, type SecretKind } from '../../../src/security/scrub.ts';

interface Positive {
  readonly name: string;
  readonly input: string;
  readonly kind: SecretKind;
  readonly mustNotContain?: string;
}

interface Negative {
  readonly name: string;
  readonly input: string;
}

const PEM_KEY = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
  'QyNTUxOQAAACBYWzqWmrXNkjwQGfwYJUTKVlyhmwjJ48qHnD0Z2VBVVw==',
  '-----END OPENSSH PRIVATE KEY-----',
].join('\n');

const PEM_RSA = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz==',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

const POSITIVES: readonly Positive[] = [
  // PEM private keys (4)
  { name: 'OpenSSH ed25519 key block', input: PEM_KEY, kind: 'private-key', mustNotContain: 'AAAAMwAA' },
  { name: 'RSA PEM key block', input: PEM_RSA, kind: 'private-key', mustNotContain: 'MIIEpAIBAAKC' },
  { name: 'PEM key inline in a log line', input: `error: ${PEM_RSA} (parse failed)`, kind: 'private-key' },
  { name: 'PEM key surrounded by CRLF', input: PEM_KEY.replace(/\n/g, '\r\n'), kind: 'private-key' },

  // JWT (3)
  { name: 'plain JWT', input: 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSIsIm5hbWUiOiJKb2huIn0.abc123def456', kind: 'jwt' },
  { name: 'JWT in middle of a sentence', input: 'we sent eyJaaaa.bbbb.ccccccc to the upstream', kind: 'jwt' },
  { name: 'JWT in HTTP header value', input: 'X-Token: eyJxxxx.yyyyyy.zzzzzzzz', kind: 'jwt' },

  // AWS (2)
  { name: 'AWS access key (AKIA)', input: 'AWS_ACCESS=AKIAIOSFODNN7EXAMPLE for the build', kind: 'aws-access-key' },
  { name: 'AWS STS session key (ASIA)', input: 'ASIATESTSESSIONKEY12 is the session id', kind: 'aws-access-key' },

  // Anthropic / OpenRouter / OpenAI (4)
  {
    name: 'Anthropic API key',
    input: 'export key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA',
    kind: 'anthropic-key',
    mustNotContain: 'AAAAAAAAAAAAAAAAAAAAAA',
  },
  {
    name: 'OpenRouter API key',
    input: 'token: sk-or-v1-XXXXXXXXXXXXXXXXXXXXXX',
    kind: 'openrouter-key',
    mustNotContain: 'XXXXXXXXXXXXXXXXXXXXXX',
  },
  { name: 'Generic OpenAI key', input: 'sk-proj-abcdefghij1234567890', kind: 'openai-key' },
  { name: 'OpenAI key in JSON', input: '{"api_key": "sk-abcdefghij1234567890ZZZ"}', kind: 'openai-key' },

  // GitHub (2)
  { name: 'GitHub PAT (classic)', input: 'token=ghp_1234567890ABCDEFGHIJklmnopqrstuvwxyz12', kind: 'github-token' },
  { name: 'GitHub server-to-server', input: 'header: ghs_1234567890ABCDEFGHIJklmnopqrstuvwxyz12', kind: 'github-token' },

  // Slack (2)
  { name: 'Slack bot token', input: 'xoxb-1234567890-ABCDEFGHIJK', kind: 'slack-token' },
  { name: 'Slack user token', input: 'xoxp-1234567890-ABCDEFGHIJK', kind: 'slack-token' },

  // Authorization headers (3)
  { name: 'Bearer header', input: 'Authorization: Bearer abc.def.ghi-xyz', kind: 'bearer-token' },
  { name: 'bearer header lowercase', input: 'authorization: Bearer XYZ123_token', kind: 'bearer-token' },
  { name: 'Basic auth header', input: 'Authorization: Basic dXNlcjpwYXNzd29yZA==', kind: 'basic-auth' },

  // Connection strings (4)
  { name: 'Postgres conn-string', input: 'DATABASE_URL=postgresql://alice:hunter2@db.internal:5432/prod', kind: 'connection-string' },
  { name: 'MySQL conn-string', input: 'use mysql://root:rootpw@127.0.0.1:3306/app', kind: 'connection-string' },
  { name: 'MongoDB conn-string', input: 'mongodb://admin:s3cret@cluster0.mongodb.net/?retryWrites=true', kind: 'connection-string' },
  { name: 'Redis conn-string', input: 'redis://default:redispass@redis.internal:6379', kind: 'connection-string' },

  // KV secrets (5)
  { name: 'password kv =', input: 'password=hunter2', kind: 'kv-secret' },
  { name: 'password kv : quoted', input: 'password: "hunter2"', kind: 'kv-secret' },
  { name: 'token kv =', input: 'token=bareword-secret', kind: 'kv-secret' },
  { name: 'api_key kv =', input: 'api_key=xyz123abc', kind: 'kv-secret' },
  { name: 'credential kv :', input: 'credential: my-cred-value', kind: 'kv-secret' },

  // Env-var secrets (5)
  { name: 'MY_API_KEY', input: 'export MY_API_KEY=abc123', kind: 'env-secret' },
  { name: 'SECRET_TOKEN', input: 'SECRET_TOKEN=def456', kind: 'env-secret' },
  { name: 'AWS env password', input: 'DB_PASSWORD=topsecret', kind: 'env-secret' },
  { name: 'CREDENTIAL var', input: 'API_CREDENTIAL=xyz', kind: 'env-secret' },
  { name: 'TOKEN var with suffix', input: 'BUILD_TOKEN_PRIMARY=value123', kind: 'env-secret' },
];

const NEGATIVES: readonly Negative[] = [
  { name: 'lowercase _token suffix is a counter, not a secret', input: 'error_token=42' },
  { name: 'tokenizer is not the word token', input: 'tokenizer="word"' },
  { name: 'authorization header without value', input: 'Authorization:' },
  { name: 'plain word password without separator', input: 'remember your password' },
  { name: 'plain prose with no patterns', input: 'the cat sat on the mat' },
  { name: 'random alphanumerics with no recognizable prefix', input: 'abc123def456ghi789' },
  { name: 'sixteen digits without AWS prefix', input: '1234567890123456 is just a number' },
  { name: 'URL without credentials', input: 'visit https://example.com/path/to/page' },
  { name: 'single base64 segment without dots', input: 'eyJabcdefghij is incomplete' },
  { name: 'two-segment JWT-like is not a JWT', input: 'eyJaaaa.bbbb (missing third part)' },
  { name: 'lowercase env-like assignment', input: 'secret_handshake_count=5' },
  { name: 'underscore prefix is not a word boundary', input: '_secret=99' },
];

describe('security/scrub — positives must redact', () => {
  for (const positive of POSITIVES) {
    test(positive.name, () => {
      const scrubbed = scrubText(positive.input);
      expect(scrubbed).toContain(`[REDACTED:${positive.kind}]`);
      if (positive.mustNotContain !== undefined) {
        expect(scrubbed).not.toContain(positive.mustNotContain);
      }
      expect(hasSecret(positive.input)).toBe(true);
      const detected = detectSecrets(positive.input);
      expect(detected.length).toBeGreaterThan(0);
      expect(detected.some((m) => m.kind === positive.kind)).toBe(true);
    });
  }
});

describe('security/scrub — negatives must not redact', () => {
  for (const negative of NEGATIVES) {
    test(negative.name, () => {
      const scrubbed = scrubText(negative.input);
      expect(scrubbed).toBe(negative.input);
      expect(hasSecret(negative.input)).toBe(false);
      expect(detectSecrets(negative.input)).toEqual([]);
    });
  }
});

describe('security/scrub — structural guarantees', () => {
  test('preserves the Authorization prefix while redacting only the token', () => {
    const scrubbed = scrubText('Authorization: Bearer abc.def.ghi-xyz');
    expect(scrubbed).toBe('Authorization: Bearer [REDACTED:bearer-token]');
  });

  test('preserves scheme and user while redacting only the password in conn strings', () => {
    const scrubbed = scrubText('postgresql://alice:hunter2@db:5432/app');
    expect(scrubbed).toBe('postgresql://alice:[REDACTED:connection-string]@db:5432/app');
  });

  test('anthropic key matched before generic openai key', () => {
    const detected = detectSecrets('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA');
    expect(detected[0]?.kind).toBe('anthropic-key');
  });

  test('user patterns redact with [REDACTED:user]', () => {
    const scrubbed = scrubText('INTERNAL-ID-987654321 marker', [/INTERNAL-ID-\d+/]);
    expect(scrubbed).toBe('[REDACTED:user] marker');
  });

  test('user patterns also surface in detectSecrets with kind=user', () => {
    const matches = detectSecrets('INTERNAL-ID-987654321', [/INTERNAL-ID-\d+/]);
    expect(matches).toEqual([{ kind: 'user', index: 0, length: 'INTERNAL-ID-987654321'.length }]);
  });

  test('non-global user regex is upgraded to global automatically', () => {
    const scrubbed = scrubText('foo XYZ bar XYZ baz', [/XYZ/]);
    expect(scrubbed).toBe('foo [REDACTED:user] bar [REDACTED:user] baz');
  });

  test('scrubText is idempotent on already-scrubbed output', () => {
    const once = scrubText('password=hunter2');
    const twice = scrubText(once);
    expect(twice).toBe(once);
  });

  test('detectSecrets returns matches sorted by index', () => {
    const input = 'first AKIAIOSFODNN7EXAMPLE then sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZZZ';
    const matches = detectSecrets(input);
    const sorted = [...matches].sort((a, b) => a.index - b.index);
    expect(matches).toEqual(sorted);
  });
});
