import { scrubText } from '../security/scrub.ts';

import type { CheckOutcomeKind } from '../monitor/types.ts';

/**
 * Webhook payloads are built from METADATA ONLY. There is intentionally no
 * field for check output or failure detail in WebhookInput — raw evidence
 * never leaves the machine via this channel (CLAUDE.md security invariant:
 * "Never send unredacted secrets to any model or any log", and by extension
 * any remote endpoint).
 */
export interface WebhookInput {
  readonly planName: string;
  readonly checkName: string;
  readonly outcomeKind: Exclude<CheckOutcomeKind, 'pass'>;
  readonly environment: string;
  readonly atMs: number;
}

export interface WebhookPayload {
  readonly event: 'piper-watch-anomaly';
  readonly plan: string;
  readonly check: string;
  readonly kind: string;
  readonly environment: string;
  readonly at: number;
}

export interface WebhookResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface PostWebhookOptions {
  /** Injected for tests. Defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
}

export function buildWebhookPayload(
  input: WebhookInput,
  userScrubPatterns: readonly RegExp[] = [],
): WebhookPayload {
  return {
    event: 'piper-watch-anomaly',
    plan: scrubText(input.planName, userScrubPatterns),
    check: scrubText(input.checkName, userScrubPatterns),
    kind: input.outcomeKind,
    environment: scrubText(input.environment, userScrubPatterns),
    at: input.atMs,
  };
}

export async function postWebhook(
  url: string,
  payload: WebhookPayload,
  options: PostWebhookOptions = {},
): Promise<WebhookResult> {
  if (!url.startsWith('https://')) {
    // Surface enough context to diagnose without leaking the full URL
    // (the URL itself might embed a token in the path).
    return {
      ok: false,
      message: `webhook URL must use https — insecure schemes are not allowed`,
    };
  }
  const fetchFn = options.fetchFn ?? fetch;
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return { ok: false, message: `webhook returned HTTP ${response.status}` };
    }
    return { ok: true, message: 'delivered' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
