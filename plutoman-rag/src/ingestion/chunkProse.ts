/**
 * Prose chunking with overlap — quotation §5.1:
 *
 *   "documents are segmented into semantically coherent units sized for
 *    retrieval, with overlap tuned to avoid splitting related instructions
 *    across chunk boundaries."
 *
 * The Phase-1 chunker (`chunk.ts`) is ROW-ATOMIC: one chunk per checklist row.
 * That is exactly right for a rigid inspection workbook, where each row is
 * already a self-contained question/answer, and exactly wrong for free-form
 * prose, where meaning runs across sentences and paragraphs.
 *
 * STRATEGY — split on the largest natural boundary that fits, never mid-word:
 *   1. Prefer paragraph breaks (a blank line).
 *   2. If one paragraph alone exceeds the budget, fall back to sentence
 *      boundaries within it.
 *   3. If a single "sentence" still exceeds the budget (tables, long CSV rows,
 *      run-on extracted PDF text), hard-split on a word boundary as a last
 *      resort so nothing is ever dropped.
 *
 * OVERLAP — each chunk repeats the tail of its predecessor. This is what stops
 * "…isolate the feeder. | Then verify with an approved detector." from becoming
 * two chunks where neither answers "how do I verify isolation?". Overlap is
 * applied on a sentence boundary too, so the repeated text reads naturally
 * rather than starting mid-clause.
 *
 * Sizes are in CHARACTERS, not tokens, deliberately: it needs no tokenizer, is
 * stable across embedding models, and ~4 chars/token makes the mapping obvious
 * (the 1200-char default is roughly 300 tokens, comfortably inside
 * nomic-embed-text's window with room for the section context prepended later).
 */

export interface ProseChunk {
  /** The chunk text, including any overlap carried from the previous chunk. */
  content: string;
  /** 0-based position of this chunk within the document. */
  index: number;
}

export interface ChunkProseOptions {
  /** Target maximum chunk size in characters. */
  maxChars?: number;
  /** Characters of the previous chunk repeated at the start of the next. */
  overlapChars?: number;
  /**
   * Chunks shorter than this are merged into the previous chunk instead of
   * standing alone. Prevents a trailing "Page 3 of 10" fragment becoming a
   * retrievable chunk that matches everything and means nothing.
   */
  minChars?: number;
}

const DEFAULTS = {
  maxChars: 1200,
  overlapChars: 180,
  minChars: 120,
} as const;

/** Split text into sentences, keeping the terminator attached. */
function splitSentences(text: string): string[] {
  // Break after . ! ? followed by whitespace. Avoids splitting on decimals
  // ("2.6 mm") and common abbreviations by requiring a following space AND a
  // capital/digit start, which is good enough for inspection/SOP prose.
  const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/g);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Split a paragraph that is itself over budget, never mid-word. */
function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    // Prefer the last space inside the budget so we never cut a word in half.
    const window = rest.slice(0, maxChars);
    const cut = window.lastIndexOf(" ");
    const at = cut > maxChars * 0.6 ? cut : maxChars;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** Take the last ~`chars` of text, starting at a sentence boundary if possible. */
function tailOverlap(text: string, chars: number): string {
  if (chars <= 0 || text.length <= chars) return text;
  const tail = text.slice(-chars);
  const sentences = splitSentences(tail);
  // Drop a leading partial sentence so the overlap starts cleanly.
  if (sentences.length > 1) return sentences.slice(1).join(" ");
  const space = tail.indexOf(" ");
  return space > 0 ? tail.slice(space + 1) : tail;
}

/**
 * Segment free-form text into overlapping, semantically coherent chunks.
 * Returns [] for empty input.
 */
export function chunkProse(text: string, opts: ChunkProseOptions = {}): ProseChunk[] {
  const maxChars = opts.maxChars ?? DEFAULTS.maxChars;
  const overlapChars = opts.overlapChars ?? DEFAULTS.overlapChars;
  const minChars = opts.minChars ?? DEFAULTS.minChars;

  const clean = text.trim();
  if (clean.length === 0) return [];

  // 1) Break into paragraphs, then into units that individually fit the budget.
  const units: string[] = [];
  for (const para of clean.split(/\n{2,}/)) {
    const p = para.trim();
    if (p.length === 0) continue;
    if (p.length <= maxChars) {
      units.push(p);
      continue;
    }
    // 2) Oversized paragraph -> sentences, regrouped up to the budget.
    let buf = "";
    for (const sentence of splitSentences(p)) {
      if (sentence.length > maxChars) {
        if (buf) {
          units.push(buf);
          buf = "";
        }
        // 3) Last resort.
        units.push(...hardSplit(sentence, maxChars));
        continue;
      }
      if (buf.length + sentence.length + 1 > maxChars) {
        units.push(buf);
        buf = sentence;
      } else {
        buf = buf ? `${buf} ${sentence}` : sentence;
      }
    }
    if (buf) units.push(buf);
  }

  // 4) Pack units into chunks, carrying overlap between them.
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    // Start the next chunk with the tail of the one just closed.
    const overlap = current ? tailOverlap(current, overlapChars) : "";
    current = overlap ? `${overlap}\n\n${unit}` : unit;
    // The overlap itself can push a large unit over budget; split if so.
    if (current.length > maxChars) {
      const pieces = hardSplit(current, maxChars);
      chunks.push(...pieces.slice(0, -1));
      current = pieces[pieces.length - 1];
    }
  }
  if (current) chunks.push(current);

  // 5) Fold a runt trailing chunk back into its predecessor.
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    if (last.length < minChars) {
      chunks[chunks.length - 2] = `${chunks[chunks.length - 2]}\n\n${last}`;
      chunks.pop();
    }
  }

  return chunks.map((content, index) => ({ content, index }));
}
