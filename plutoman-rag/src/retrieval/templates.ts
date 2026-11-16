/**
 * Report-template content (identical in every report of a type) vs recorded
 * values. Pure: no database.
 */
import { RetrievalHit } from "./hybrid";

/**
 * Sections that come from the report TEMPLATE (the same text in every report
 * of a type), as opposed to recorded values.
 */
export const TEMPLATE_SECTIONS = new Set(["Report Contents", "Report Footer"]);

const body = (content: string) => content.replace(/^\[[^\]]*\]\s*/, "").trim();

/**
 * Keep one copy of template text that several reports share word for word —
 * the copy from the lowest POID, so the choice is deterministic. Citing six
 * reports for one identical contents page is scored as citing wrong
 * documents (golden Q18), and it tells the reader nothing more. Recorded
 * values are never merged: four reports with "Technical Clearance: Yes" are
 * four facts (Q09).
 */
export function oneCopyOfTemplates(hits: RetrievalHit[]): RetrievalHit[] {
  const keep = new Map<string, RetrievalHit>();
  for (const h of hits) {
    if (!TEMPLATE_SECTIONS.has(h.sectionPath ?? "")) continue;
    const key = `${h.sectionPath}|${body(h.content)}`;
    const cur = keep.get(key);
    if (!cur || (h.poid ?? h.sopId) < (cur.poid ?? cur.sopId)) keep.set(key, h);
  }
  return hits.filter(
    (h) => !TEMPLATE_SECTIONS.has(h.sectionPath ?? "") || keep.get(`${h.sectionPath}|${body(h.content)}`) === h
  );
}
