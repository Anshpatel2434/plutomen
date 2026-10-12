/**
 * Turn a ParsedReport into retrievable chunks.
 *
 * Chunking strategy: one chunk per meaningful row — one report-details chunk,
 * each Basic Details row, each checklist parameter, each observation, and each
 * conclusion field. Every chunk carries:
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
 * Verdict vocabulary. Order of checks matters — a value is classified by the
 * FIRST family it matches:
 *
 *   1. NOT OK       explicit failure wording. Checked first so a value such as
 *                   "Flame propagated beyond mark – flammability fail" or
 *                   "Lot not meeting QAP acceptance criteria" can never fall
 *                   through to a positive word later in the string.
 *   2. CONDITIONAL  neither a pass nor a stated fail: "below acceptance; retest
 *                   pending", "Subject to rectification of minor defects".
 *                   Callers asking "what did not pass" should use verdict <> 'OK'.
 *   3. OK           pass / ok / conforms / accepted / cleared / yes.
 *
 * Word boundaries are deliberate: `\baccept(ed|able)?\b` matches "accepted"
 * but NOT "acceptance" (the old /\baccept/ turned "80 MΩ – below acceptance"
 * into OK). Anything unmatched (measurements, shapes, "Attached") stays null.
 */
const NOT_OK_PATTERN = new RegExp(
  [
    String.raw`\bnot ?ok\b`,
    String.raw`\breject(ed|ion)?\b`,
    String.raw`\bfail(s|ed|ure)?\b`,
    String.raw`\bnot (meeting|met|conforming|compliant|acceptable|cleared|recommended|verified)\b`,
    String.raw`\bnon[- ]?(conform\w*|complian\w*)\b`,
    String.raw`\bbelow (min|minimum|spec|limit)\b`,
    String.raw`\babove (max|maximum|limit)\b`,
    String.raw`\bout of (spec|tolerance)\b`,
    // "Water blocking missing in mid strand layer – deviation / NCR"
    String.raw`\bmissing\b`,
    String.raw`\bdeviation\b`,
    String.raw`\bncr\b`,
  ].join("|")
);

const CONDITIONAL_PATTERN = new RegExp(
  [
    String.raw`\bretest\b`,
    String.raw`\bpending\b`,
    String.raw`\bsubject to\b`,
    String.raw`\bbelow acceptance\b`,
    String.raw`\bconditional(ly)?\b`,
    String.raw`\bunder review\b`,
  ].join("|")
);

const OK_PATTERN = new RegExp(
  [
    String.raw`\bok\b`,
    String.raw`\bpass(es|ed)?\b`,
    String.raw`\baccept(ed|able)?\b`,
    String.raw`\bconform(s|ed|ing)?\b`,
    String.raw`\bcomplian(t|ce)\b`,
    String.raw`\bcleared\b`,
    String.raw`\brecommended\b`,
    String.raw`\bverified\b`,
    String.raw`\bsatisfactory\b`,
    String.raw`\byes\b`,
  ].join("|")
);

/**
 * Normalize a verdict-ish value into "OK" | "NOT OK" | "CONDITIONAL", or null
 * if the value is plainly not a verdict (e.g. a bare measurement). Handles
 * mixed values like "Canopy -3mm|Not OK" by scanning for a verdict token.
 */
