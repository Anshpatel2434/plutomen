/**
 * Citations = the sources the answer ACTUALLY relies on (golden-eval change 7).
 *
 * Before: `citations` was every retrieved chunk, so the wrong reports that
 * retrieval inevitably pulls in were always "cited" — and the golden set scores
 * a citation to the wrong document as a fail even when the value is right. The
 * model was also asked to copy long "[document page | section]" tags, which
 * Mistral 7B mangled ("[sop_id: 2 ...]").
 *
 * Now each source is numbered with a short marker ([S1], [S2], ...). Short
 * markers are copied reliably even by small models. After generation we parse
 * the markers the model used, return ONLY those sources as structured
 * citations, and rewrite each marker in the answer as a readable label
 * ("[POID-4547081947.pdf p.2]"). Markers that point at no source are dropped,
 * never rendered as a fake citation.
 */
import { RetrievalHit } from "./hybrid";

/** A source the answer relies on (structured, eval-checkable). */
export interface Citation {
  sopId: string;
  sectionPath: string | null;
  /** From the report's PDF twin; absent/null when ingested without one. */
  poid?: string | null;
  jobId?: string | null;
  /** Printed page label: "2", "6-7", "cover". */
  page?: string | null;
}

/**
 * Human/eval-facing source label. The golden set cites reports as
 * "POID-4547081947.pdf p.2", so use that form when the PDF twin is known and
 * fall back to the source id otherwise.
 */
export function sourceLabel(c: Citation): string {
  if (!c.poid) return c.sopId;
  return c.page ? `${c.poid}.pdf p.${c.page}` : `${c.poid}.pdf`;
}

/** Marker for the source at 0-based position i: "S1", "S2", ... */
export const marker = (i: number): string => `S${i + 1}`;

/**
 * A bracketed group that contains only source markers and separators:
 * "[S1]", "[S1, S3]", "[S1; S2]", "[S1 and S4]", "[Source 2]". Anything else in
 * square brackets (e.g. "[note]") is left untouched.
 */
const MARKER_GROUP =
  /\[\s*(?:S(?:ource)?\s*\d+)(?:\s*(?:,|;|&|and)?\s*S(?:ource)?\s*\d+)*\s*\]/gi;
const MARKER_NUMBER = /S(?:ource)?\s*(\d+)/gi;

export interface RenderedAnswer {
  /** Answer with markers replaced by readable source labels. */
  text: string;
  /** 0-based indices of the sources cited, in order of first appearance. */
  cited: number[];
}

/** Replace markers with labels and collect which sources were cited. */
export function renderCitations(answer: string, hits: RetrievalHit[]): RenderedAnswer {
  const cited: number[] = [];
  const text = answer.replace(MARKER_GROUP, (group) => {
    const labels: string[] = [];
    for (const m of group.matchAll(MARKER_NUMBER)) {
      const i = Number(m[1]) - 1;
      if (i < 0 || i >= hits.length) continue; // points at no source: drop it
      if (!cited.includes(i)) cited.push(i);
      const label = sourceLabel(hits[i].citation);
      if (!labels.includes(label)) labels.push(label);
    }
    return labels.length > 0 ? `[${labels.join("; ")}]` : "";
  });
  // Tidy spaces left where an invalid marker was removed.
  return { text: text.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim(), cited };
}

/** Structured citations for the cited sources (order of first appearance). */
export function citedSources(hits: RetrievalHit[], cited: number[]): Citation[] {
  return cited.map((i) => hits[i].citation);
}
