export type PathDenyKind =
  | 'ssh-private-key'
  | 'ssh-pem'
  | 'ssh-known-hosts'
  | 'aws-credentials'
  | 'aws-config'
  | 'kube-config'
  | 'gnupg-dir'
  | 'docker-config'
  | 'netrc'
  | 'piper-dir'
  | 'env-file'
  | 'bare-ssh-key-name'
  | 'user';

export interface PathDenyMatch {
  readonly kind: PathDenyKind;
  readonly pattern: RegExp;
}

interface DenyEntry {
  readonly kind: Exclude<PathDenyKind, 'user'>;
  readonly regex: RegExp;
}

export const HARD_PATH_DENYLIST: readonly DenyEntry[] = [
  { kind: 'ssh-private-key',   regex: /(?:^|[/\\])\.ssh[/\\]id_[a-z0-9_-]+(\.pub)?$/i },
  { kind: 'ssh-pem',           regex: /(?:^|[/\\])\.ssh[/\\][^/\\]+\.pem$/i },
  { kind: 'ssh-known-hosts',   regex: /(?:^|[/\\])\.ssh[/\\]known_hosts$/i },
  { kind: 'aws-credentials',   regex: /(?:^|[/\\])\.aws[/\\]credentials$/i },
  { kind: 'aws-config',        regex: /(?:^|[/\\])\.aws[/\\]config$/i },
  { kind: 'kube-config',       regex: /(?:^|[/\\])\.kube[/\\]config$/i },
  { kind: 'gnupg-dir',         regex: /(?:^|[/\\])\.gnupg[/\\]/i },
  { kind: 'docker-config',     regex: /(?:^|[/\\])\.docker[/\\]config\.json$/i },
  { kind: 'netrc',             regex: /(?:^|[/\\])\.netrc$/i },
  { kind: 'piper-dir',         regex: /(?:^|[/\\])\.piper[/\\]/i },
  { kind: 'env-file',          regex: /(?:^|[/\\])\.env(\.[a-z0-9_-]+)?$/i },
  { kind: 'bare-ssh-key-name', regex: /(?:^|[/\\])id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i },
];

function normalize(path: string): string {
  return path.trim();
}

export function isPathDenied(
  path: string,
  userExtensions: readonly RegExp[] = [],
): boolean {
  const normalized = normalize(path);
  for (const { regex } of HARD_PATH_DENYLIST) {
    if (regex.test(normalized)) return true;
  }
  for (const re of userExtensions) {
    if (re.test(normalized)) return true;
  }
  return false;
}

export function whyDenied(
  path: string,
  userExtensions: readonly RegExp[] = [],
): PathDenyMatch | null {
  const normalized = normalize(path);
  for (const entry of HARD_PATH_DENYLIST) {
    if (entry.regex.test(normalized)) {
      return { kind: entry.kind, pattern: entry.regex };
    }
  }
  for (const re of userExtensions) {
    if (re.test(normalized)) {
      return { kind: 'user', pattern: re };
    }
  }
  return null;
}

export class PathDeniedError extends Error {
  readonly path: string;
  readonly kind: PathDenyKind;

  constructor(path: string, kind: PathDenyKind) {
    super(`path is in the denylist (${kind}): ${path}`);
    this.name = 'PathDeniedError';
    this.path = path;
    this.kind = kind;
  }
}

export function assertPathAllowed(
  path: string,
  userExtensions: readonly RegExp[] = [],
): void {
  const match = whyDenied(path, userExtensions);
  if (match !== null) {
    throw new PathDeniedError(path, match.kind);
  }
}
