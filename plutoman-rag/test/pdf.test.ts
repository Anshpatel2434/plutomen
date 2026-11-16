/**
 * PDF twin suite (pure — reads demo files, no DB / Ollama).
 *
 * Guards golden-eval change 1. The golden set cites reports by POID and
 * PRINTED page and scores a citation to the wrong document as a fail, so we
 * pin: identifier extraction, printed-page mapping against the gold set's own
 * Source column, and rejection of a PDF that is not the workbook's twin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { parseWorkbookBuffer } from "../src/ingestion/parseXlsx";
import { chunkReport } from "../src/ingestion/chunk";
import {
  parsePdfBuffer,
  locateChunks,
  pdfOnlyChunks,
  norm,
  TWIN_MATCH_THRESHOLD,
} from "../src/ingestion/parsePdf";

const DEMO = resolve(__dirname, "..", "..", "demo_data");
const load = (f: string) => readFile(resolve(DEMO, f));

// LT_Mini_Pillar (3).xlsx is the ABB report POID-4523310336 / PH2026100003.
const XLSX = "LT_Mini_Pillar (3).xlsx";
const TWIN = "POID-4523310336.pdf";
const OTHER_ABB = "POID-4562922674.pdf"; // same vendor + template, different report

async function chunksAndPages(pdfFile: string) {
  const { chunks } = chunkReport(await parseWorkbookBuffer(await load(XLSX)));
  const pdf = await parsePdfBuffer(await load(pdfFile));
  return { chunks, pdf, loc: locateChunks(pdf, chunks) };
}

test("cover page yields POID and Job ID", async () => {
  const pdf = await parsePdfBuffer(await load(TWIN));
  assert.equal(pdf.poid, "POID-4523310336");
  assert.equal(pdf.jobId, "PH2026100003");
  assert.equal(pdf.detailsPage, "2", "'Started on' block is on printed page 2");
});

test("printed pages match the golden set's Source column (Q05, Q16, Q35)", async () => {
  const { chunks, loc } = await chunksAndPages(TWIN);
  const pageOf = (re: RegExp) => loc.pages[chunks.findIndex((c) => re.test(c.sectionPath))];
  assert.equal(pageOf(/Basic Details > Vendor Engineer/), "2"); // Q05
  assert.equal(pageOf(/Inspection Conclusion > Technical Clearance/), "7"); // Q05
  assert.equal(pageOf(/House Keeping/), "6"); // Q16
  assert.equal(pageOf(/Visual & Physical Checks > Foundation Structure$/), "4"); // Q35
  assert.equal(pageOf(/Inspection Observations > 3/), "6"); // Q35
});

test("every chunk of a true twin is matched and located", async () => {
  const { loc } = await chunksAndPages(TWIN);
  assert.equal(loc.matched, loc.total, "all title+value pairs match");
  assert.ok(loc.pages.every((p) => p !== null), "no chunk left without a page");
});

test("a different report on the same template is NOT accepted as the twin", async () => {
  const { loc } = await chunksAndPages(OTHER_ABB);
  assert.ok(
    loc.matched / loc.total < TWIN_MATCH_THRESHOLD,
    `wrong PDF scored ${loc.matched}/${loc.total}, must stay below the threshold`
  );
});

test("norm() makes PDF word-splits and XLSX separators compare equal", () => {
  assert.equal(norm("Subject to rectification of minor d efects"), norm("Subject to rectification of minor defects"));
  assert.equal(norm("Canopy -3mm|Others 2mm- OK"), norm("Canopy –3mm Others 2mm– OK"));
});

test("chunks are prefixed with POID and Job ID when the twin is known", async () => {
  const report = await parseWorkbookBuffer(await load(XLSX));
  const { chunks } = chunkReport(report, { poid: "POID-4523310336", jobId: "PH2026100003" });
  assert.ok(chunks.every((c) => c.content.startsWith("[POID-4523310336 | Job PH2026100003 | ")));
});

test("table of contents: sections in printed order, on printed page 1 (Q18)", async () => {
  // POID-4507044338 is the golden source for Q18 (an LT_Mini_Pillar report).
  const pdf = await parsePdfBuffer(await load("POID-4507044338.pdf"));
  assert.ok(pdf.contents);
  assert.equal(pdf.contents.page, "1");
  assert.deepEqual(
    pdf.contents.sections.map((s) => s.name),
    ["Basic Details", "Characteristics _ Parameter", "Inspection Observations", "Inspection Conclusion"]
  );
  assert.ok(pdf.contents.sections[1].parts.includes("Acceptance Tests as per QAP/IS"));
});

test("footer contact details are extracted (Q20)", async () => {
  const pdf = await parsePdfBuffer(await load(TWIN));
  assert.ok(pdf.footer);
  assert.equal(pdf.footer.text, "Phoenix | admin@phoenix.com | +91 8341030349");
});

test("PDF-only chunks: contents + footer, with pages and the report prefix", async () => {
  const pdf = await parsePdfBuffer(await load(TWIN));
  const { chunks, pages } = pdfOnlyChunks(pdf, "[POID-4523310336 | Job PH2026100003] ");
  assert.deepEqual(chunks.map((c) => c.sectionPath), ["Report Contents", "Report Footer"]);
  assert.equal(pages.length, 2);
  assert.match(chunks[0].content, /^\[POID-4523310336 \| Job PH2026100003\] Report contents .*1\. Basic Details/);
  assert.match(chunks[1].content, /admin@phoenix\.com \| \+91 8341030349/);
  assert.ok(chunks.every((c) => c.verdict === null));
});
