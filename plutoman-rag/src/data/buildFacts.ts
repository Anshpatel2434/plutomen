/**
 * Turn one parsed inspection report into the data engine's rows: one report
 * row and one row per recorded item (see db/migrations/008_inspection_facts.sql).
 *
 * Pure: no database, no model. Nothing here is specific to a report template —
 * whatever rows a workbook carries become items, in order.
 */
import { ParsedReport } from "../ingestion/parseXlsx";
import { normalizeVerdict, ReportMetadata } from "../ingestion/chunk";

export type Result = "PASS" | "FAIL" | "CONDITIONAL";

export interface ReportFact {
  reportId: string;
  jobId: string | null;
  reportType: string | null;
  category: string | null;
  subcategory: string | null;
  site: string | null;
  vendor: string | null;
  inspectionDate: string | null;
  preparedBy: string | null;
  status: string | null;
  testResults: string | null;
  testResultsResult: Result | null;
  technicalClearance: string | null;
  clearanceResult: Result | null;
  declaration: string | null;
  declarationResult: Result | null;
  /** The whole conclusion in the report's own words: "Test Results: … | Technical Clearance: … | Declaration: …". */
  outcomeSummary: string | null;
  /** True when the conclusion fields do not agree with each other. */
  outcomeConflict: boolean;
  itemsChecked: number;
  itemsPassed: number;
  itemsFailed: number;
  itemsConditional: number;
}

export interface ItemFact {
  area: "Basic Details" | "Characteristics" | "Observations" | "Conclusion";
  section: string | null;
  item: string;
  value: string | null;
  measurement: string | null;
  note: string | null;
  result: Result | null;
  /** The result word as the inspector wrote it; null when the value carries none. */
  marked: Marked | null;
  page: string | null;
  position: number;
}

export type Marked = "Ok" | "Not Ok" | "Attached" | "Not Attached";

/** One "<number> <unit>" read from a recorded value, so quantities can be summed. */
export interface AmountFact {
  area: ItemFact["area"];
  section: string | null;
  item: string;
  amount: number;
  unit: string;
  value: string;
  page: string | null;
  position: number;
}

export interface ReportFacts {
  report: ReportFact;
  items: ItemFact[];
  amounts: AmountFact[];
}

/** The result word exactly as written ("Canopy -3mm|Not OK" -> "Not Ok"). */
export function markedAs(value: string | null | undefined): Marked | null {
  const v = (value ?? "").toLowerCase();
  if (/\bnot\s*ok\b/.test(v)) return "Not Ok";
  if (/\bnot\s+attached\b/.test(v)) return "Not Attached";
  if (/^\s*attached\b/.test(v)) return "Attached";
  if (/\bok\b/.test(v)) return "Ok";
  return null;
}

/** Items whose numbers are identifiers or dates, not quantities. */
const NOT_A_QUANTITY = /\b(date|po|sap|code|batch|serial|sl\.?\s*nos?|engineer|designation|name|size)\b/i;
/** Words that follow a number without being its unit. */
const NOT_A_UNIT = new Set([
  "x", "to", "and", "or", "of", "at", "as", "per", "in", "on", "by", "the", "dated", "c", "core", "cores",
  "both", "all", "side", "sides", "for", "is", "was", "min", "max", "avg",
]);
const UNIT_ALIASES: Record<string, string> = {
  drums: "drum", no: "nos", numbers: "nos", number: "nos", pcs: "nos", pieces: "nos", units: "nos", unit: "nos",
  m: "mtr", mtrs: "mtr", meter: "mtr", meters: "mtr", metre: "mtr", metres: "mtr",
  "%": "percent", microns: "micron",
};

/**
 * Every "<number> <unit>" in a recorded value: "10 Drums / 5000 mtr" ->
 * [10 drum, 5000 mtr]; with firstOnly, "2.8% – above max 2%" -> [2.8 percent].
 * Pure. Numbers of 7+ digits are identifiers, not amounts.
 */
export function parseAmounts(value: string, firstOnly = false): { amount: number; unit: string }[] {
  const out: { amount: number; unit: string }[] = [];
  for (const m of value.matchAll(/(?<![\w.\-/])(\d{1,3}(?:,\d{3})+|\d{1,6})(\.\d+)?\s?(%|[A-Za-zΩµ°]{1,12})/g)) {
    const raw = m[3].toLowerCase();
    if (NOT_A_UNIT.has(raw)) continue;
    const amount = Number(m[1].replace(/,/g, "") + (m[2] ?? ""));
    if (!Number.isFinite(amount)) continue;
    out.push({ amount, unit: UNIT_ALIASES[raw] ?? raw });
    if (firstOnly) break;
  }
  return out;
}

/** The chunker's verdict vocabulary -> the data engine's. */
export function toResult(verdict: string | null): Result | null {
  if (verdict === "OK") return "PASS";
  if (verdict === "NOT OK") return "FAIL";
  if (verdict === "CONDITIONAL") return "CONDITIONAL";
  return null;
}

