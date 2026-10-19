/**
 * Leg 1 (Structured / Hierarchical RAG): parse an SOP into a Section→Step TREE.
 *
 * The quotation is specific about why this is its own retrieval strategy:
 *
 *   "Retrieval that respects the SOP Section→Step tree ... returns a step in
 *    its proper context, not a floating chunk."  (§1)
 *   "the SOP Section→Step hierarchy ... ingested as trees rather than
 *    flattened text"  (§5.1)
 *
 * So an SOP must NOT go through `chunkProse()`. Flattening "2.1 Verify
 * isolation with an approved detector" into a sliding window loses the fact
 * that it is step 2.1 *of section 2, Safety Precautions* — which is exactly
 * what a technician needs, and exactly what the citation format
 * `[SOP-102, Section 4, Step 2.1]` encodes.
 *
 * The parser is deliberately format-tolerant, because real SOPs arrive as
 * whatever the client's authors typed. Recognized heading forms:
 *
 *     Section 4. Isolation Procedure      |  4. Isolation Procedure
 *     SECTION 4 - Isolation Procedure     |  4) Isolation Procedure
 *   and steps:
 *     4.1 Verify the feeder is de-energised.
 *     4.1) ...      |  Step 4.1: ...
 *
 * Anything before the first recognized section becomes a "preamble" section, so
 * scope/purpose text is still retrievable rather than dropped. If NO section
 * headings are found at all, `parseSop` returns null and the caller falls back
 * to prose chunking — a document that is not actually structured must not be
 * forced into a fake tree.
 */

export interface SopStep {
  /** e.g. "4.1" */
  stepNo: string;
  /** The instruction text (heading line + any continuation lines). */
  text: string;
}

export interface SopSection {
  /** e.g. "4" */
  sectionNo: string;
  /** e.g. "Isolation Procedure" */
  title: string;
  /** Narrative text belonging to the section itself, above/between its steps. */
  intro: string;
  steps: SopStep[];
}

export interface ParsedSop {
  /** Human-readable handle for citations, e.g. "SOP-102". */
  docRef: string | null;
  /** Document title line, when present. */
  title: string | null;
  sections: SopSection[];
}

// A section heading: optional "Section" word, a bare integer, a separator.
const SECTION_RE = /^(?:section\s+)?(\d{1,2})\s*[.):-]\s*(.+?)\s*$/i;
// A step heading: dotted number like 4.1 or 4.1.2, a separator, then text.
const STEP_RE = /^(?:step\s+)?(\d{1,2}(?:\.\d{1,2})+)\s*[.):-]?\s+(.+?)\s*$/i;
// "SOP-102", "SOP 102", "WI-14" style handles anywhere in the first few lines.
/** Words a step's text needs (fewer = a figure starting a line, not a step). */
const MIN_STEP_WORDS = 3;
/** Steps a document needs to be read as a procedure. */
const MIN_STEPS = 2;

const DOCREF_RE = /\b((?:SOP|WI|QAP|PROC)[-\s]?\d{1,5})\b/i;

/** Normalize a detected handle to a canonical "SOP-102" shape. */
function normalizeDocRef(raw: string): string {
  return raw.replace(/\s+/g, "-").replace(/-+/g, "-").toUpperCase();
}

/**
 * Parse SOP text into a Section→Step tree.
 * Returns null when the text has no recognizable section structure.
 */