export function normalizeVerdict(raw: string): string | null {
  const v = raw.toLowerCase().replace(/[–—]/g, "-").trim();
  if (!v) return null;
  if (NOT_OK_PATTERN.test(v)) return "NOT OK";
  if (CONDITIONAL_PATTERN.test(v)) return "CONDITIONAL";
  if (OK_PATTERN.test(v)) return "OK";
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

/**
 * Document identifiers from the report's PDF twin (see parsePdf.ts). Optional:
 * an XLSX ingested without its PDF simply has no POID / Job ID.
 */
export interface ReportIds {
  poid?: string | null;
  jobId?: string | null;
}

/**
 * Build the "[POID | Job | vendor | site]" tag prefix for a content sentence.
 * Putting the POID and Job ID in the text (not only in columns) makes them hit
 * both keyword search and embeddings — users ask "who is the vendor for job
 * PH2026100008?" or type "ph2026100001" (golden set Q01, Q25).
 */
function tag(meta: ReportMetadata, ids: ReportIds = {}): string {
  const parts = [ids.poid, ids.jobId ? `Job ${ids.jobId}` : null, meta.vendor, meta.site].filter(
    Boolean
  );
  return parts.length ? `[${parts.join(" | ")}] ` : "";
}

// --- main -------------------------------------------------------------------

export function chunkReport(report: ParsedReport, ids: ReportIds = {}): ChunkedReport {
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
  const prefix = tag(metadata, ids);

  // 0a) Report details ("Checklist Details" sheet) — who started/completed the
  //     inspection and when, site, category, status. Previously parsed only
  //     into filter metadata and never searchable (golden set Q19). One chunk
  //     keeps the fields together, since questions ask for them together
  //     ("who prepared it and when was it started").
  const detailPairs = Object.entries(cd)
    .filter(([, v]) => v && v !== "-")
    .map(([k, v]) => `${k}: ${v}`);
  if (detailPairs.length > 0) {
    chunks.push({
      sectionPath: "Report Details",
      question: "Report details",
      answer: detailPairs.join("; "),
      verdict: null,
      content: `${prefix}Report details — ${detailPairs.join("; ")}`,
    });
  }

  // 0b) Basic Details rows — SAP code, vendor, offered qty, PO number/date,
  //     AEML and vendor engineers, serial/batch numbers, inspection date.
  //     Previously used only as metadata, so none of it was retrievable
  //     (golden set Q02, Q05–Q07, Q26, Q29, Q38, Q39). These are facts, not
  //     checks, so they never get a verdict.
  for (const item of report.basicDetails) {
    chunks.push(makeDetailChunk(prefix, item));
  }

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
  const notes = c.notes ?? { testResults: "", technicalClearance: "", declaration: "" };
  if (c.testResults) {
    chunks.push(
      makeConclusionChunk(
        prefix,
        "Test Results",
        c.testResults,
        normalizeVerdict(c.testResults),
        notes.testResults
      )
    );
  }
  if (c.technicalClearance) {
    chunks.push(
      makeConclusionChunk(
        prefix,
        "Technical Clearance",
        c.technicalClearance,
        normalizeVerdict(c.technicalClearance),
        notes.technicalClearance
      )
    );
  }
  if (c.declaration) {
    // Declarations carry the dispatch decision ("Lot cleared for dispatch",
    // "Material is rejected for the offered lot"), so they get a verdict too.
    chunks.push(
      makeConclusionChunk(
        prefix,
        "Declaration",
        c.declaration,
        normalizeVerdict(c.declaration),
        notes.declaration
      )
    );
  }
  for (const extra of c.extra) {
    chunks.push(
      makeConclusionChunk(prefix, extra.title, extra.answer, normalizeVerdict(extra.answer), extra.notes)
    );
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

/** Build a chunk for a Basic Details row (a fact about the lot, not a check). */
function makeDetailChunk(prefix: string, item: ChecklistItem): Chunk {
  const top = "Basic Details";
  // The sheet's Section column is usually "Basic Details" too — don't repeat it.
  const section = item.section && item.section !== top ? item.section : "";
  const sectionPath = [top, section, item.title].filter(Boolean).join(" > ");
  const bits: string[] = [`${top} / ${item.title}:`];
  if (item.answer) bits.push(item.answer);
  if (item.measurement) bits.push(`(measurement: ${item.measurement})`);
  if (item.notes) bits.push(`- ${item.notes}`);
  return {
    sectionPath,
    question: item.title,
    answer: item.answer,
    verdict: null,
    content: `${prefix}${bits.join(" ")}`.trim(),
  };
}

/**
 * Build a chunk for a Conclusion field. The inspector's note goes into the
 * searchable text (same "- note" form as checklist items) but NOT into the
 * verdict, which comes from the recorded answer alone: notes can contradict
 * it (e.g. Test Results "Not Ok" with the note "All acceptance tests Pass").
 */
function makeConclusionChunk(
  prefix: string,
  title: string,
  answer: string,
  verdict: string | null,
  note = ""
): Chunk {
  const sectionPath = `Inspection Conclusion > ${title}`;
  const content = `${prefix}Inspection Conclusion / ${title}: ${answer}${note ? ` - ${note}` : ""}`;
  return { sectionPath, question: title, answer, verdict, content };
}
