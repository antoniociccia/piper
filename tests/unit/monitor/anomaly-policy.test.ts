// tests/unit/monitor/anomaly-policy.test.ts
import { describe, expect, test } from 'bun:test';

import { createAnomalyPolicy } from '../../../src/monitor/anomaly-policy.ts';
import type { CheckOutcome } from '../../../src/monitor/types.ts';

function outcome(checkName: string, kind: CheckOutcome['kind'], at: number): CheckOutcome {
  return { checkName, kind, detail: 'x', exitCode: kind === 'check-error' ? null : 0, executedAtMs: at };
}

const T0 = 1_700_000_000_000;

describe('monitor/anomaly-policy', () => {
  test('a single failure does not fire (debounce=2)', () => {
    let now = T0;
    const policy = createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, () => now);
    const decision = policy.observe(outcome('c', 'expectation-failed', now));
    expect(decision.kind).toBe('no-anomaly');
  });

  test('fires on the Nth consecutive failure', () => {
    let now = T0;
    const policy = createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, () => now);
    policy.observe(outcome('c', 'expectation-failed', now));
    now += 30_000;
    const decision = policy.observe(outcome('c', 'expectation-failed', now));
    expect(decision.kind).toBe('fire');
    if (decision.kind === 'fire') expect(decision.consecutiveFailures).toBe(2);
  });

  test('a pass resets the failure streak', () => {
    let now = T0;
    const policy = createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, () => now);
    policy.observe(outcome('c', 'expectation-failed', now));
    policy.observe(outcome('c', 'pass', now + 30_000));
    const decision = policy.observe(outcome('c', 'expectation-failed', now + 60_000));
    expect(decision.kind).toBe('no-anomaly'); // streak restarted at 1
  });

  test('streaks are tracked per check, independently', () => {
    let now = T0;
    const policy = createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, () => now);
    policy.observe(outcome('a', 'expectation-failed', now));
    const decisionB = policy.observe(outcome('b', 'expectation-failed', now));
    expect(decisionB.kind).toBe('no-anomaly'); // b's streak is 1, a's failure doesn't count
  });

  test('after firing, the same check is suppressed by cooldown', () => {
    let now = T0;
    const policy = createAnomalyPolicy({ debounceFailures: 1, cooldownMs: 900_000 }, () => now);
    expect(policy.observe(outcome('c', 'expectation-failed', now)).kind).toBe('fire');
    now += 60_000; // 1 min later, still inside 15 min cooldown
    expect(policy.observe(outcome('c', 'expectation-failed', now)).kind).toBe('suppressed-cooldown');
  });

  test('after the cooldown expires, the check can fire again', () => {
    let now = T0;
    const policy = createAnomalyPolicy({ debounceFailures: 1, cooldownMs: 900_000 }, () => now);
    expect(policy.observe(outcome('c', 'expectation-failed', now)).kind).toBe('fire');
    now += 900_001;
    expect(policy.observe(outcome('c', 'expectation-failed', now)).kind).toBe('fire');
  });

  test('check-error failures count toward the same streak as expectation failures', () => {
    let now = T0;
    const policy = createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, () => now);
    policy.observe(outcome('c', 'check-error', now));
    const decision = policy.observe(outcome('c', 'expectation-failed', now + 30_000));
    expect(decision.kind).toBe('fire');
  });

  test('a pass resets the streak but does not reset the cooldown anchor', () => {
    let now = T0;
    const policy = createAnomalyPolicy({ debounceFailures: 1, cooldownMs: 900_000 }, () => now);
    // fire
    expect(policy.observe(outcome('c', 'expectation-failed', now)).kind).toBe('fire');
    // recover
    now += 30_000;
    policy.observe(outcome('c', 'pass', now));
    // fail again inside the cooldown window → still suppressed (anchor was not reset by the pass)
    now += 30_000;
    expect(policy.observe(outcome('c', 'expectation-failed', now)).kind).toBe('suppressed-cooldown');
    // after the window expires (measured from the original fire) → fires again
    now = T0 + 900_001;
    expect(policy.observe(outcome('c', 'expectation-failed', now)).kind).toBe('fire');
  });

  test('continuous failures: fires again right after cooldown expires without needing a fresh debounce', () => {
    let now = T0;
    const policy = createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, () => now);
    policy.observe(outcome('c', 'expectation-failed', now));
    now += 30_000;
    expect(policy.observe(outcome('c', 'expectation-failed', now)).kind).toBe('fire');
    now += 30_000;
    expect(policy.observe(outcome('c', 'expectation-failed', now)).kind).toBe('suppressed-cooldown');
    now += 900_001; // past cooldown
    expect(policy.observe(outcome('c', 'expectation-failed', now)).kind).toBe('fire');
  });
});
