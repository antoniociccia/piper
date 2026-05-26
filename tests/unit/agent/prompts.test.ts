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

describe('planner prompt — read-only contract (M1)', () => {
  test('explicitly forbids destructive actions and lists the verbs', () => {
    expect(PLANNER_SYSTEM).toContain('No destructive actions');
    expect(PLANNER_SYSTEM).toMatch(/deletes\s*\/\s*removes\s*\/\s*drops/i);
    expect(PLANNER_SYSTEM).toMatch(/shuts down\s*\/\s*stops\s*\/\s*kills/i);
  });

  test('refuses secret reads at the planning layer', () => {
    expect(PLANNER_SYSTEM).toContain('No secret reads');
    expect(PLANNER_SYSTEM).toContain('~/.ssh/id_*');
    expect(PLANNER_SYSTEM).toContain('~/.aws/credentials');
    expect(PLANNER_SYSTEM).toContain('~/.kube/config');
  });
});

describe('proposer prompt — read-only follow-ups only (M1)', () => {
  test('only proposes read-tier actions, never destructive', () => {
    expect(PROPOSER_SYSTEM).toMatch(/Read-tier actions only/i);
    expect(PROPOSER_SYSTEM).toMatch(/delete\s*\/\s*drop\s*\/\s*stop\s*\/\s*kill\s*\/\s*wipe/i);
  });

  test('blocks credential exfiltration via action args', () => {
    expect(PROPOSER_SYSTEM).toMatch(/No exfiltration via args/i);
  });
});