export function parseSop(text: string): ParsedSop | null {
  const lines = text.split("\n");

  // --- header scan: doc ref + title from the first few non-empty lines ------
  let docRef: string | null = null;
  let title: string | null = null;
  const head = lines.filter((l) => l.trim().length > 0).slice(0, 6);
  for (const line of head) {
    if (!docRef) {
      const m = DOCREF_RE.exec(line);
      if (m) docRef = normalizeDocRef(m[1]);
    }
    // The title is the first substantial line that is not itself a heading.
    if (!title) {
      const t = line.trim();
      if (t.length > 3 && !SECTION_RE.test(t) && !STEP_RE.test(t)) {
        // Strip a leading "SOP-102:" prefix so the title reads cleanly.
        title = t.replace(/^\s*(?:SOP|WI|QAP|PROC)[-\s]?\d{1,5}\s*[:\-–]\s*/i, "").trim();
      }
    }
  }

  // --- body walk ------------------------------------------------------------
  const sections: SopSection[] = [];
  let section: SopSection | null = null;
  let step: SopStep | null = null;

  /** Close the open step (if any) into the open section. */
  const flushStep = (): void => {
    if (section && step) section.steps.push(step);
    step = null;
  };
  /** Close the open section into the result. */
  const flushSection = (): void => {
    flushStep();
    if (section) sections.push(section);
    section = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // A step must be tested BEFORE a section: "4.1 Verify..." also matches the
    // looser section pattern on its leading "4", and step wins.
    // A step is an instruction: a "2.1" that heads a few words of text. A bare
    // figure that merely starts a line ("4.5 s", "13.1 kg") is not a step.
    const stepMatch = STEP_RE.exec(line);
    if (stepMatch && section && stepMatch[2].split(/\s+/).length >= MIN_STEP_WORDS) {
      flushStep();
      step = { stepNo: stepMatch[1], text: stepMatch[2] };
      continue;
    }

    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      flushSection();
      section = {
        sectionNo: sectionMatch[1],
        title: sectionMatch[2],
        intro: "",
        steps: [],
      };
      continue;
    }

    // Continuation text: attach to the open step, else the section intro, else
    // an implicit preamble section so nothing before section 1 is lost.
    if (step) {
      step.text = `${step.text} ${line}`;
    } else if (section) {
      section.intro = section.intro ? `${section.intro} ${line}` : line;
    } else {
      if (sections.length === 0 && !section) {
        section = { sectionNo: "0", title: "Preamble", intro: line, steps: [] };
      }
    }
  }
  flushSection();

  // Structure check: a real SOP has at least one NUMBERED section (the synthetic
  // "0 / Preamble" bucket does not count). Otherwise this is ordinary prose and
  // the caller should chunk it as such rather than inventing a hierarchy.
  const realSections = sections.filter((s) => s.sectionNo !== "0");
  if (realSections.length === 0) return null;
  // A procedure is made of steps: at least MIN_STEPS of them, in at least half
  // of its sections. A report with numbered headings ("1. What was tested") and
  // no steps is prose, and is chunked as prose rather than as a fake tree.
  const steps = realSections.reduce((n, s) => n + s.steps.length, 0);
  const withSteps = realSections.filter((s) => s.steps.length > 0).length;
  if (steps < MIN_STEPS || withSteps * 2 < realSections.length) return null;

  return { docRef, title, sections };
}

/**
 * Render the text that gets embedded for a step.
 *
 * The step is embedded WITH its section heading prepended. This is the cheap
 * half of "a step in its proper context": it makes the chunk self-describing,
 * so "verify with an approved detector" still matches a query about *isolation*
 * even though the word only appears in the parent heading. The expensive half —
 * returning the parent section alongside the hit at query time — is handled by
 * the parent_chunk_id edge in retrieval.
 */
export function stepEmbedText(section: SopSection, step: SopStep, docTitle?: string | null): string {
  const head = [docTitle, `Section ${section.sectionNo}: ${section.title}`]
    .filter(Boolean)
    .join(" — ");
  return `${head} / Step ${step.stepNo}: ${step.text}`;
}

/** Render the text embedded for a section node (heading + its own narrative). */
export function sectionEmbedText(section: SopSection, docTitle?: string | null): string {
  const head = [docTitle, `Section ${section.sectionNo}: ${section.title}`]
    .filter(Boolean)
    .join(" — ");
  return section.intro ? `${head}. ${section.intro}` : head;
}
