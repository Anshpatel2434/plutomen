/**
 * Parser for the client's inspection-report workbooks.
 *
 * Observed workbook shape (confirmed against demo_data/*.xlsx) — 5 sheets:
 *   1. "Checklist Details"          key/value header. Cols: Title | Details
 *                                   (Checklist name, Category, Subcategory,
 *                                    Site, Status, Started/Completed by/on, ...)
 *   2. "Basic Details"              Cols: Section | Title | Answer | Measurement
 *                                        | Notes | Images | Videos | Documents
 *                                   (SAP Code, Vendor Name, Offered Qty,
 *                                    PO Details, Date of Inspection, Cable Size, ...)
 *   3. "Characteristics _ Parameter" the checklist body. NOTE the value column
 *                                   header is "Input" (not "Answer").
 *                                   Cols: Section | Title | Input | Measurement
 *                                        | Notes | Images | Videos | Documents
 *   4. "Inspection Observations"    Cols: Section | Observations | Answer | ...
 *                                   (the number lands in "Observations", the
 *                                    free-text observation in "Answer")
 *   5. "Inspection Conclusion"      Cols: Section | Title | Answer | ...
 *                                   (Test Results, Technical Clearance, Declaration)
 *
 * Some cells contain the Unicode replacement char U+FFFD ("�", shown as
 * "?"/"�") where a dash/hyphen was mangled on export. We clean it on ingest.
 */
import ExcelJS from "exceljs";

// --- Exact sheet names as they appear in the workbooks -----------------------
const SHEET = {
  checklistDetails: "Checklist Details",
  basicDetails: "Basic Details",
  characteristics: "Characteristics _ Parameter",
  observations: "Inspection Observations",
  conclusion: "Inspection Conclusion",
} as const;

// --- Normalized output types -------------------------------------------------

/** One row of the checklist body / basic details / conclusion sheets. */
export interface ChecklistItem {
  section: string;
  title: string;
  /** The value column: "Input" on Characteristics, "Answer" elsewhere. */
  answer: string;
  measurement: string;
  notes: string;
}

/** One inspection observation line. */
export interface Observation {
  index: string; // the label in the "Observations" column, e.g. "1." / "2"
  text: string; // the free-text observation (from the "Answer" column)
}

/** The conclusion sheet, teased apart into its meaningful fields. */
export interface Conclusion {
  testResults: string;
  technicalClearance: string;
  declaration: string;
  /** Any other conclusion rows kept verbatim. */
  extra: ChecklistItem[];
}

/** Fully parsed, cleaned report. Tenant/mongoId are injected by the caller. */
export interface ParsedReport {
  /** Flat key/value map from "Checklist Details". */
  checklistDetails: Record<string, string>;
  /** Rows from "Basic Details". */
  basicDetails: ChecklistItem[];
  /** Rows from "Characteristics _ Parameter". */
  characteristics: ChecklistItem[];
  /** Rows from "Inspection Observations". */
  observations: Observation[];
  /** Parsed "Inspection Conclusion". */
  conclusion: Conclusion;
}

/** Replace the U+FFFD mojibake with a hyphen and collapse the odd spacing. */
export function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/�/g, "-") // mangled dash -> hyphen (fits "Phase-earth", "2.0% - at limit")
    .replace(/\s+/g, " ")
    .trim();
}

/** Read a cell's display value robustly (handles rich text / formula results). */
function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    // Rich text or formula result objects.
    const anyV = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (Array.isArray(anyV.richText)) return clean(anyV.richText.map((r) => r.text).join(""));
    if (anyV.text !== undefined) return clean(anyV.text);
    if (anyV.result !== undefined) return clean(anyV.result);
  }
  return clean(v);
}

/** Map a tabular sheet (with a header row) into ChecklistItem rows. */
function readItemSheet(ws: ExcelJS.Worksheet | undefined): ChecklistItem[] {
  if (!ws) return [];
  const items: ChecklistItem[] = [];
  // Row 1 is the header (Section | Title | Input|Answer | Measurement | Notes | ...).
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const section = cellText(row.getCell(1));
    const title = cellText(row.getCell(2));
    const answer = cellText(row.getCell(3));
    const measurement = cellText(row.getCell(4));
    const notes = cellText(row.getCell(5));
    if (!section && !title && !answer) return; // skip fully-blank rows
    items.push({ section, title, answer, measurement, notes });
  });
  return items;
}

/** Parse an xlsx buffer into a normalized, cleaned report. */
export async function parseWorkbookBuffer(buffer: Buffer): Promise<ParsedReport> {
  const wb = new ExcelJS.Workbook();
  // Cast: Node 24's Buffer<ArrayBufferLike> vs ExcelJS's older Buffer signature
  // is a pure type-variance mismatch; the value is a valid Buffer at runtime.
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);

  // --- Checklist Details: key/value (Title | Details) ---
  const checklistDetails: Record<string, string> = {};
  const cdSheet = wb.getWorksheet(SHEET.checklistDetails);
  if (cdSheet) {
    cdSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // header: Title | Details
      const key = cellText(row.getCell(1));
      const val = cellText(row.getCell(2));
      if (key) checklistDetails[key] = val;
    });
  }

  const basicDetails = readItemSheet(wb.getWorksheet(SHEET.basicDetails));
  const characteristics = readItemSheet(wb.getWorksheet(SHEET.characteristics));

  // --- Inspection Observations: number in col 2, text in col 3 ---
  const observations: Observation[] = [];
  const obsSheet = wb.getWorksheet(SHEET.observations);
  if (obsSheet) {
    obsSheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // header: Section | Observations | Answer | ...
      const index = cellText(row.getCell(2));
      const text = cellText(row.getCell(3));
      if (text) observations.push({ index, text });
    });
  }

  // --- Inspection Conclusion: pick out the three known fields ---
  const conclusionRows = readItemSheet(wb.getWorksheet(SHEET.conclusion));
  const findByTitle = (t: string): string =>
    conclusionRows.find((r) => r.title.toLowerCase() === t.toLowerCase())?.answer ?? "";
  const knownTitles = new Set(["test results", "technical clearance", "declaration"]);
  const conclusion: Conclusion = {
    testResults: findByTitle("Test Results"),
    technicalClearance: findByTitle("Technical Clearance"),
    declaration: findByTitle("Declaration"),
    extra: conclusionRows.filter((r) => !knownTitles.has(r.title.toLowerCase())),
  };

  return { checklistDetails, basicDetails, characteristics, observations, conclusion };
}

export { SHEET };
