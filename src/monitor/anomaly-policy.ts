// src/monitor/anomaly-policy.ts
import type { CheckOutcome } from './types.ts';

export interface AnomalyPolicyConfig {
  /** Consecutive failures of the same check before an anomaly fires. */
  readonly debounceFailures: number;
  /** After an anomaly fires for a check, suppress further anomalies for this long. */
  readonly cooldownMs: number;
}

export const DEFAULT_POLICY_CONFIG: AnomalyPolicyConfig = {
  debounceFailures: 2,
  cooldownMs: 15 * 60_000,
};

export type PolicyDecision =
  | { readonly kind: 'no-anomaly' }
  | { readonly kind: 'fire'; readonly consecutiveFailures: number }
  | { readonly kind: 'suppressed-cooldown' };

export interface AnomalyPolicy {
  observe(outcome: CheckOutcome): PolicyDecision;
}

interface CheckState {
  consecutiveFailures: number;
  lastFiredAtMs: number | null;
}

export function createAnomalyPolicy(config: AnomalyPolicyConfig, now: () => number): AnomalyPolicy {
  // Entries are bounded by the plan's check count. Policy lifetime must equal
  // one watch run's lifetime — do not reuse a policy instance across plan reloads.
  const states = new Map<string, CheckState>();

  function stateFor(checkName: string): CheckState {
    let state = states.get(checkName);
    if (state === undefined) {
      state = { consecutiveFailures: 0, lastFiredAtMs: null };
      states.set(checkName, state);
    }
    return state;
  }

  return {
    observe(outcome) {
      const state = stateFor(outcome.checkName);

      if (outcome.kind === 'pass') {
        state.consecutiveFailures = 0;
        return { kind: 'no-anomaly' };
      }

      // Both 'expectation-failed' and 'check-error' count as failures.
      state.consecutiveFailures += 1;
      if (state.consecutiveFailures < config.debounceFailures) {
        return { kind: 'no-anomaly' };
      }

      // Debounce threshold reached — check cooldown before firing.
      const currentMs = now();
      // Inclusive boundary: at exactly cooldownMs elapsed the anomaly is still
      // suppressed; re-fire requires elapsed > cooldownMs.
      if (state.lastFiredAtMs !== null && currentMs - state.lastFiredAtMs <= config.cooldownMs) {
        return { kind: 'suppressed-cooldown' };
      }

      // lastFiredAtMs is anchored to the last actual fire — suppressed observations
      // do NOT refresh it, so an alert storm cannot stretch its own cooldown.
      state.lastFiredAtMs = currentMs;
      return { kind: 'fire', consecutiveFailures: state.consecutiveFailures };
    },
  };
}
