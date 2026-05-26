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
