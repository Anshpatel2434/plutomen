/**
 * Template content shared by several reports is cited once (golden Q18);
 * recorded values are never merged (Q09). Pure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { oneCopyOfTemplates } from "../src/retrieval/templates";
import { RetrievalHit } from "../src/retrieval/hybrid";

function hit(poid: string, sectionPath: string, body: string): RetrievalHit {
  const citation = { sopId: poid, sectionPath, poid, jobId: null, page: "1" };
  return {
    id: `${poid}-${sectionPath}`, sopId: poid, sectionPath, question: null, answer: null, verdict: null,
    site: null, vendor: null, content: `[${poid} | Job X | Vendor] ${body}`, score: 0,
    poid, jobId: null, page: "1", citation,
  };
}

test("identical contents pages of several reports -> one copy, lowest POID", () => {
  const toc = "Report contents (table of content) — sections in order: 1. Basic Details";
  const out = oneCopyOfTemplates([
    hit("POID-4566765203", "Report Contents", toc),
    hit("POID-4507044338", "Report Contents", toc),
    hit("POID-4593151822", "Report Contents", toc),
  ]);
  assert.deepEqual(out.map((h) => h.poid), ["POID-4507044338"]);
});

test("recorded values that happen to be identical are all kept", () => {
  const out = oneCopyOfTemplates([
    hit("POID-4507044338", "Inspection Conclusion > Technical Clearance", "Inspection Conclusion / Technical Clearance: Yes"),
    hit("POID-4523310336", "Inspection Conclusion > Technical Clearance", "Inspection Conclusion / Technical Clearance: Yes"),
  ]);
  assert.equal(out.length, 2);
});

test("different template text (another report type) is kept separately", () => {
  const out = oneCopyOfTemplates([
    hit("POID-4507044338", "Report Contents", "Report contents: 1. Basic Details 2. Characteristics (Visual & Physical Checks)"),
    hit("POID-4504515691", "Report Contents", "Report contents: 1. Basic Details 2. Characteristics (Physical Checks)"),
  ]);
  assert.equal(out.length, 2);
});
