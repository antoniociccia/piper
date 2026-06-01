import { describe, expect, test } from 'bun:test';

import { buildDiagnosisPrompt, createWatchDiagnoser } from '../../../src/monitor/diagnose.ts';
import type { CheckOutcome, WatchPlan } from '../../../src/monitor/types.ts';
import type { AgentEvent } from '../../../src/agent/types.ts';

const PLAN: WatchPlan = {
  name: 'staging-health',
  description: 'staging',
  environment: 'staging',
  checks: [],
  runbook: 'The compose file lives in /opt/deploy. Check the db container first.',
  source: 'user',
};

const OUTCOME: CheckOutcome = {
  checkName: 'docker.ps',
  kind: 'expectation-failed',
  detail: 'not running: db (exited)',
  exitCode: 0,
  executedAtMs: 1_700_000_000_000,
};

// Fake events matching the REAL AgentEvent union from src/agent/types.ts.
// AgentResult.reportMarkdown is optional; done always fires (even after abort).
function fakeRunnerEvents(report: string): AgentEvent[] {
  return [
    { type: 'session-started', sessionId: 's' as import('../../../src/memory/types.ts').SessionId },
    {
      type: 'done',
      result: {
        userRequest: 'x',
        sessionId: 's' as import('../../../src/memory/types.ts').SessionId,
        evidence: [],
        failures: [],
        reportMarkdown: report,
        costUsd: 0.01,
        aborted: false,
      },
    },
  ];
}

describe('monitor/diagnose — buildDiagnosisPrompt', () => {
  test('prompt embeds the failed check, its detail, and the runbook', () => {
    const prompt = buildDiagnosisPrompt(PLAN, OUTCOME);
    expect(prompt).toContain('docker.ps');
    expect(prompt).toContain('not running: db (exited)');
    expect(prompt).toContain('/opt/deploy'); // runbook injected
    expect(prompt).toContain('staging');
    expect(prompt.toLowerCase()).toContain('diagnose'); // it asks for a diagnosis
  });

  test('prompt mentions that remediation proposals go through the approval flow', () => {
    const prompt = buildDiagnosisPrompt(PLAN, OUTCOME);
    expect(prompt.toLowerCase()).toContain('approval');
  });
});

describe('monitor/diagnose — createWatchDiagnoser', () => {
  test('runs the runner and returns the final report', async () => {
    const diagnoser = createWatchDiagnoser({
      runDiagnostic: () => {
        async function* gen(): AsyncIterable<AgentEvent> {
          for (const ev of fakeRunnerEvents('# Diagnosis\nThe db container exited.')) yield ev;
        }
        return gen();
      },
      isAffordable: () => true,
    });

    const result = await diagnoser(PLAN, OUTCOME);
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') expect(result.reportMarkdown).toContain('db container exited');
  });

  test('skips with budget reason when not affordable — runner is never invoked', async () => {
    let runnerCalled = false;
    const diagnoser = createWatchDiagnoser({
      runDiagnostic: () => {
        runnerCalled = true;
        throw new Error('must not be called when budget is exhausted');
      },
      isAffordable: () => false,
    });

    const result = await diagnoser(PLAN, OUTCOME);
    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') expect(result.reason).toBe('budget');
    expect(runnerCalled).toBe(false);
  });

  test('a runner that aborts yields a skipped result, never throws', async () => {
    const diagnoser = createWatchDiagnoser({
      runDiagnostic: () => {
        async function* gen(): AsyncIterable<AgentEvent> {
          yield {
            type: 'session-started',
            sessionId: 's' as import('../../../src/memory/types.ts').SessionId,
          };
          yield { type: 'aborted', reason: 'model unreachable' };
          // Runner always emits done after aborted, but here we stop early
          // to test the abort-only path.
        }
        return gen();
      },
      isAffordable: () => true,
    });

    const result = await diagnoser(PLAN, OUTCOME);
    expect(result.kind).toBe('skipped');
  });

  test('a runner whose stream throws yields a skipped result, never throws', async () => {
    const diagnoser = createWatchDiagnoser({
      runDiagnostic: () => {
        async function* gen(): AsyncIterable<AgentEvent> {
          yield {
            type: 'session-started',
            sessionId: 's' as import('../../../src/memory/types.ts').SessionId,
          };
          throw new Error('stream exploded');
        }
        return gen();
      },
      isAffordable: () => true,
    });

    const result = await diagnoser(PLAN, OUTCOME);
    expect(result.kind).toBe('skipped');
  });

  test('a runner that finishes without a report yields skipped', async () => {
    const diagnoser = createWatchDiagnoser({
      runDiagnostic: () => {
        async function* gen(): AsyncIterable<AgentEvent> {
          yield {
            type: 'session-started',
            sessionId: 's' as import('../../../src/memory/types.ts').SessionId,
          };
          // stream ends with no done event carrying a reportMarkdown
        }
        return gen();
      },
      isAffordable: () => true,
    });

    const result = await diagnoser(PLAN, OUTCOME);
    expect(result.kind).toBe('skipped');
  });
});
