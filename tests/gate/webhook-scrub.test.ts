import { describe, expect, test } from 'bun:test';

import { buildWebhookPayload, postWebhook } from '../../src/notify/webhook.ts';

describe('GATE: webhook payloads cannot leak evidence', () => {
  test('payload contains only plan/check/kind/timestamp — no detail, no output', () => {
    const payload = buildWebhookPayload({
      planName: 'staging-health',
      checkName: 'docker.ps',
      outcomeKind: 'expectation-failed',
      environment: 'staging',
      atMs: 1_700_000_000_000,
      // NOTE: there is deliberately NO field for detail/output in the input type.
    });
    const keys = Object.keys(payload).sort();
    expect(keys).toEqual(['at', 'check', 'environment', 'event', 'kind', 'plan']);
    expect(JSON.stringify(payload)).not.toContain('password');
  });

  test('plan/check names that somehow contain secrets are scrubbed', () => {
    // ghp_ + 36 alphanumeric chars matches the github-token pattern
    const payload = buildWebhookPayload({
      planName: 'plan-with-token-ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      checkName: 'check',
      outcomeKind: 'check-error',
      environment: 'staging',
      atMs: 0,
    });
    expect(JSON.stringify(payload)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(JSON.stringify(payload)).toContain('[REDACTED');
  });

  test('postWebhook refuses non-https URLs', async () => {
    const result = await postWebhook('http://insecure.example.com/hook', {
      event: 'piper-watch-anomaly', plan: 'p', check: 'c', kind: 'check-error', environment: 'e', at: 0,
    }, { fetchFn: () => Promise.resolve(new Response('ok')) });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('https');
  });

  test('postWebhook posts JSON to https URLs via the injected fetch', async () => {
    let captured: { url: string; body: string } | null = null;
    const result = await postWebhook('https://hooks.example.com/x', {
      event: 'piper-watch-anomaly', plan: 'p', check: 'c', kind: 'check-error', environment: 'e', at: 0,
    }, {
      fetchFn: (url, init) => {
        captured = { url: String(url), body: String(init?.body ?? '') };
        return Promise.resolve(new Response('ok', { status: 200 }));
      },
    });
    expect(result.ok).toBe(true);
    expect(captured?.url).toBe('https://hooks.example.com/x');
    expect(JSON.parse(captured?.body ?? '{}')).toHaveProperty('event', 'piper-watch-anomaly');
  });
});
