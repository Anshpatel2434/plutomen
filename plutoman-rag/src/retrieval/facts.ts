/**
 * Complete lists (golden-eval change 4): the shape handed to generation and
 * how it is written into the prompt. Pure (no database), so the answer check
 * (verify.ts) can use it too.
 */
import { RetrievalHit } from "./hybrid";
import { marker } from "./citations";

/** One complete list, as given to the model. */
export interface AggregateFact {
  /** What the list covers, e.g. "Acceptance Tests in Report POID-… (Job …)". */
  heading: string;
  /** Exact counts over EVERY matching item (also the ones not listed). */
  counts: { total: number; passed: number; failed: number; conditional: number; noResult: number };
  /** True when only the items that did not pass are listed. */
  nonPassOnly: boolean;
  /** Listed items, each one a source (by hit id). */
  items: { hitId: string; label: string; related?: boolean }[];
  /**
   * For an item recorded in several reports: whether their values differ, and
   * the items of the report(s) the question's own details point to (an
   * engineer's name, "5 drums", a batch number). Absent for other lists.
   */
  pick?: { valuesDiffer: boolean; singledOut: string[] };
  /**
   * The report's decision says the lot can go, but these records of the same
   * report failed: the answer must give both sides and no plain yes / no.
   */
  conflict?: boolean;
}

/**
 * The complete lists (golden-eval change 4), each item pointing at its source
 * marker. Counts cover every matching item, including any not listed.
 */
export function renderFacts(facts: AggregateFact[], ordered: RetrievalHit[]): string[] {
  if (facts.length === 0) return [];
  const markerOf = new Map(ordered.map((h, i) => [h.id, marker(i)]));
  const lines = ["COMPLETE LISTS (exact, computed from every matching item in the reports):"];
  for (const f of facts) {
    const c = f.counts;
    const notPassed = c.failed + c.conditional;
    const tally =
      c.passed + notPassed > 0
        ? `${c.total} item(s): ${c.passed} passed, ${notPassed} did not pass ` +
          `(${c.failed} failed, ${c.conditional} conditional / pending)` +
          (c.noResult ? `, ${c.noResult} with no result word` : "")
        : `${c.total} item(s)`;
    lines.push(`- ${f.heading}: ${tally}.${f.nonPassOnly ? " Those that did not pass:" : ""}`);
    for (const it of f.items) {
      const m = markerOf.get(it.hitId);
      if (m) lines.push(`    * ${it.related ? "Related observation in the same report: " : ""}${it.label} [${m}]`);
    }
    if (f.conflict) {
      lines.push(
        "    (These records contradict the report's decision above: report both the decision and these " +
          "records, say the report does not resolve it, and do not answer with a plain yes or no.)"
      );
    }
    if (f.pick?.singledOut.length) {
      const ms = f.pick.singledOut.map((id) => markerOf.get(id)).filter(Boolean);
      if (ms.length) lines.push(`    (Details in the QUESTION match only ${ms.map((m) => `[${m}]`).join(", ")}: answer for that report.)`);
    } else if (f.pick?.valuesDiffer) {
      lines.push(
        "    (The values differ between reports and the QUESTION does not say which report: " +
          "give each report's value with its Job ID, or ask which report is meant.)"
      );
    }
  }
  lines.push("");
  return lines;
}

