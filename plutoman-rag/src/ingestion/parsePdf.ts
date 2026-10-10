/**
 * PDF twin of an inspection report: document identifiers + printed pages.
 *
 * WHY: the golden evaluation set cites the PDF reports by POID and PRINTED
 * page ("POID-4547081947.pdf p.2"), and scores a citation to the wrong
 * document as a fail. The XLSX exports carry the same values but no POID, no
 * Job ID and no pages. So we keep the XLSX as the source of clean text (PDF
 * text extraction splits words, e.g. "minor d efects") and take from the PDF
 * only what the XLSX lacks:
 *   - poid   : "POID-4523310336" (first line of the cover page)
 *   - jobId  : "PH2026100003"     (cover page, "Job Id")
 *   - the printed page every Title/Observation item sits on.
 *
 * Observed layout (pdf-parse 2.x text, confirmed on all 11 demo PDFs):
 *   - page 1 is an unnumbered cover; every other page has a footer
 *       <checklist name> / "Page: n" / "Page n of N" / "Phoenix | ..."
 *     so "Page 1 of 10" is the 2nd PDF page. Citations use the PRINTED number
 *     and "cover" for the first page.
 *   - items:  "Title : X" then "Answer" or "Input" (value inline after a tab,
 *     or on the following lines), then optional "Note : ...".
 *   - observations: "Observations : 1." then "Answer" then the text.
 *   - section headers: "<name>\tInspection Points: n/n" / "\tPage complete: n%".
 *   - an item can straddle a page break (title on p.2, answer on p.3), so we
 *     track the page of every line and record all pages an item touches.
 */
import { PDFParse } from "pdf-parse";
import { Chunk } from "./chunk";

/** One Title/Observation item as laid out in the PDF. */
export interface PdfItem {
  kind: "title" | "observation";
  title: string;
  value: string;
  note: string;
  /** Printed page labels the item touches, in order ("cover", "2", "3"). */
  pages: string[];
}

export interface ParsedPdf {
  poid: string | null;
  jobId: string | null;
  /** Printed page holding the "Inspection details" block (Prepared by / Started on). */
  detailsPage: string | null;
  items: PdfItem[];
}

interface Line {
  text: string;
  page: string;
}

/**
 * Comparison key: case-insensitive, all dash variants (incl. the U+FFFD the
 * XLSX parser turns into "-") unified, ALL whitespace removed. Removing
 * whitespace is what makes PDF word-splits ("d efects") compare equal.
 */
export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‐-―−�]/g, "-")
    // The XLSX joins multi-select answers with "|" where the PDF shows a space
    // ("Canopy -3mm|Others 2mm- OK" vs "Canopy -3mm Others 2mm- OK").
    .replace(/\|/g, "")
    .replace(/\s+/g, "");
}

const SECTION_HEADER = /\t(Inspection Points|Page complete):/;
const VALUE_MARKER = /^(Answer|Input)\b\s*(.*)$/;

/** Split pages into labelled lines, dropping the repeating footer block. */
function toLines(pages: { num: number; text: string }[]): Line[] {
  const lines: Line[] = [];
  for (const pg of pages) {
    const printed = /Page (\d+) of \d+/.exec(pg.text);
    const label = printed ? printed[1] : "cover";
    const raw = pg.text.split(/\r?\n/);
    for (let i = 0; i < raw.length; i++) {
      const t = raw[i].trim();
      if (!t) continue;
      if (/^Page: \d+$/.test(t) || /^Page \d+ of \d+$/.test(t) || /^Phoenix \|/.test(t)) continue;
      // Footer's first line is the checklist name (one token, e.g.
      // "LT_Mini_Pillar") immediately above "Page: n". Only drop it if it looks
      // like one, so real content can never be swallowed.
      if (i + 1 < raw.length && /^Page: \d+$/.test(raw[i + 1].trim()) && !/\s/.test(t)) continue;
      lines.push({ text: t, page: label });
    }
  }
  return lines;
}

const isMarker = (t: string): boolean =>
  t.startsWith("Title :") ||
  t.startsWith("Note :") ||
  t.startsWith("Observations :") ||
  SECTION_HEADER.test(t) ||
  VALUE_MARKER.test(t);

