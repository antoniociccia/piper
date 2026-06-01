// src/monitor/expectations.ts
import type { Expectation } from './types.ts';

export interface ExpectationInput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  /** Output of the action's parseResult, when the check runner could produce it. */
  readonly parsed?: unknown;
}

export interface ExpectationResult {
  readonly passed: boolean;
  readonly detail: string;
}

function pass(detail: string): ExpectationResult {
  return { passed: true, detail };
}

function fail(detail: string): ExpectationResult {
  return { passed: false, detail };
}

/**
 * The contract for action parseResult output consumed by the `all_running`
 * expectation: each item must expose a `state` that equals 'running'
 * (case-insensitive) when healthy. Action parsers (docker ps, kubectl get pods)
 * are responsible for normalising their tool's vocabulary into this shape.
 */
export interface RunnableItem {
  readonly name?: unknown;
  readonly state?: unknown;
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function navigateJsonPath(root: unknown, path: string): { found: boolean; value: unknown } {
  let cursor: unknown = root;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return { found: false, value: undefined };
    const record = cursor as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return { found: false, value: undefined };
    cursor = record[segment];
  }
  return { found: true, value: cursor };
}

const PERCENT_PATTERN = /(\d{1,3})%/g;

export function evaluateExpectation(exp: Expectation, input: ExpectationInput): ExpectationResult {
  switch (exp.kind) {
    case 'exit_zero': {
      if (input.exitCode === 0) return pass('exit code 0');
      return fail(`exit code ${input.exitCode}${input.stderr.trim() === '' ? '' : `: ${input.stderr.trim().slice(0, 200)}`}`);
    }

    case 'all_running': {
      if (!Array.isArray(input.parsed)) return fail('no parsed item list available');
      if (input.parsed.length === 0) return fail('zero items reported (expected at least one running)');
      const items = input.parsed as readonly RunnableItem[];
      const offenders = items.filter((i) => String(i.state ?? '').toLowerCase() !== 'running');
      if (offenders.length === 0) return pass(`all ${items.length} items running`);
      const named = offenders
        .map((o) => `${String(o.name ?? '?')} (${String(o.state ?? 'unknown')})`)
        .join(', ');
      return fail(`not running: ${named}`);
    }

    case 'max_percent': {
      const matches = [...input.stdout.matchAll(PERCENT_PATTERN)]
        .map((m) => Number(m[1]))
        .filter((n) => Number.isFinite(n));
      if (matches.length === 0) return fail('no percentage found in output');
      const max = Math.max(...matches);
      if (max <= exp.value) return pass(`max ${max}% ≤ ${exp.value}%`);
      return fail(`${max}% exceeds threshold ${exp.value}%`);
    }

    case 'min_count': {
      const count = Array.isArray(input.parsed)
        ? input.parsed.length
        : input.stdout.split('\n').filter((l) => l.trim() !== '').length;
      if (count >= exp.value) return pass(`count ${count} ≥ ${exp.value}`);
      return fail(`count ${count} below minimum ${exp.value}`);
    }

    case 'regex_match': {
      const re = safeRegex(exp.pattern);
      if (re === null) return fail(`invalid pattern: ${exp.pattern}`);
      if (re.test(input.stdout)) return pass(`output matches /${exp.pattern}/`);
      return fail(`output does not match /${exp.pattern}/`);
    }

    case 'regex_absent': {
      const re = safeRegex(exp.pattern);
      if (re === null) return fail(`invalid pattern: ${exp.pattern}`);
      if (!re.test(input.stdout)) return pass(`output clean of /${exp.pattern}/`);
      return fail(`output matches forbidden /${exp.pattern}/`);
    }

    case 'json_path_eq': {
      let root: unknown;
      try {
        root = JSON.parse(input.stdout);
      } catch {
        return fail('output is not valid JSON');
      }
      const nav = navigateJsonPath(root, exp.path);
      if (!nav.found) return fail(`path not found: ${exp.path}`);
      if (nav.value === exp.value) return pass(`${exp.path} = ${String(exp.value)}`);
      return fail(`${exp.path} = ${String(nav.value)} (expected ${String(exp.value)})`);
    }
  }
}
