export interface MarkdownChunk {
  readonly headingPath: string;
  readonly content: string;
}

const MAX_CHUNK_CHARS = 2500;

/**
 * Chunk a markdown document by H1/H2/H3 boundaries. Each chunk carries the
 * heading path (e.g. "Setup local LLM > Path A — Ollama > Pull a model") so
 * the LLM has context about where the chunk lives.
 *
 * Chunks larger than MAX_CHUNK_CHARS are sub-split on paragraph boundaries.
 */
export function chunkMarkdown(markdown: string): readonly MarkdownChunk[] {
  const lines = markdown.split('\n');
  const headingPath: string[] = [];
  let buffer: string[] = [];
  const chunks: MarkdownChunk[] = [];

  function flush(): void {
    const content = buffer.join('\n').trim();
    if (content === '') {
      buffer = [];
      return;
    }
    const path = headingPath.join(' > ');
    if (content.length <= MAX_CHUNK_CHARS) {
      chunks.push({ headingPath: path, content });
    } else {
      for (const sub of subSplit(content)) {
        chunks.push({ headingPath: path, content: sub });
      }
    }
    buffer = [];
  }

  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m !== null) {
      flush();
      const depth = m[1]?.length ?? 1;
      const title = m[2] ?? '';
      headingPath.length = depth - 1;
      headingPath.push(title);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return chunks;
}

function subSplit(content: string): string[] {
  const paragraphs = content.split(/\n{2,}/);
  const out: string[] = [];
  let acc = '';
  for (const p of paragraphs) {
    if (p.length > MAX_CHUNK_CHARS) {
      // Single paragraph too big — hard-slice it into max-sized pieces.
      if (acc !== '') {
        out.push(acc);
        acc = '';
      }
      for (let i = 0; i < p.length; i += MAX_CHUNK_CHARS) {
        out.push(p.slice(i, i + MAX_CHUNK_CHARS));
      }
      continue;
    }
    if (acc.length + p.length + 2 > MAX_CHUNK_CHARS && acc !== '') {
      out.push(acc);
      acc = p;
    } else {
      acc = acc === '' ? p : `${acc}\n\n${p}`;
    }
  }
  if (acc !== '') out.push(acc);
  return out;
}

export async function hashContent(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