const clean = (s: string | undefined | null): string | null => {
  const t = (s ?? "").trim();
  return t && t !== "-" ? t : null;
};

/**
 * @param pageOf printed page of an item, by the chunk section path the chunker
 *               gives it ("Characteristics > Acceptance Tests > IR Test"); empty
 *               when the report was ingested without its PDF twin.
 */
export function buildFacts(
  report: ParsedReport,
  meta: ReportMetadata,
  ids: { reportId: string; jobId?: string | null },
  pageOf: Map<string, string | null> = new Map()
): ReportFacts {
  const items: ItemFact[] = [];
  const amounts: AmountFact[] = [];
  const add = (
    area: ItemFact["area"],
    section: string | null,
    item: string,
    value: string | null,
    measurement: string | null,
    note: string | null,
    result: Result | null,
    sectionPath: string
  ): void => {
    const page = pageOf.get(sectionPath) ?? null;
    const position = items.length;
    const marked = area === "Characteristics" || area === "Conclusion" ? markedAs(value) : null;
    items.push({ area, section, item, value, measurement, note, result, marked, page, position });
    // Quantities of the lot (every figure), and the reading of a check (its first figure).
    if (value && (area === "Basic Details" ? !NOT_A_QUANTITY.test(item) : area === "Characteristics")) {
      for (const a of parseAmounts(value, area !== "Basic Details")) {
        amounts.push({ area, section, item, amount: a.amount, unit: a.unit, value, page, position });
      }
    }
  };

  for (const b of report.basicDetails) {
    const section = b.section && b.section !== "Basic Details" ? b.section : null;
    const path = ["Basic Details", section, b.title].filter(Boolean).join(" > ");
    // Facts about the lot, not checks: never a result.
    add("Basic Details", section, b.title, clean(b.answer), clean(b.measurement), clean(b.notes), null, path);
  }
  for (const c of report.characteristics) {
    const path = ["Characteristics", c.section, c.title].filter(Boolean).join(" > ");
    add("Characteristics", clean(c.section), c.title, clean(c.answer), clean(c.measurement), clean(c.notes), toResult(normalizeVerdict(c.answer)), path);
  }
  report.observations.forEach((o, i) => {
    const label = o.index || `#${i + 1}`;
    add("Observations", null, `Observation ${o.index || i + 1}`, clean(o.text), null, null, null, `Inspection Observations > ${label}`);
  });

  const c = report.conclusion;
  const notes = c.notes ?? { testResults: "", technicalClearance: "", declaration: "" };
  const conclusion = (title: string, answer: string, note: string): Result | null => {
    const result = toResult(normalizeVerdict(answer));
    add("Conclusion", null, title, clean(answer), null, clean(note), result, `Inspection Conclusion > ${title}`);
    return result;
  };
  const testResultsResult = c.testResults ? conclusion("Test Results", c.testResults, notes.testResults) : null;
  const clearanceResult = c.technicalClearance ? conclusion("Technical Clearance", c.technicalClearance, notes.technicalClearance) : null;
  const declarationResult = c.declaration ? conclusion("Declaration", c.declaration, notes.declaration) : null;
  for (const e of c.extra) conclusion(e.title, e.answer, e.notes);

  const part = (label: string, text: string, note: string): string | null =>
    clean(text) ? `${label}: ${clean(text)}${clean(note) ? ` (note: ${clean(note)})` : ""}` : null;
  const outcomeSummary =
    [
      part("Test Results", c.testResults, notes.testResults),
      part("Technical Clearance", c.technicalClearance, notes.technicalClearance),
      part("Declaration", c.declaration, notes.declaration),
    ]
      .filter(Boolean)
      .join(" | ") || null;
  const verdicts = new Set([testResultsResult, clearanceResult, declarationResult].filter(Boolean));

  const checked = items.filter((i) => i.area === "Characteristics" && i.result !== null);
  const cd = report.checklistDetails;
  return {
    report: {
      reportId: ids.reportId,
      jobId: ids.jobId ?? null,
      reportType: meta.title,
      category: meta.type,
      subcategory: clean(cd["Subcategory"]),
      site: meta.site,
      vendor: meta.vendor,
      inspectionDate: meta.reportDate,
      preparedBy: clean(cd["Completed by"]) ?? clean(cd["Started by"]) ?? clean(cd["Created by"]),
      status: meta.status,
      testResults: clean(c.testResults),
      testResultsResult,
      technicalClearance: clean(c.technicalClearance),
      clearanceResult,
      declaration: clean(c.declaration),
      declarationResult,
      outcomeSummary,
      outcomeConflict: verdicts.size > 1,
      itemsChecked: checked.length,
      itemsPassed: checked.filter((i) => i.result === "PASS").length,
      itemsFailed: checked.filter((i) => i.result === "FAIL").length,
      itemsConditional: checked.filter((i) => i.result === "CONDITIONAL").length,
    },
    items,
    amounts,
  };
}
