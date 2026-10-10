/**
 * Citation suite (golden-eval change 7) — pure, no DB / LLM.
 *
 * Pins: only the sources the answer cites are returned; markers become
 * readable "POID-….pdf p.N" labels; markers pointing at no source are dropped
 * (never rendered as a fake citation).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCitations, citedSources, marker, sourceLabel } from "../src/retrieval/citations";
import { RetrievalHit } from "../src/retrieval/hybrid";

function hit(poid: string, page: string, section: string): RetrievalHit {
  const citation = { sopId: poid, sectionPath: section, poid, jobId: "PH2026100000", page };
  return {
    id: `${poid}-${page}`, sopId: poid, sectionPath: section, question: null, answer: null,
    verdict: null, site: null, vendor: null, content: "", score: 0,
    poid, jobId: "PH2026100000", page, citation,
  };
}

const HITS = [
  hit("POID-4547081947", "2", "Basic Details > Vendor Name"),
  hit("POID-4552466107", "7", "Characteristics > Cable Rewinding on Drum > Drum Length"),
  hit("POID-4547081947", "6", "Characteristics > Acceptance Tests > Oxygen Index"),
];

test("markers are S1-based", () => {
  assert.equal(marker(0), "S1");
});

test("label uses the golden set's form", () => {
  assert.equal(sourceLabel(HITS[0].citation), "POID-4547081947.pdf p.2");
  assert.equal(sourceLabel({ sopId: "demo:x.xlsx", sectionPath: null }), "demo:x.xlsx");
});

test("only cited sources are returned, in order of first appearance", () => {
  const r = renderCitations("Vendor is KEI [S1]; OI 31.5% [S3]. Again [S1].", HITS);
  assert.deepEqual(r.cited, [0, 2]);
  assert.deepEqual(
    citedSources(HITS, r.cited).map((c) => c.poid + " p." + c.page),
    ["POID-4547081947 p.2", "POID-4547081947 p.6"]
  );
});

test("markers are rewritten as readable labels", () => {
  const r = renderCitations("KEI Industries Ltd. [S1].", HITS);
  assert.equal(r.text, "KEI Industries Ltd. [POID-4547081947.pdf p.2].");
});

test("grouped markers in one bracket: [S1, S3], [S1; S2], [Source 2]", () => {
  assert.deepEqual(renderCitations("x [S1, S3]", HITS).cited, [0, 2]);
  assert.deepEqual(renderCitations("x [S2; S1]", HITS).cited, [1, 0]);
  assert.deepEqual(renderCitations("x [Source 2]", HITS).cited, [1]);
  assert.equal(renderCitations("x [S1, S3]", HITS).text, "x [POID-4547081947.pdf p.2; POID-4547081947.pdf p.6]");
});

test("a marker that points at no source is dropped, not rendered", () => {
  const r = renderCitations("Value is 5 [S9].", HITS);
  assert.deepEqual(r.cited, []);
  assert.equal(r.text, "Value is 5.");
});

test("an answer with no markers cites nothing (the old code cited everything)", () => {
  const r = renderCitations("The documents do not record an ambient temperature.", HITS);
  assert.deepEqual(r.cited, []);
});

test("other bracketed text is left alone", () => {
  assert.equal(renderCitations("See [note] here [S2]", HITS).text, "See [note] here [POID-4552466107.pdf p.7]");
});
