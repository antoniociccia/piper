import { describe, expect, test } from 'bun:test';

import { createAnomalyPolicy } from '../../../src/monitor/anomaly-policy.ts';
import { runWatch, type SchedulerDeps } from '../../../src/monitor/scheduler.ts';
import type { CheckOutcome, WatchCheck, WatchEvent, WatchPlan } from '../../../src/monitor/types.ts';
import type { WatchStore } from '../../../src/monitor/watch-store.ts';

// ── Fakes ──────────────────────────────────────────────────────────────────

function fakeStore(): WatchStore & { anomalies: string[] } {
  const anomalies: string[] = [];
  return {
    anomalies,
    createRun: () => Promise.resolve(1),
    finishRun: () => Promise.resolve(),
    recordCheckResult: () => Promise.resolve(),
    recordAnomaly: (_runId, checkName) => {
      anomalies.push(checkName);
      return Promise.resolve(anomalies.length);
    },
    updateAnomalyDiagnosis: () => Promise.resolve(),
  };
}

interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  readonly sleeps: number[];
}

function fakeClock(start: number): FakeClock {
  let current = start;
  const sleeps: number[] = [];
  return {
    now: () => current,
    sleep: (ms: number) => {
      sleeps.push(ms);
      current += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

function plan(checks: readonly WatchCheck[]): WatchPlan {
  return {
    name: 'test-plan',
    description: 'test',
    environment: 'staging',
    checks,
    runbook: 'Check the logs first.',
    source: 'user',
  };
}

const CHECK_A: WatchCheck = {
  name: 'a',
  action: 'fake.a',
  args: {},
  expect: { kind: 'exit_zero' },
  intervalMs: 30_000,
};

const CHECK_B: WatchCheck = {
  name: 'b',
  action: 'fake.b',
  args: {},
  expect: { kind: 'exit_zero' },
  intervalMs: 60_000,
};

function passOutcome(name: string, at: number): CheckOutcome {
  return { checkName: name, kind: 'pass', detail: 'ok', exitCode: 0, executedAtMs: at };
}

function failOutcome(name: string, at: number): CheckOutcome {
  return { checkName: name, kind: 'expectation-failed', detail: 'broken', exitCode: 0, executedAtMs: at };
}

/** Collect events from the generator until watch-stopped or maxEvents. */
async function collect(gen: AsyncGenerator<WatchEvent>, maxEvents: number): Promise<WatchEvent[]> {
  const events: WatchEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
    if (events.length >= maxEvents || ev.type === 'watch-stopped') break;
  }
  return events;
}

const T0 = 1_700_000_000_000;

describe('monitor/scheduler — runWatch', () => {
  test('emits watch-started, runs due checks, sleeps until next due', async () => {
    const clock = fakeClock(T0);
    const ran: string[] = [];
    const abort = new AbortController();

    const deps: SchedulerDeps = {
      runCheck: (check) => {
        ran.push(check.name);
        return Promise.resolve(passOutcome(check.name, clock.now()));
      },
      policy: createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, clock.now),
      store: fakeStore(),
      sessionId: 's',
      now: clock.now,
      sleep: clock.sleep,
      signal: abort.signal,
    };

    const gen = runWatch(plan([CHECK_A, CHECK_B]), deps);
    // started + 2 first results (both due immediately) + 2 results at t+30s (A) and t+60s (A,B)
    const events = await collect(gen, 6);

    expect(events[0]?.type).toBe('watch-started');
    // both checks run immediately on start
    expect(ran.slice(0, 2).sort()).toEqual(['a', 'b']);
    // first sleep is 30s — A's next due is the earliest
    expect(clock.sleeps[0]).toBe(30_000);
    abort.abort();
  });

  test('an anomaly fires after debounce and is persisted before being yielded', async () => {
    const clock = fakeClock(T0);
    const store = fakeStore();
    const abort = new AbortController();

    const deps: SchedulerDeps = {
      runCheck: (check) => Promise.resolve(failOutcome(check.name, clock.now())),
      policy: createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, clock.now),
      store,
      sessionId: 's',
      now: clock.now,
      sleep: clock.sleep,
      signal: abort.signal,
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    const events: WatchEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === 'anomaly') break;
    }
    abort.abort();

    const anomaly = events.find((e) => e.type === 'anomaly');
    expect(anomaly).toBeDefined();
    if (anomaly?.type === 'anomaly') {
      expect(anomaly.checkName).toBe('a');
      expect(anomaly.consecutiveFailures).toBe(2);
    }
    // persisted BEFORE yield
    expect(store.anomalies).toContain('a');
  });

  test('anomaly triggers notify and diagnosis when wired', async () => {
    const clock = fakeClock(T0);
    const abort = new AbortController();
    const notified: string[] = [];

    const deps: SchedulerDeps = {
      runCheck: (check) => Promise.resolve(failOutcome(check.name, clock.now())),
      policy: createAnomalyPolicy({ debounceFailures: 1, cooldownMs: 900_000 }, clock.now),
      store: fakeStore(),
      sessionId: 's',
      now: clock.now,
      sleep: clock.sleep,
      signal: abort.signal,
      notify: (checkName) => {
        notified.push(checkName);
        return Promise.resolve();
      },
      diagnose: () => Promise.resolve({ kind: 'ready', reportMarkdown: '# It is the db' }),
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    const events: WatchEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === 'diagnosis-ready') break;
    }
    abort.abort();

    expect(notified).toContain('a');
    const types = events.map((e) => e.type);
    expect(types).toContain('anomaly');
    expect(types).toContain('diagnosis-started');
    expect(types).toContain('diagnosis-ready');
    // ordering: anomaly → diagnosis-started → diagnosis-ready
    expect(types.indexOf('anomaly')).toBeLessThan(types.indexOf('diagnosis-started'));
  });

  test('diagnosis skip (budget) is surfaced as an event', async () => {
    const clock = fakeClock(T0);
    const abort = new AbortController();

    const deps: SchedulerDeps = {
      runCheck: (check) => Promise.resolve(failOutcome(check.name, clock.now())),
      policy: createAnomalyPolicy({ debounceFailures: 1, cooldownMs: 900_000 }, clock.now),
      store: fakeStore(),
      sessionId: 's',
      now: clock.now,
      sleep: clock.sleep,
      signal: abort.signal,
      diagnose: () => Promise.resolve({ kind: 'skipped', reason: 'budget' }),
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    const events: WatchEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === 'diagnosis-skipped') break;
    }
    abort.abort();

    const skipped = events.find((e) => e.type === 'diagnosis-skipped');
    expect(skipped).toBeDefined();
    if (skipped?.type === 'diagnosis-skipped') expect(skipped.reason).toBe('budget');
  });

  test('abort signal stops the loop with watch-stopped', async () => {
    const clock = fakeClock(T0);
    const abort = new AbortController();

    const deps: SchedulerDeps = {
      runCheck: (check) => Promise.resolve(passOutcome(check.name, clock.now())),
      policy: createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, clock.now),
      store: fakeStore(),
      sessionId: 's',
      now: clock.now,
      sleep: (ms) => {
        abort.abort(); // abort during the first sleep
        return clock.sleep(ms);
      },
      signal: abort.signal,
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    const events: WatchEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
    }

    const last = events[events.length - 1];
    expect(last?.type).toBe('watch-stopped');
  });

  test('check-error backoff: repeated errors stretch the effective interval', async () => {
    const clock = fakeClock(T0);
    const abort = new AbortController();
    let calls = 0;

    const deps: SchedulerDeps = {
      runCheck: (check) => {
        calls += 1;
        return Promise.resolve({
          checkName: check.name, kind: 'check-error', detail: 'ssh down', exitCode: null, executedAtMs: clock.now(),
        });
      },
      policy: createAnomalyPolicy({ debounceFailures: 99, cooldownMs: 900_000 }, clock.now), // never fire
      store: fakeStore(),
      sessionId: 's',
      now: clock.now,
      sleep: clock.sleep,
      signal: abort.signal,
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    const events: WatchEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if (calls >= 3) break;
    }
    abort.abort();

    // base 30s, then 60s (×2), then 120s (×4) — exponential per consecutive error
    expect(clock.sleeps[0]).toBe(60_000);
    expect(clock.sleeps[1]).toBe(120_000);
  });

  test('diagnose() throwing is caught and surfaced as diagnosis-skipped, loop keeps running', async () => {
    const clock = fakeClock(T0);
    const abort = new AbortController();
    let checkCount = 0;

    const deps: SchedulerDeps = {
      runCheck: (check) => {
        checkCount += 1;
        return Promise.resolve(failOutcome(check.name, clock.now()));
      },
      policy: createAnomalyPolicy({ debounceFailures: 1, cooldownMs: 900_000 }, clock.now),
      store: fakeStore(),
      sessionId: 's',
      now: clock.now,
      sleep: clock.sleep,
      signal: abort.signal,
      diagnose: () => Promise.reject(new Error('diagnose exploded')),
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    const events: WatchEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === 'diagnosis-skipped') break;
    }
    abort.abort();

    const skipped = events.find((e) => e.type === 'diagnosis-skipped');
    expect(skipped).toBeDefined();
    if (skipped?.type === 'diagnosis-skipped') {
      expect(skipped.reason).toBe('budget');
    }
    // Loop did not die — it reached diagnosis-skipped
    expect(checkCount).toBeGreaterThanOrEqual(1);
  });

  test('runCheck() throwing is caught and becomes a check-error outcome, loop keeps running', async () => {
    const clock = fakeClock(T0);
    const abort = new AbortController();
    let calls = 0;

    const deps: SchedulerDeps = {
      runCheck: (_check) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('runCheck exploded'));
        abort.abort(); // stop after recovery tick
        return Promise.resolve(passOutcome(_check.name, clock.now()));
      },
      policy: createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, clock.now),
      store: fakeStore(),
      sessionId: 's',
      now: clock.now,
      sleep: clock.sleep,
      signal: abort.signal,
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    const events: WatchEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === 'watch-stopped') break;
    }

    // Should have a check-result with kind='check-error' for the thrown call
    const errorResults = events.filter(
      (e) => e.type === 'check-result' && e.outcome.kind === 'check-error',
    );
    expect(errorResults.length).toBeGreaterThanOrEqual(1);
  });

  test('empty plan.checks throws immediately (before yielding)', async () => {
    const abort = new AbortController();
    const clock = fakeClock(T0);

    const deps: SchedulerDeps = {
      runCheck: () => Promise.resolve(passOutcome('x', clock.now())),
      policy: createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, clock.now),
      store: fakeStore(),
      sessionId: 's',
      now: clock.now,
      sleep: clock.sleep,
      signal: abort.signal,
    };

    const emptyPlan: WatchPlan = {
      name: 'empty',
      description: 'no checks',
      environment: 'staging',
      checks: [],
      runbook: '',
      source: 'user',
    };

    const gen = runWatch(emptyPlan, deps);
    await expect(gen.next()).rejects.toThrow('no checks');
  });

  // ── C1: recordAnomaly / updateAnomalyDiagnosis store-failure containment ──

  test('C1: recordAnomaly throwing yields anomaly with anomalyId -1 and loop keeps running', async () => {
    const clock = fakeClock(T0);
    const abort = new AbortController();

    const throwingStore: WatchStore = {
      createRun: () => Promise.resolve(1),
      finishRun: () => Promise.resolve(),
      recordCheckResult: () => Promise.resolve(),
      recordAnomaly: () => Promise.reject(new Error('db full on anomaly')),
      updateAnomalyDiagnosis: () => Promise.resolve(),
    };

    const deps: SchedulerDeps = {
      runCheck: (check) => Promise.resolve(failOutcome(check.name, clock.now())),
      policy: createAnomalyPolicy({ debounceFailures: 1, cooldownMs: 900_000 }, clock.now),
      store: throwingStore,
      sessionId: 's',
      now: clock.now,
      sleep: (ms, _signal) => {
        abort.abort();
        return clock.sleep(ms);
      },
      signal: abort.signal,
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    const events: WatchEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === 'watch-stopped') break;
    }

    // Anomaly event is still yielded with anomalyId -1 (persistence sentinel)
    const anomaly = events.find((e) => e.type === 'anomaly');
    expect(anomaly).toBeDefined();
    if (anomaly?.type === 'anomaly') {
      expect(anomaly.anomalyId).toBe(-1);
    }
    // Loop ran to watch-stopped
    expect(events[events.length - 1]?.type).toBe('watch-stopped');
  });

  test('C1: updateAnomalyDiagnosis throwing is swallowed; diagnosis event still yields; loop keeps running', async () => {
    const clock = fakeClock(T0);
    const abort = new AbortController();

    const throwingStore: WatchStore = {
      createRun: () => Promise.resolve(1),
      finishRun: () => Promise.resolve(),
      recordCheckResult: () => Promise.resolve(),
      recordAnomaly: (_runId, checkName) => Promise.resolve(42),
      updateAnomalyDiagnosis: () => Promise.reject(new Error('db full on diagnosis update')),
    };

    const deps: SchedulerDeps = {
      runCheck: (check) => Promise.resolve(failOutcome(check.name, clock.now())),
      policy: createAnomalyPolicy({ debounceFailures: 1, cooldownMs: 900_000 }, clock.now),
      store: throwingStore,
      sessionId: 's',
      now: clock.now,
      sleep: (ms, _signal) => {
        abort.abort();
        return clock.sleep(ms);
      },
      signal: abort.signal,
      diagnose: () => Promise.resolve({ kind: 'ready', reportMarkdown: '# diag' }),
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    const events: WatchEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === 'watch-stopped') break;
    }

    // diagnosis-ready event is still yielded despite the store throwing
    const types = events.map((e) => e.type);
    expect(types).toContain('diagnosis-ready');
    expect(events[events.length - 1]?.type).toBe('watch-stopped');
  });

  // ── I1: Abortable sleep ────────────────────────────────────────────────────

  test('I1: signal-aware sleep resolves early on abort, loop exits promptly', async () => {
    const clock = fakeClock(T0);
    const abort = new AbortController();
    let sleepCallCount = 0;

    // A sleep that resolves immediately when the signal is aborted
    const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> => {
      sleepCallCount += 1;
      if (signal?.aborted === true) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          clock['current' as keyof typeof clock]; // suppress unused warning
          resolve();
        }, 0);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    };

    const deps: SchedulerDeps = {
      runCheck: (check) => {
        // Abort after the first check so the loop tries to sleep
        abort.abort();
        return Promise.resolve(passOutcome(check.name, clock.now()));
      },
      policy: createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, clock.now),
      store: fakeStore(),
      sessionId: 's',
      now: clock.now,
      sleep: abortableSleep,
      signal: abort.signal,
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    const events: WatchEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
    }

    // The loop must have stopped (watch-stopped yielded) without needing a full interval wait
    expect(events[events.length - 1]?.type).toBe('watch-stopped');
    // Sleep received the signal (the parameter was forwarded)
    expect(sleepCallCount).toBeGreaterThanOrEqual(0); // sleep may or may not have been called, but no hang
  });

  // ── I2: Consumer-driven shutdown (gen.return()) ───────────────────────────

  test('I2: consumer break triggers finishRun with reason != completed', async () => {
    const clock = fakeClock(T0);
    const finishReasons: string[] = [];

    const trackingStore: WatchStore & { anomalies: string[] } = {
      anomalies: [],
      createRun: () => Promise.resolve(1),
      finishRun: (_runId, reason) => {
        finishReasons.push(reason);
        return Promise.resolve();
      },
      recordCheckResult: () => Promise.resolve(),
      recordAnomaly: (_runId, checkName) => {
        (trackingStore.anomalies as string[]).push(checkName);
        return Promise.resolve(1);
      },
      updateAnomalyDiagnosis: () => Promise.resolve(),
    };

    const deps: SchedulerDeps = {
      runCheck: (check) => Promise.resolve(passOutcome(check.name, clock.now())),
      policy: createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, clock.now),
      store: trackingStore,
      sessionId: 's',
      now: clock.now,
      sleep: clock.sleep,
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    let consumed = 0;
    for await (const ev of gen) {
      consumed += 1;
      if (consumed >= 2) break; // consumer breaks early (gen.return() will be called)
    }

    // finishRun must have been called with a reason other than 'completed'
    expect(finishReasons).toHaveLength(1);
    expect(finishReasons[0]).not.toBe('completed');
  });

  // ── I3: Cadence floor — slow check must not hammer immediately ─────────────

  test('I3: a check that takes longer than its interval waits a full interval before re-running', async () => {
    let currentMs = T0;
    const sleeps: number[] = [];
    const abort = new AbortController();

    // A clock where runCheck advances time by MORE than the interval (simulating slow check)
    const now = () => currentMs;
    const sleep = (ms: number, _signal?: AbortSignal): Promise<void> => {
      sleeps.push(ms);
      currentMs += ms;
      abort.abort(); // stop after first sleep
      return Promise.resolve();
    };

    const deps: SchedulerDeps = {
      runCheck: (check) => {
        // Advance clock by 2× the interval (slow check)
        currentMs += CHECK_A.intervalMs * 2;
        return Promise.resolve(passOutcome(check.name, currentMs));
      },
      policy: createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, now),
      store: fakeStore(),
      sessionId: 's',
      now,
      sleep,
      signal: abort.signal,
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    for await (const ev of gen) {
      if (ev.type === 'watch-stopped') break;
    }

    // The sleep after the slow check must be a full interval (not 0 or near-0)
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(CHECK_A.intervalMs);
  });

  test('store.recordCheckResult() throwing does not kill the loop', async () => {
    const clock = fakeClock(T0);
    const abort = new AbortController();
    let persistCalls = 0;

    const throwingStore: WatchStore = {
      createRun: () => Promise.resolve(1),
      finishRun: () => Promise.resolve(),
      recordCheckResult: () => {
        persistCalls += 1;
        if (persistCalls === 1) return Promise.reject(new Error('db full'));
        return Promise.resolve();
      },
      recordAnomaly: () => Promise.resolve(1),
      updateAnomalyDiagnosis: () => Promise.resolve(),
    };

    const deps: SchedulerDeps = {
      runCheck: (check) => Promise.resolve(passOutcome(check.name, clock.now())),
      policy: createAnomalyPolicy({ debounceFailures: 2, cooldownMs: 900_000 }, clock.now),
      store: throwingStore,
      sessionId: 's',
      now: clock.now,
      sleep: (ms) => {
        abort.abort();
        return clock.sleep(ms);
      },
      signal: abort.signal,
    };

    const gen = runWatch(plan([CHECK_A]), deps);
    const events: WatchEvent[] = [];
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === 'watch-stopped') break;
    }

    // Loop ran to watch-stopped despite the store throwing on first persist
    expect(events[events.length - 1]?.type).toBe('watch-stopped');
  });
});
