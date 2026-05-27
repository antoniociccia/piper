import { describe, expect, test } from 'bun:test';

import { PLANNER_SYSTEM, PROPOSER_SYSTEM, SYNTHESIZER_SYSTEM } from '../../../src/agent/prompts.ts';

describe('synthesizer prompt — anti-mutation contract (Prime Directive)', () => {
  test('explicitly forbids announcing autonomous mutations in any language', () => {
    expect(SYNTHESIZER_SYSTEM).toContain('NEVER announce mutations');
    expect(SYNTHESIZER_SYSTEM).toMatch(/delete\s*\/\s*remove\s*\/\s*drop/i);
    expect(SYNTHESIZER_SYSTEM).toMatch(/clean\s*\/\s*purge\s*\/\s*clear\s*\/\s*prune/i);
    expect(SYNTHESIZER_SYSTEM).toContain('lancio una pulizia');
    expect(SYNTHESIZER_SYSTEM).toContain('ripulisco');
  });

  test('forbids first-person action announcements anywhere in the output', () => {
    expect(SYNTHESIZER_SYSTEM).toContain('FORBIDDEN ANYWHERE');
    expect(SYNTHESIZER_SYSTEM).toContain('controllo subito');
    expect(SYNTHESIZER_SYSTEM).toContain('procedo con');
  });

  test('does NOT instruct the synthesizer to take the next action itself', () => {
    expect(SYNTHESIZER_SYSTEM).not.toMatch(/say what YOU would check next/i);
    expect(SYNTHESIZER_SYSTEM).toContain('You are not running the next action');
    expect(SYNTHESIZER_SYSTEM).toMatch(/proposer step runs after you/i);
  });
});

describe('planner prompt — tier discipline', () => {
  test('destructive requires explicit user intent (not speculative)', () => {
    expect(PLANNER_SYSTEM).toMatch(/destructive-tier proposals unless the user EXPLICITLY asked/i);
    expect(PLANNER_SYSTEM).toMatch(/Destructive can never be\s+remembered/i);
  });

  test('mutations need clear user intent to change state', () => {
    expect(PLANNER_SYSTEM).toMatch(/Mutations \(tier: mutate\) require a clear user intent/i);
  });

  test('refuses secret reads at the planning layer', () => {
    expect(PLANNER_SYSTEM).toContain('No secret reads');
    expect(PLANNER_SYSTEM).toContain('~/.ssh/id_*');
    expect(PLANNER_SYSTEM).toContain('~/.aws/credentials');
    expect(PLANNER_SYSTEM).toContain('~/.kube/config');
  });
});

describe('proposer prompt — never proposes mutations', () => {
  test('only read-tier actions; mutate/destructive are out of scope for follow-ups', () => {
    expect(PROPOSER_SYSTEM).toMatch(/Read-tier actions only/i);
    expect(PROPOSER_SYSTEM).toMatch(/NEVER suggests a mutate\s+or destructive tool/i);
  });

  test('blocks credential exfiltration via action args', () => {
    expect(PROPOSER_SYSTEM).toMatch(/No exfiltration via args/i);
  });
});
