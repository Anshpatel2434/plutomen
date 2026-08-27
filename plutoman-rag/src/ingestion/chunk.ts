/**
 * Turn a ParsedReport into retrievable chunks.
 *
 * Chunking strategy: one chunk per meaningful row — each checklist parameter,
 * each observation, and each conclusion field. Every chunk carries:
 *   - section_path : breadcrumb, e.g.
 *       "Characteristics > Visual & Physical Checks > Sheet Steel Thickness & Type"
 *   - question / answer / verdict : structured fields for display + filtering
 *   - content : a self-describing sentence optimized for embedding + full-text,
 *       e.g. "[Polycab India Ltd. | IIM Ahmedabad] Visual & Physical Checks /
 *             Sheet Steel Thickness & Type: Not OK - Canopy measured 2.6 mm ..."
 *   - metadata : vendor, site, po, report_date pulled from the header sheets.
 */
import { ParsedReport, ChecklistItem, Observation } from "./parseXlsx";

/** A single unit ready to embed + insert. */
export interface Chunk {
  sectionPath: string;
  question: string;
  answer: string;
  verdict: string | null;
  content: string;
}

/** Report-level metadata shared by every chunk of a report. */
export interface ReportMetadata {
  site: string | null;
  vendor: string | null;
  po: string | null;
  reportDate: string | null; // ISO yyyy-mm-dd, or null if unparseable
  type: string | null; // checklist category, e.g. "LT"
  title: string | null; // checklist name, e.g. "LT_Mini_Pillar"
  status: string | null;
}

export interface ChunkedReport {
  metadata: ReportMetadata;
  chunks: Chunk[];
}

// --- helpers ----------------------------------------------------------------

/** Case-insensitive lookup over Basic Details rows by title. */
function basic(report: ParsedReport, title: string): string | null {
  const row = report.basicDetails.find((r) => r.title.toLowerCase() === title.toLowerCase());
  return row?.answer || null;
}

/**
 * Normalize a verdict-ish value into a canonical token, or null if the value is
 * plainly not a verdict (e.g. a measurement). Handles "Ok", "Not Ok", mixed
 * values like "Canopy -3mm|Not OK" by scanning for a verdict token.
 */
function normalizeVerdict(raw: string): string | null {
  const v = raw.toLowerCase();
  if (/\bnot ?ok\b|\breject/.test(v)) return "NOT OK";
  if (/\bok\b|\baccept|\byes\b/.test(v)) return "OK";
  return null;
}

/** Best-effort parse of "Aug 12, 2026" (and similar) into ISO yyyy-mm-dd. */
function parseReportDate(report: ParsedReport): string | null {
  const raw =
    basic(report, "Date of Inspection") ||
    report.checklistDetails["Completed on"] ||
    report.checklistDetails["Started On"] ||
    "";
  if (!raw) return null;
  const d = new Date(raw.replace(/,\s*\d{1,2}:\d{2}\s*[AP]M$/i, "")); // strip trailing time
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Build the "[vendor | site]" tag prefix for a content sentence. */
function tag(meta: ReportMetadata): string {
  const parts = [meta.vendor, meta.site].filter(Boolean);
  return parts.length ? `[${parts.join(" | ")}] ` : "";
}

// --- main -------------------------------------------------------------------

export function chunkReport(report: ParsedReport): ChunkedReport {
  const cd = report.checklistDetails;
  const metadata: ReportMetadata = {
    site: cd["Site"] || null,
    vendor: basic(report, "Vendor Name"),
    po: basic(report, "PO Details") || basic(report, "PO No") || null,
    reportDate: parseReportDate(report),
    type: cd["Category"] || null,
    title: cd["Checklist name"] || null,
    status: cd["Status"] || null,
  };

  const chunks: Chunk[] = [];
  const prefix = tag(metadata);

  // 1) Characteristics / Parameter rows — the core inspection checklist.
  for (const item of report.characteristics) {
    chunks.push(makeItemChunk(prefix, "Characteristics", item));
  }

  // 2) Inspection Observations — free-text non-conformances / notes.
  report.observations.forEach((obs: Observation, i: number) => {
    const sectionPath = `Inspection Observations > ${obs.index || `#${i + 1}`}`;
    const content = `${prefix}Inspection Observation ${obs.index || i + 1}: ${obs.text}`;
    chunks.push({
      sectionPath,
      question: `Observation ${obs.index || i + 1}`,
      answer: obs.text,
      verdict: null,
      content,
    });
  });

  // 3) Inspection Conclusion — the verdict-bearing summary rows.
  const c = report.conclusion;
  if (c.testResults) {
    chunks.push(
      makeConclusionChunk(prefix, "Test Results", c.testResults, normalizeVerdict(c.testResults))
    );
  }
  if (c.technicalClearance) {
    chunks.push(
      makeConclusionChunk(
        prefix,
        "Technical Clearance",
        c.technicalClearance,
        normalizeVerdict(c.technicalClearance)
      )
    );
  }
  if (c.declaration) {
    chunks.push(makeConclusionChunk(prefix, "Declaration", c.declaration, null));
  }
  for (const extra of c.extra) {
    chunks.push(makeConclusionChunk(prefix, extra.title, extra.answer, normalizeVerdict(extra.answer)));
  }

  return { metadata, chunks };
}

/** Build a chunk for a Characteristics row. */
function makeItemChunk(prefix: string, top: string, item: ChecklistItem): Chunk {
  const sectionPath = [top, item.section, item.title].filter(Boolean).join(" > ");
  const verdict = normalizeVerdict(item.answer);
  // Compose a readable, self-contained sentence.
  const bits: string[] = [];
  bits.push(`${item.section} / ${item.title}:`);
  if (item.answer) bits.push(item.answer);
  if (item.measurement) bits.push(`(measurement: ${item.measurement})`);
  if (item.notes) bits.push(`- ${item.notes}`);
  const content = `${prefix}${bits.join(" ")}`.trim();
  return { sectionPath, question: item.title, answer: item.answer, verdict, content };
}

/** Build a chunk for a Conclusion field. */
function makeConclusionChunk(
  prefix: string,
  title: string,
  answer: string,
  verdict: string | null
): Chunk {
  const sectionPath = `Inspection Conclusion > ${title}`;
  const content = `${prefix}Inspection Conclusion / ${title}: ${answer}`;
  return { sectionPath, question: title, answer, verdict, content };
}
