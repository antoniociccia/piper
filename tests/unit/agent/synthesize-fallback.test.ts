import { describe, expect, test } from 'bun:test';

import { extractInlineProposals } from '../../../src/agent/synthesize.ts';

describe('agent/synthesize — inline proposals fallback', () => {
  test('returns empty when no JSON block at the end', () => {
    const md = `# Report\nServer is up [ev-1].\n\n## Next steps\n1. Do thing.`;
    const result = extractInlineProposals(md);
    expect(result.proposals).toEqual([]);
    expect(result.cleanedMarkdown).toBe(md);
  });

  test('parses a JSON array of {action, args} entries', () => {
    const md = `Report body [ev-1].

\`\`\`json
[
  { "action": "system.list_dir", "args": { "environment": "prod", "path": "/opt" } },
  { "action": "docker.ps", "args": { "environment": "prod" }, "rationale": "see what's running" }
]
\`\`\``;
    const result = extractInlineProposals(md);
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0]?.actionName).toBe('system.list_dir');
    expect(result.proposals[0]?.args).toEqual({ environment: 'prod', path: '/opt' });
    expect(result.proposals[1]?.actionName).toBe('docker.ps');
    expect(result.proposals[1]?.rationale).toBe("see what's running");
    expect(result.cleanedMarkdown).toBe('Report body [ev-1].');
  });

  test('accepts a fenced block without the json language tag', () => {
    const md = `body
\`\`\`
[{ "action": "system.uptime", "args": { "environment": "x" } }]
\`\`\``;
    const result = extractInlineProposals(md);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.actionName).toBe('system.uptime');
  });

  test('accepts {name, arguments} key shape as a synonym', () => {
    const md = `b
\`\`\`json
[{ "name": "system.memory", "arguments": { "environment": "x" } }]
\`\`\``;
    const result = extractInlineProposals(md);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.actionName).toBe('system.memory');
  });

  test('skips malformed entries (no action name)', () => {
    const md = `body
\`\`\`json
[
  { "rationale": "missing action" },
  { "action": "system.uptime", "args": {} }
]
\`\`\``;
    const result = extractInlineProposals(md);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.actionName).toBe('system.uptime');
  });

  test('returns empty on invalid JSON', () => {
    const md = `body
\`\`\`json
[not valid json]
\`\`\``;
    const result = extractInlineProposals(md);
    expect(result.proposals).toEqual([]);
    expect(result.cleanedMarkdown).toBe(md);
  });

  test('does not strip JSON blocks that are not at the end of the report', () => {
    const md = `\`\`\`json
[{ "action": "a", "args": {} }]
\`\`\`

middle text

something else`;
    const result = extractInlineProposals(md);
    // The trailing content is not JSON, so the block at the start should NOT be matched.
    expect(result.proposals).toEqual([]);
  });
});
