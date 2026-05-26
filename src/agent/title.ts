import type { ModelClient } from '../models/types.ts';

const TITLE_SYSTEM = `You produce concise session titles for a DevOps assistant.
Given a single user prompt, return ONLY a 4-8 word title in Title Case that
captures the intent. No quotes, no trailing punctuation, no leading words like
"Title:". Output the title and nothing else.`;

const MAX_TITLE_CHARS = 80;

function cleanTitle(raw: string): string {
  let t = raw.trim();
  // Strip surrounding quotes
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  // Drop common LLM preambles
  t = t.replace(/^(Title|Session title|Topic)\s*[:\-—]\s*/i, '').trim();
  // Single-line only
  const newlineIdx = t.indexOf('\n');
  if (newlineIdx !== -1) t = t.slice(0, newlineIdx).trim();
  // Drop trailing period
  if (t.endsWith('.') || t.endsWith(';')) t = t.slice(0, -1).trim();
  if (t.length > MAX_TITLE_CHARS) t = t.slice(0, MAX_TITLE_CHARS - 1).trimEnd() + '…';
  return t;
}

export async function generateSessionTitle(
  userPrompt: string,
  client: ModelClient,
): Promise<string | null> {
  const trimmed = userPrompt.trim();
  if (trimmed === '') return null;
  try {
    const completion = await client.complete({
      messages: [
        { role: 'system', content: TITLE_SYSTEM },
        { role: 'user', content: trimmed.slice(0, 500) },
      ],
      temperature: 0.2,
      maxTokens: 32,
    });
    const cleaned = cleanTitle(completion.content);
    return cleaned === '' ? null : cleaned;
  } catch {
    return null;
  }
}
