/**
 * Chunker coverage suite (pure — reads a demo workbook, no DB / Ollama).
 *
 * Guards golden-eval change 2: Basic Details and report details must become
 * searchable chunks, not just filter metadata. The values asserted here are
 * the gold answers for Q19 (prepared by / started on), Q29 (PO number) and
 * Q38 (vendor engineer) for the Finolex report.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { parseWorkbookBuffer } from "../src/ingestion/parseXlsx";
import { chunkReport } from "../src/ingestion/chunk";

const DEMO = resolve(__dirname, "..", "..", "demo_data");

async function chunksOf(file: string) {
  const report = await parseWorkbookBuffer(await readFile(resolve(DEMO, file)));
  return chunkReport(report).chunks;
}

test("report details become one searchable chunk (Q19)", async () => {
  const chunks = await chunksOf("LT_Power_Cables (3).xlsx");
  const details = chunks.filter((c) => c.sectionPath === "Report Details");
  assert.equal(details.length, 1, "exactly one report-details chunk");
  assert.match(details[0].content, /Started by: Dhruvit/);
  assert.match(details[0].content, /Started On: Aug 12, 2026, 01:12 PM/);
  assert.equal(details[0].verdict, null);
});

test("every Basic Details row becomes a chunk (Q29, Q38)", async () => {
  const chunks = await chunksOf("LT_Power_Cables (3).xlsx");
  const basic = chunks.filter((c) => c.sectionPath.startsWith("Basic Details > "));
  const titles = basic.map((c) => c.question);
  for (const t of ["SAP Code", "Vendor Name", "PO Details", "Vendor Engineer & Designation", "Batch Nos"]) {
    assert.ok(titles.includes(t), `missing Basic Details chunk for ${t}`);
  }
  const po = basic.find((c) => c.question === "PO Details")!;
  assert.match(po.content, /4500160123 dated 18-Jul-2026/);
  const eng = basic.find((c) => c.question === "Vendor Engineer & Designation")!;
  assert.match(eng.content, /Amit Verma, Quality Engineer/);
  assert.ok(basic.every((c) => c.verdict === null), "facts never carry a verdict");
});

test("section path does not repeat 'Basic Details'", async () => {
  const chunks = await chunksOf("LT_Mini_Pillar (1).xlsx");
  const sap = chunks.find((c) => c.question === "SAP Code")!;
  assert.equal(sap.sectionPath, "Basic Details > SAP Code");
});

test("conclusion notes are searchable (Q11, Q36)", async () => {
  // LT_Mini_Pillar.xlsx = job PH2026100009 (Q11).
  const q11 = await chunksOf("LT_Mini_Pillar.xlsx");
  const tr = q11.find((c) => c.sectionPath === "Inspection Conclusion > Test Results");
  assert.ok(tr);
  assert.match(tr.content, /Test Results: Not Ok - Lot not meeting QAP acceptance criteria\./);
  assert.equal(tr.answer, "Not Ok", "answer stays the recorded value (PDF page lookup keys on it)");

  // LT_Power_Cables (4).xlsx = Finolex job PH2026100004 (Q36).
  const q36 = await chunksOf("LT_Power_Cables (4).xlsx");
  const tc = q36.find((c) => c.sectionPath === "Inspection Conclusion > Technical Clearance");
  assert.ok(tc);
  assert.match(tc.content, /Subject to rectification or not cleared for dispatch\./);
});

test("a conclusion note never changes the verdict", async () => {
  // Test Results "Not Ok" with the contradicting note "All acceptance tests Pass".
  const chunks = await chunksOf("LT_Mini_Pillar (5).xlsx");
  const tr = chunks.find((c) => c.sectionPath === "Inspection Conclusion > Test Results");
  assert.ok(tr);
  assert.match(tr.content, /All acceptance tests Pass/);
  assert.equal(tr.verdict, "NOT OK");
});
