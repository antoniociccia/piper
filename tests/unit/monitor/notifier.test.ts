import { describe, expect, test } from 'bun:test';

import { createNotifier } from '../../../src/notify/notifier.ts';
import type { CheckOutcome, WatchPlan } from '../../../src/monitor/types.ts';

const PLAN: WatchPlan = {
  name: 'p',
  description: 'd',
  environment: 'staging',
  checks: [],
  runbook: '',
  source: 'user',
};

const OUTCOME: CheckOutcome = {
  checkName: 'c',
  kind: 'expectation-failed',
  detail: 'broken',
  exitCode: 1,
  executedAtMs: 0,
};

describe('notify/notifier', () => {
  test('dispatches to desktop (via executor exec) and webhooks; failures do not throw', async () => {
    const execCalls: string[] = [];
    const webhookCalls: string[] = [];

    const notifier = createNotifier({
      execDesktopNotification: (title, message) => {
        execCalls.push(`${title}|${message}`);
        return Promise.resolve();
      },
      webhookUrls: ['https://hooks.example.com/a', 'https://hooks.example.com/b'],
      postWebhookFn: (url) => {
        webhookCalls.push(url);
        if (url.endsWith('/b')) return Promise.resolve({ ok: false, message: 'HTTP 500' });
        return Promise.resolve({ ok: true, message: 'delivered' });
      },
    });

    const failures = await notifier.notifyAnomaly(PLAN, OUTCOME);

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toContain('PIPER');
    expect(webhookCalls).toHaveLength(2);
    // one webhook failed → reported, not thrown
    expect(failures).toHaveLength(1);
    expect(failures[0]?.channel).toContain('webhook');
  });

  test('works with no channels configured (no-op)', async () => {
    const notifier = createNotifier({});
    const failures = await notifier.notifyAnomaly(PLAN, OUTCOME);
    expect(failures).toEqual([]);
  });

  test('desktop failure is collected, not thrown', async () => {
    const notifier = createNotifier({
      execDesktopNotification: () => Promise.reject(new Error('osascript not found')),
    });
    const failures = await notifier.notifyAnomaly(PLAN, OUTCOME);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.channel).toBe('desktop');
    expect(failures[0]?.message).toContain('osascript');
  });

  test('pass outcomes do not dispatch webhooks', async () => {
    const webhookCalls: string[] = [];
    const notifier = createNotifier({
      webhookUrls: ['https://hooks.example.com/a'],
      postWebhookFn: (url) => {
        webhookCalls.push(url);
        return Promise.resolve({ ok: true, message: 'delivered' });
      },
    });
    const passOutcome: CheckOutcome = { ...OUTCOME, kind: 'pass' };
    const failures = await notifier.notifyAnomaly(PLAN, passOutcome);
    expect(webhookCalls).toHaveLength(0);
    expect(failures).toEqual([]);
  });

  test('hostile plan/check names are sanitized before desktop dispatch', async () => {
    const calls: string[] = [];
    const notifier = createNotifier({
      execDesktopNotification: (title, message) => {
        calls.push(`${title}|${message}`);
        return Promise.resolve();
      },
    });
    await notifier.notifyAnomaly(
      { ...PLAN, name: 'p"inject' },
      { ...OUTCOME, checkName: 'c" & (do shell script "pwn") & "' },
    );
    // Layer-3 defense: no double quote or backslash may reach the desktop channel.
    expect(calls[0]).not.toContain('"');
    expect(calls[0]).not.toContain('\\');
  });
});
