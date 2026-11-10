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
  page: string | null;
  position: number;
}

export interface ReportFacts {
  report: ReportFact;
  items: ItemFact[];
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
    items.push({ area, section, item, value, measurement, note, result, page: pageOf.get(sectionPath) ?? null, position: items.length });
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
      itemsChecked: checked.length,
      itemsPassed: checked.filter((i) => i.result === "PASS").length,
      itemsFailed: checked.filter((i) => i.result === "FAIL").length,
      itemsConditional: checked.filter((i) => i.result === "CONDITIONAL").length,
    },
    items,
  };
}
