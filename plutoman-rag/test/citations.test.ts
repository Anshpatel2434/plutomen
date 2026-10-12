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

test("a marker range cites every source in it: [S1-S3], [S1–S2], [S2 to S3]", () => {
  const r = renderCitations("Nothing was marked Not Ok [S1-S3].", HITS);
  assert.deepEqual(r.cited, [0, 1, 2]);
  assert.equal(
    r.text,
    "Nothing was marked Not Ok [POID-4547081947.pdf p.2; POID-4552466107.pdf p.7; POID-4547081947.pdf p.6]."
  );
  assert.deepEqual(renderCitations("x [S1–S2]", HITS).cited, [0, 1]);
  assert.deepEqual(renderCitations("x [S2 to S3]", HITS).cited, [1, 2]);
  assert.deepEqual(renderCitations("x [S3-S1]", HITS).cited, [0, 1, 2]);
});

test("a range past the last source is clamped; one wholly outside is dropped", () => {
  assert.deepEqual(renderCitations("x [S2-S9999]", HITS).cited, [1, 2]);
  const out = renderCitations("x [S7-S9].", HITS);
  assert.deepEqual(out.cited, []);
  assert.equal(out.text, "x.");
});

test("markers written in prose become citations: (S2), sources S1, S3, and S2", () => {
  const a = renderCitations("Drum length is 500 mtr (S2).", HITS);
  assert.deepEqual(a.cited, [1]);
  assert.equal(a.text, "Drum length is 500 mtr [POID-4552466107.pdf p.7].");
  const b = renderCitations("This is based on sources S1, S3, and S2.", HITS);
  assert.deepEqual(b.cited, [0, 2, 1]);
  assert.doesNotMatch(b.text, /\bS\d\b/);
  // "S1" inside an ordinary word or code is left alone.
  assert.equal(renderCitations("Grade S355 steel", HITS).text, "Grade S355 steel");
});

test("Q23: '[S1: quoted text, S3]' keeps the quote and cites both sources", () => {
  const r = renderCitations("One item did not pass [S1: Inspection Conclusion / Test Results: Not Ok, S3].", HITS);
  assert.deepEqual(r.cited, [0, 2]);
  assert.equal(
    r.text,
    "One item did not pass (Inspection Conclusion / Test Results: Not Ok) [POID-4547081947.pdf p.2; POID-4547081947.pdf p.6]."
  );
  assert.doesNotMatch(r.text, /\[S\d/);
  // An ordinary bracket that merely starts like a marker is left alone.
  assert.equal(renderCitations("Grade [S355: steel]", HITS).text, "Grade [S355: steel]");
});
