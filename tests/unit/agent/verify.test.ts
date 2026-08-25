import { describe, expect, test } from 'bun:test';

import { verifyReport } from '../../../src/agent/verify.ts';
import type { EvidenceRef } from '../../../src/agent/types.ts';

const ev1: EvidenceRef = {
  id: 'ev-1',
  auditId: 1,
  evidenceId: 1,
  actionName: 'system.uptime',
  args: { environment: 'staging' },
  stdout: '12:34 up 1 day',
  stderr: '',
  exitCode: 0,
  durationMs: 200,
};

const ev2: EvidenceRef = {
  id: 'ev-2',
  auditId: 2,
  evidenceId: 2,
  actionName: 'logs.tail',
  args: { environment: 'staging', path: '/var/log/app.log' },
  stdout: 'ERROR connection refused',
  stderr: '',
  exitCode: 0,
  durationMs: 350,
};

describe('agent/verify', () => {
  test('passes when every substantive line cites a known evidence id', () => {
    const md = `
# Report
The staging server has been up 1 day with low load [ev-1].
The application log shows a connection refused error [ev-2].
`;
    const result = verifyReport({ markdown: md, evidence: [ev1, ev2] });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  test('fails when a citation refers to an unknown ev-N', () => {
    const md = `The staging server appears healthy [ev-99].`;
    const result = verifyReport({ markdown: md, evidence: [ev1] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('ev-99'))).toBe(true);
  });

  test('fails when a substantive line has no citation', () => {
    const md = `The staging server is down right now.\nDatabase connections are failing repeatedly.`;
    const result = verifyReport({ markdown: md, evidence: [ev1, ev2] });
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test('headings, table rows, and short lines do not require citations', () => {
    const md = `
# Status
## Summary
- item
| col | col |
The server has been up for over a day [ev-1].
`;
    const result = verifyReport({ markdown: md, evidence: [ev1] });
    expect(result.ok).toBe(true);
  });

  test('ignores citations inside code fences', () => {
    const md = `
The staging server is up [ev-1].
\`\`\`
example output [ev-999] inside a code block
\`\`\`
`;
    const result = verifyReport({ markdown: md, evidence: [ev1] });
    expect(result.ok).toBe(true);
  });

  test('fails when evidence exists but the report cites none', () => {
    const md = `Just some prose, no citations at all anywhere.`;
    const result = verifyReport({ markdown: md, evidence: [ev1] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('cites no evidence'))).toBe(true);
  });

  test('requireCitationsOnSubstantiveLines=false relaxes per-line check', () => {
    const md = `The server is up [ev-1].\nNo citation here but it is substantive.`;
    const result = verifyReport({
      markdown: md,
      evidence: [ev1],
      requireCitationsOnSubstantiveLines: false,
    });
    expect(result.ok).toBe(true);
  });

  test('lines under "## Next steps" do not require citations', () => {
    const md = `
The server has been up for over a day [ev-1].
## Next steps
1. Run \`ls -la /opt\` to inventory the directory contents.
2. Check whether docker services are healthy on this host.
`;
    const result = verifyReport({ markdown: md, evidence: [ev1] });
    expect(result.ok).toBe(true);
  });

  test('lines under "## Gaps" do not require citations', () => {
    const md = `
The server has been up for over a day [ev-1].
## Gaps
- No directory listing was collected for /opt, so additional contents are unknown.
- Disk usage on /var was not measured.
`;
    const result = verifyReport({ markdown: md, evidence: [ev1] });
    expect(result.ok).toBe(true);
  });

  test('passes when a substantive line has a compound citation [ev-1, ev-2]', () => {
    const md = `The server has been up for over a day and runs cleanly [ev-1, ev-2].`;
    const result = verifyReport({ markdown: md, evidence: [ev1, ev2] });
    expect(result.ok).toBe(true);
  });

  test('passes with semicolon-separated citations [ev-1; ev-2]', () => {
    const md = `The server has been up for over a day and runs cleanly [ev-1; ev-2].`;
    const result = verifyReport({ markdown: md, evidence: [ev1, ev2] });
    expect(result.ok).toBe(true);
  });

  test('passes with natural-language joins [ev-1 and ev-2]', () => {
    const md = `The server has been up for over a day and runs cleanly [ev-1 and ev-2].`;
    const result = verifyReport({ markdown: md, evidence: [ev1, ev2] });
    expect(result.ok).toBe(true);
  });

  test('catches an unknown id even inside a compound bracket', () => {
    const md = `The server has been up for over a day and runs cleanly [ev-1, ev-99].`;
    const result = verifyReport({ markdown: md, evidence: [ev1] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('ev-99'))).toBe(true);
  });

  test('citation requirement resumes after exempt section ends', () => {
    const md = `
The server has been up for over a day [ev-1].
## Next steps
Run a more thorough inventory of the host.
## Findings
The application log shows repeated connection failures.
`;
    const result = verifyReport({ markdown: md, evidence: [ev1, ev2] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('application log shows'))).toBe(true);
  });
});

/**
 * The synthesizer prompt does not merely permit a hypothesis line — it demands
 * one: "Diagnose, don't dictate. If the evidence points to something worth
 * digging into, FLAG it — name the symptom and a one-line hypothesis." Its own
 * worked example carries no citation, because a hypothesis is an inference
 * ABOUT the evidence, not an observation that any single evidence row states.
 *
 * The verifier was counting those lines as uncited claims, so a report could be
 * rejected precisely for obeying its instructions. Observed with qwen3.5:9b on
 * a report whose every observational claim was cited: 2 of 3 substantive lines
 * carried a citation, 0.67 fell under the 0.75 threshold, and the whole report
 * was thrown away over the one line the prompt had asked for.
 */
describe('verifyReport — flagged hypotheses', () => {
  const ev1: EvidenceRef = {
    id: 'ev-1',
    auditId: 1 as EvidenceRef['auditId'],
    actionName: 'docker.ps',
    args: {},
    summary: 'containers',
  };

  test('a "Worth a look" hypothesis does not need its own citation', () => {
    const md = `
orderly-redis-1 exited with code 137 and the worker exited with code 1 [ev-1].
Worth a look: the OOM kill suggests the memory limit is too high for this host.
`;
    expect(verifyReport({ markdown: md, evidence: [ev1] }).ok).toBe(true);
  });

  test('the Italian form is exempt too', () => {
    const md = `
orderly-redis-1 exited with code 137 and the worker exited with code 1 [ev-1].
Da guardare: il kill per OOM fa pensare a un limite di memoria troppo alto.
`;
    expect(verifyReport({ markdown: md, evidence: [ev1] }).ok).toBe(true);
  });

  test('a bold-markdown hypothesis label is recognised', () => {
    const md = `
orderly-redis-1 exited with code 137 and the worker exited with code 1 [ev-1].
**Worth a look:** the OOM kill suggests the memory limit is too high here.
`;
    expect(verifyReport({ markdown: md, evidence: [ev1] }).ok).toBe(true);
  });

  test('an uncited observational claim is still rejected', () => {
    // The exemption must not become a way to smuggle facts past the gate.
    const md = `
orderly-redis-1 exited with code 137 and the worker exited with code 1 [ev-1].
The nginx access log records 4,812 requests from a single address overnight.
The root filesystem is at 94% and the backup volume is completely full.
`;
    const result = verifyReport({ markdown: md, evidence: [ev1] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('nginx access log'))).toBe(true);
  });
});