/** Parse the item stream (Title / Answer|Input / Note, and Observations). */
function parseItems(lines: Line[]): PdfItem[] {
  const items: PdfItem[] = [];
  let i = 0;
  // Collect continuation lines until the next marker; returns text + pages.
  const collect = (start: number, first: string): { text: string; pages: string[]; next: number } => {
    const parts = first ? [first] : [];
    const pages = first ? [lines[start - 1].page] : [];
    let j = start;
    while (j < lines.length && !isMarker(lines[j].text)) {
      parts.push(lines[j].text);
      pages.push(lines[j].page);
      j++;
    }
    return { text: parts.join(" ").trim(), pages, next: j };
  };

  while (i < lines.length) {
    const t = lines[i].text;
    const isTitle = t.startsWith("Title :");
    const isObs = t.startsWith("Observations :");
    if (!isTitle && !isObs) {
      i++;
      continue;
    }
    let title = t.replace(/^(Title|Observations) :\s*/, "").trim();
    const pages = [lines[i].page];
    i++;
    // Long titles wrap onto following lines before the Answer/Input marker
    // ("Tests on HDPE Outer Sheath -1. Density ... 5.\nTensile Strength ...").
    while (i < lines.length && !isMarker(lines[i].text)) {
      title = `${title} ${lines[i].text}`;
      pages.push(lines[i].page);
      i++;
    }

    let value = "";
    if (i < lines.length) {
      const vm = VALUE_MARKER.exec(lines[i].text);
      if (vm) {
        pages.push(lines[i].page);
        i++;
        const got = collect(i, vm[2].trim());
        value = got.text;
        pages.push(...got.pages);
        i = got.next;
      }
    }

    let note = "";
    if (i < lines.length && lines[i].text.startsWith("Note :")) {
      pages.push(lines[i].page);
      i++;
      const got = collect(i, lines[i - 1].text.replace(/^Note :\s*/, ""));
      note = got.text;
      i = got.next;
    }

    items.push({
      kind: isObs ? "observation" : "title",
      title,
      value,
      note,
      pages: [...new Set(pages)],
    });
  }
  return items;
}

/** Extract identifiers + page-tracked items from a report PDF. */
export async function parsePdfBuffer(buffer: Buffer): Promise<ParsedPdf> {
  const parser = new PDFParse({ data: buffer });
  let pages: { num: number; text: string }[];
  try {
    pages = (await parser.getText()).pages;
  } finally {
    await parser.destroy();
  }

  const cover = (pages[0]?.text ?? "").split(/\r?\n/).map((l) => l.trim());
  const poid = cover.find((l) => /^POID-\d+$/.test(l)) ?? null;
  const jobIdx = cover.findIndex((l) => l === "Job Id");
  const jobId =
    jobIdx >= 0 && /^[A-Z]{2}\d{6,}$/.test(cover[jobIdx + 1] ?? "") ? cover[jobIdx + 1] : null;

  const lines = toLines(pages);
  const detailsPage = lines.find((l) => l.text === "Started on")?.page ?? null;

  return { poid, jobId, detailsPage, items: parseItems(lines) };
}

/** Render an item's pages as a citation label: "4", "2-3", "cover". */
function pageLabel(item: PdfItem): string {
  return item.pages.length > 1 ? `${item.pages[0]}-${item.pages[item.pages.length - 1]}` : item.pages[0];
}

const valuesAgree = (a: string, b: string): boolean => {
  const x = norm(a);
  const y = norm(b);
  return x === y || (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x)));
};

export interface LocateResult {
  /** Printed page label per chunk (aligned with the input), or null. */
  pages: (string | null)[];
  /** Chunks whose title (or observation text) AND value matched a PDF item. */
  matched: number;
  /** Chunks that are expected to be findable in the PDF. */
  total: number;
}

/**
 * Find the printed page of every chunk produced from the XLSX twin.
 *
 * Matching is by normalized Title (or observation text) and the value must
 * agree too — that agreement count is also how we verify the PDF really is the
 * twin of this workbook (a different report on the same template matches
 * titles but not values).
 */
export function locateChunks(pdf: ParsedPdf, chunks: Chunk[]): LocateResult {
  const used = new Set<PdfItem>();
  let matched = 0;
  let total = 0;

  const pages = chunks.map((c): string | null => {
    if (c.sectionPath === "Report Details") return pdf.detailsPage;
    total++;

    if (c.sectionPath.startsWith("Inspection Observations")) {
      const hit = pdf.items.find(
        (it) => it.kind === "observation" && !used.has(it) && valuesAgree(it.value, c.answer)
      );
      if (hit) {
        used.add(hit);
        matched++;
        return pageLabel(hit);
      }
      return null;
    }

    const byTitle = pdf.items.filter(
      (it) => it.kind === "title" && !used.has(it) && norm(it.title) === norm(c.question)
    );
    const exact = byTitle.find((it) => valuesAgree(it.value, c.answer));
    if (exact) {
      used.add(exact);
      matched++;
      return pageLabel(exact);
    }
    // Title found but the value differs (should not happen for a true twin):
    // still place it, but do not count it toward the twin-verification score.
    if (byTitle.length === 1) {
      used.add(byTitle[0]);
      return pageLabel(byTitle[0]);
    }
    return null;
  });

  return { pages, matched, total };
}

/** Minimum share of chunks that must match title+value to accept a PDF twin. */
export const TWIN_MATCH_THRESHOLD = 0.9;
