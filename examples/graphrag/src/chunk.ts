/** A piece of a document, small enough to embed and to quote in a prompt. */
export interface TextChunk {
  /** 0-based order of the chunk in its document. */
  position: number;
  /** The closest Markdown heading above the chunk (`##` and below), if any. */
  heading: string | null;
  text: string;
}

export interface ChunkOptions {
  /** Longest chunk, in characters (default 800). Paragraphs are merged up to this size. */
  maxChars?: number;
}

/** The first `# Title` line of a Markdown document, or `null`. */
export function markdownTitle(markdown: string): string | null {
  const m = /^#\s+(.+)$/m.exec(markdown);
  return m ? m[1]!.trim() : null;
}

/**
 * Split Markdown into chunks by paragraph. Consecutive paragraphs under the same heading are merged
 * while they fit in `maxChars`; a paragraph longer than `maxChars` is split between sentences.
 * A chunk never spans two headings, so each chunk is about one thing.
 */
export function chunkMarkdown(
  markdown: string,
  { maxChars = 800 }: ChunkOptions = {},
): TextChunk[] {
  const chunks: TextChunk[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    chunks.push({ position: chunks.length, heading, text: buffer.join("\n\n") });
    buffer = [];
  };

  for (const block of markdown.split(/\n\s*\n/)) {
    const text = block.trim().replace(/\s*\n\s*/g, " ");
    if (!text) continue;
    const h = /^(#{1,6})\s+(.+)$/.exec(text);
    if (h) {
      flush();
      // `# Title` is the document title, not a section heading.
      heading = h[1] === "#" ? null : h[2]!.trim();
      continue;
    }
    for (const piece of splitLong(text, maxChars)) {
      const size = buffer.reduce((n, p) => n + p.length + 2, 0);
      if (buffer.length > 0 && size + piece.length > maxChars) flush();
      buffer.push(piece);
    }
  }
  flush();
  return chunks;
}

/** Split a paragraph between sentences so that each piece fits in `maxChars` when possible. */
function splitLong(paragraph: string, maxChars: number): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const sentences = paragraph.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [paragraph];
  const pieces: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (current && current.length + 1 + sentence.length > maxChars) {
      pieces.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
