import { describe, expect, test } from 'bun:test';

import {
  assertPathAllowed,
  HARD_PATH_DENYLIST,
  isPathDenied,
  PathDeniedError,
  whyDenied,
  type PathDenyKind,
} from '../../../src/security/paths.ts';

interface DeniedCase {
  readonly path: string;
  readonly kind: PathDenyKind;
}

const DENIED: readonly DeniedCase[] = [
  // ssh-private-key
  { path: '~/.ssh/id_rsa',                          kind: 'ssh-private-key' },
  { path: '~/.ssh/id_ed25519',                      kind: 'ssh-private-key' },
  { path: '~/.ssh/id_ecdsa',                        kind: 'ssh-private-key' },
  { path: '/home/user/.ssh/id_dsa',                 kind: 'ssh-private-key' },
  { path: '/Users/alice/.SSH/id_rsa',               kind: 'ssh-private-key' },
  { path: '~/.ssh/id_rsa.pub',                      kind: 'ssh-private-key' },
  { path: 'C:\\Users\\me\\.ssh\\id_ed25519',        kind: 'ssh-private-key' },
  // ssh-pem
  { path: '~/.ssh/aws-key.pem',                     kind: 'ssh-pem' },
  { path: '/root/.ssh/deploy.pem',                  kind: 'ssh-pem' },
  // ssh-known-hosts
  { path: '~/.ssh/known_hosts',                     kind: 'ssh-known-hosts' },
  // aws-credentials / aws-config
  { path: '~/.aws/credentials',                     kind: 'aws-credentials' },
  { path: '/Users/x/.aws/credentials',              kind: 'aws-credentials' },
  { path: '~/.aws/config',                          kind: 'aws-config' },
  // kube-config
  { path: '~/.kube/config',                         kind: 'kube-config' },
  // gnupg dir (any file)
  { path: '~/.gnupg/secring.gpg',                   kind: 'gnupg-dir' },
  { path: '~/.gnupg/private-keys-v1.d/abc.key',     kind: 'gnupg-dir' },
  // docker
  { path: '~/.docker/config.json',                  kind: 'docker-config' },
  // netrc
  { path: '~/.netrc',                               kind: 'netrc' },
  { path: '/root/.netrc',                           kind: 'netrc' },
  // piper-dir (any file inside)
  { path: '~/.piper/config.toml',                   kind: 'piper-dir' },
  { path: '~/.piper/data/db',                       kind: 'piper-dir' },
  // env files
  { path: '.env',                                   kind: 'env-file' },
  { path: '.env.local',                             kind: 'env-file' },
  { path: '.env.production',                        kind: 'env-file' },
  { path: '/app/.env',                              kind: 'env-file' },
  { path: '/srv/app/.env.staging',                  kind: 'env-file' },
  // bare ssh key names
  { path: 'id_rsa',                                 kind: 'bare-ssh-key-name' },
  { path: '/tmp/id_ed25519',                        kind: 'bare-ssh-key-name' },
  { path: 'backup/id_ecdsa.pub',                    kind: 'bare-ssh-key-name' },
];

const ALLOWED: readonly string[] = [
  '/var/log/app.log',
  '/var/log/syslog',
  '~/Documents/notes.txt',
  '.envoyrc',                       // doesn't end with .env
  '.environment',                   // doesn't end with .env
  'environment.yml',
  'config.toml',                    // not in .piper/
  'mykey.txt',
  '/etc/nginx/nginx.conf',
  'pipefile.toml',
  '/tmp/id_rsa_handle.go',          // bare id_rsa is the FILENAME suffix here, not whole name
  'idle_timeout.conf',              // does not match id_rsa
  '/opt/app/sshd_config',           // sshd_config, not .ssh/...
  '/home/user/projects/.gitignore',
  '~/code/.envoy.yml',
];

describe('security/paths — denied', () => {
  for (const c of DENIED) {
    test(`denied: ${c.path}`, () => {
      expect(isPathDenied(c.path)).toBe(true);
      const match = whyDenied(c.path);
      expect(match?.kind).toBe(c.kind);
    });
  }
});

describe('security/paths — allowed', () => {
  for (const p of ALLOWED) {
    test(`allowed: ${p}`, () => {
      expect(isPathDenied(p)).toBe(false);
      expect(whyDenied(p)).toBeNull();
    });
  }
});

describe('security/paths — coverage', () => {
  test('every HARD_PATH_DENYLIST kind has at least one positive case', () => {
    const coveredKinds = new Set(DENIED.map((c) => c.kind));
    for (const entry of HARD_PATH_DENYLIST) {
      expect(coveredKinds.has(entry.kind)).toBe(true);
    }
  });
});

describe('security/paths — user extensions', () => {
  test('user-supplied regex denies a custom internal path', () => {
    const internal = /(^|[/\\])\.company-secrets[/\\]/i;
    expect(isPathDenied('/srv/.company-secrets/credentials', [internal])).toBe(true);
    expect(whyDenied('/srv/.company-secrets/credentials', [internal])?.kind).toBe('user');
  });

  test('user extensions cannot weaken the hard list', () => {
    expect(isPathDenied('~/.ssh/id_rsa', [/^never-match-anything-z9q$/])).toBe(true);
  });
});

describe('security/paths — assertPathAllowed', () => {
  test('throws PathDeniedError on a denied path', () => {
    expect(() => assertPathAllowed('~/.aws/credentials')).toThrow(PathDeniedError);
  });

  test('PathDeniedError carries kind and path', () => {
    try {
      assertPathAllowed('~/.ssh/id_rsa');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PathDeniedError);
      const denied = err as PathDeniedError;
      expect(denied.kind).toBe('ssh-private-key');
      expect(denied.path).toBe('~/.ssh/id_rsa');
    }
  });

  test('does not throw on an allowed path', () => {
    expect(() => assertPathAllowed('/var/log/app.log')).not.toThrow();
  });
});

describe('security/paths — robustness', () => {
  test('leading/trailing whitespace is trimmed before matching', () => {
    expect(isPathDenied('  ~/.aws/credentials  ')).toBe(true);
  });

  test('case-insensitivity holds for all entries', () => {
    expect(isPathDenied('~/.SSH/ID_RSA')).toBe(true);
    expect(isPathDenied('~/.AWS/CREDENTIALS')).toBe(true);
  });
});
