import type { CheckOutcome, WatchPlan } from '../monitor/types.ts';

import { buildWebhookPayload, postWebhook, type WebhookResult } from './webhook.ts';

export interface NotifyFailure {
  readonly channel: string;
  readonly message: string;
}

export interface NotifierDeps {
  /**
   * Sends a desktop notification on the local machine. The TUI wires this to
   * `executor.exec('notify.desktop', { title, message }, ctx)` — keeping the
   * process spawn inside the Executor where it is audited and allowlisted.
   * Undefined = desktop channel disabled.
   */
  readonly execDesktopNotification?: (title: string, message: string) => Promise<void>;
  readonly webhookUrls?: readonly string[];
  /** Injected for tests. Defaults to `postWebhook`. */
  readonly postWebhookFn?: (
    url: string,
    payload: ReturnType<typeof buildWebhookPayload>,
  ) => Promise<WebhookResult>;
  readonly userScrubPatterns?: readonly RegExp[];
}

export interface Notifier {
  /**
   * Dispatch an anomaly to every configured channel. Collects per-channel
   * failures and returns them — never throws. Callers should emit each failure
   * as a `notify-failed` WatchEvent so the TUI can surface it.
   */
  notifyAnomaly(plan: WatchPlan, outcome: CheckOutcome): Promise<readonly NotifyFailure[]>;
}

/**
 * Plan names, check names, and environment names originate from user-authored
 * YAML and are therefore untrusted. They flow into `notify.desktop`, whose
 * schema rejects double quotes and backslashes (AppleScript/notify-send
 * breakout chars). Strip those here so the produced title/message always pass
 * that schema even with hostile names — the notifier must never hand the
 * desktop channel a string the gate will reject.
 */
function safe(text: string): string {
  return text.replaceAll('"', "'").replaceAll('\\', '');
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const post = deps.postWebhookFn ?? ((url, payload) => postWebhook(url, payload));

  return {
    async notifyAnomaly(plan, outcome): Promise<readonly NotifyFailure[]> {
      const failures: NotifyFailure[] = [];

      // Desktop notification (local machine, always dispatched regardless of kind).
      if (deps.execDesktopNotification !== undefined) {
        try {
          await deps.execDesktopNotification(
            `PIPER Watch — ${safe(plan.name)}`,
            `Check '${safe(outcome.checkName)}' failed on ${safe(plan.environment)}`,
          );
        } catch (err) {
          failures.push({
            channel: 'desktop',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Webhooks — only dispatched for non-pass outcomes. The payload contains
      // metadata only; raw check output/detail never leaves the machine.
      if (outcome.kind !== 'pass') {
        for (const url of deps.webhookUrls ?? []) {
          const payload = buildWebhookPayload(
            {
              planName: plan.name,
              checkName: outcome.checkName,
              outcomeKind: outcome.kind,
              environment: plan.environment,
              atMs: outcome.executedAtMs,
            },
            deps.userScrubPatterns ?? [],
          );
          const result = await post(url, payload);
          if (!result.ok) {
            failures.push({ channel: `webhook(${url})`, message: result.message });
          }
        }
      }

      return failures;
    },
  };
}
