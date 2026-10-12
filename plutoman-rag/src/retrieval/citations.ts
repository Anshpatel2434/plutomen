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
 * A bracketed group that contains only source markers, ranges and separators:
 * "[S1]", "[S1, S3]", "[S1; S2]", "[S1 and S4]", "[Source 2]", "[S1-S10]",
 * "[S2 to S4]". Anything else in square brackets (e.g. "[note]") is left
 * untouched.
 */
const MARKER_ITEM = String.raw`S(?:ource)?\s*\d+(?:\s*(?:-|–|—|to)\s*(?:S(?:ource)?\s*)?\d+)?`;
const MARKER_GROUP = new RegExp(
  String.raw`\[\s*${MARKER_ITEM}(?:\s*(?:,|;|&|and)?\s*${MARKER_ITEM})*\s*\]`,
  "gi"
);
/** One marker or range: group 1 = first number, group 2 = range end (if any). */
const MARKER_NUMBER =
  /S(?:ource)?\s*(\d+)(?:\s*(?:-|–|—|to)\s*(?:S(?:ource)?\s*)?(\d+))?/gi;

/**
 * 0-based source indices named by one marker or range ("S3" or "S1-S10"),
 * limited to the `count` sources that exist (so "[S1-S9999]" cannot loop).
 */
function markerIndices(m: RegExpMatchArray, count: number): number[] {
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  const out: number[] = [];
  for (let n = Math.max(1, Math.min(from, to)); n <= Math.min(count, Math.max(from, to)); n++) {
    out.push(n - 1);
  }
  return out;
}

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
      // Indices outside the sources are dropped (never rendered as a citation).
      for (const i of markerIndices(m, hits.length)) {
        if (!cited.includes(i)) cited.push(i);
        const label = sourceLabel(hits[i].citation);
        if (!labels.includes(label)) labels.push(label);
      }
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
