/**
 * Leg 2 (Classic Unstructured RAG): parsers for the free-form Document Library.
 *
 * Phase-1 could only read the client's inspection workbooks (`parseXlsx.ts`),
 * which are a rigid 5-sheet template. The quotation's Leg 2 is the opposite
 * case — "PDF, TXT, and text extracted from XLS/CSV" with no guaranteed shape.
 * This module turns any of those into ONE normalized shape:
 *
 *     { text, format, pages? }
 *
 * ...which `chunkProse.ts` then segments and `parseSop.ts` may further inspect
 * for a Section→Step tree. Keeping extraction separate from chunking means a
 * new file type is a new extractor, not a new pipeline.
 *
 * NO OCR. Every PDF in demo_data/ is text-extractable (confirmed), matching the
 * architecture doc's "deterministic — no OCR needed". A scanned/image-only PDF
 * yields no text and is rejected loudly rather than silently indexed as empty.
 */
import { extname } from "path";
import { PDFParse } from "pdf-parse";

/** File formats this module can turn into text. */
export type SourceFormat = "pdf" | "txt" | "csv" | "md";

export interface ParsedDocument {
  /** Full plain text of the document, cleaned. */
  text: string;
  format: SourceFormat;
  /** Page texts, when the format has pages (PDF). Used for page-level citations. */
  pages?: string[];
}

/** Formats handled here. `.xlsx` has its own structured parser. */
const SUPPORTED: Record<string, SourceFormat> = {
  ".pdf": "pdf",
  ".txt": "txt",
  ".csv": "csv",
  ".md": "md",
};

/** Is this a file type parseDocument() can handle? */
export function isSupportedDocument(filename: string): boolean {
  return extname(filename).toLowerCase() in SUPPORTED;
}

/** Map a filename to its SourceFormat, or null when unsupported. */
export function formatOf(filename: string): SourceFormat | null {
  return SUPPORTED[extname(filename).toLowerCase()] ?? null;
}

/**
 * Normalize extracted text.
 *
 * PDF extraction in particular leaves artefacts that wreck both chunking and
 * full-text search if left in: hard-wrapped lines mid-sentence, runs of blank
 * lines, non-breaking spaces, and the U+FFFD replacement char the client's
 * exporter emits where a hyphen should be (already handled for xlsx in
 * parseXlsx.clean — same treatment here so both paths agree).
 */
export function normalizeText(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, "\n")
      .replace(/�/g, "-")
      // Non-breaking space -> ordinary space. Written as an escape rather than
      // the literal character: an invisible U+00A0 sitting in source is
      // unreviewable and unsearchable, and the linter is right to reject it.
      .replace(/\xA0/g, " ")
      // Collapse 3+ blank lines to a paragraph break; a single blank line is
      // meaningful (paragraph boundary) and must survive for chunkProse().
      .replace(/\n{3,}/g, "\n\n")
      // Trailing whitespace per line.
      .replace(/[ \t]+$/gm, "")
      .trim()
  );
}

/**
 * Extract text from a PDF buffer, page by page.
 *
 * pdf-parse 2.x returns one text per page (page boundaries are kept so a
 * citation can say which page a chunk came from). It joins a page's text runs
 * itself, line by line — the 1.x `pagerender` hook used to have to stitch
 * runs together by hand so words were not split ("Summar y").
 */
async function parsePdf(buffer: Buffer): Promise<ParsedDocument> {
  const parser = new PDFParse({ data: buffer });
  let pages: string[];
  try {
    pages = (await parser.getText()).pages.map((p) => p.text);
  } finally {
    await parser.destroy();
  }

  const cleanedPages = pages.map(normalizeText);
  const text = normalizeText(cleanedPages.join("\n\n"));

  if (text.length === 0) {
    throw new Error(
      "PDF produced no extractable text. It is probably a scan or image-only " +
        "document; OCR is out of scope (see Final_Base_Architecture.md §5). " +
        "Indexing it would create empty chunks that pollute retrieval."
    );
  }

  return { text, format: "pdf", pages: cleanedPages };
}

/**
 * Flatten a CSV into readable prose.
 *
 * A raw CSV row ("A123,OK,2.6,Panel") embeds almost nothing an embedding model
 * or a full-text index can use — the column NAMES carry the meaning. So each
 * row is rendered as "header: value" pairs, which both embeds and reads well:
 *
 *     Asset: A123. Verdict: OK. Measured: 2.6. Location: Panel
 *
 * Deliberately a minimal splitter, not a full RFC-4180 parser: it handles
 * double-quoted fields containing commas, which is the case that actually
 * corrupts rows. If the library grows genuinely gnarly CSVs, swap in a real
 * parser here — the rest of the pipeline is unaffected.
 */
function parseCsv(raw: string): ParsedDocument {
  const lines = normalizeText(raw)
    .split("\n")
    .filter((l) => l.trim().length > 0);

  if (lines.length === 0) return { text: "", format: "csv" };

  const splitRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        // "" inside a quoted field is an escaped quote.
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        out.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  };

  const headers = splitRow(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = splitRow(line);
    return headers
      .map((h, i) => (cells[i] ? `${h}: ${cells[i]}` : null))
      .filter((p): p is string => p !== null)
      .join(". ");
  });

  return { text: rows.join("\n"), format: "csv" };
}

/**
 * Parse a document buffer into normalized text, dispatching on the filename's
 * extension. Throws for unsupported types so an ingest job fails loudly rather
 * than indexing nothing.
 */
export async function parseDocumentBuffer(
  buffer: Buffer,
  filename: string
): Promise<ParsedDocument> {
  const format = formatOf(filename);
  if (!format) {
    throw new Error(
      `Unsupported document type "${extname(filename)}" for ${filename}. ` +
        `Supported: ${Object.keys(SUPPORTED).join(", ")} (.xlsx uses parseXlsx).`
    );
  }

  if (format === "pdf") return parsePdf(buffer);

  const raw = buffer.toString("utf8");
  if (format === "csv") return parseCsv(raw);

  return { text: normalizeText(raw), format };
}
