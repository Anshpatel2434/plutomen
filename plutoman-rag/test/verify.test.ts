/**
 * Answer check (golden-eval change 9) — pure, no LLM / DB.
 *
 * Each case is a real failure seen in golden-set runs with Mistral 7B.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findProblems, isAbstention, isClarification } from "../src/retrieval/verify";
import { renderCitations } from "../src/retrieval/citations";
import { RetrievalHit } from "../src/retrieval/hybrid";
import type { AggregateFact } from "../src/retrieval/facts";

function hit(id: string, question: string, answer: string, verdict: string | null = null): RetrievalHit {
  const citation = { sopId: "POID-1", sectionPath: question, poid: "POID-1", jobId: "PH1", page: "6" };
  return {
    id, sopId: "POID-1", sectionPath: question, question, answer, verdict, site: null, vendor: null,
    content: `[POID-1 | Job PH1] ${question}: ${answer}`, score: 0, poid: "POID-1", jobId: "PH1", page: "6", citation,
  };
}

const OI = hit("a", "FRLS Outer Sheath-Oxygen Index Test", "OI 31.5% – Pass", "OK");
const WB = hit("b", "Verification of Water Blocking construction in conductor", "Water blocking tape present and continuous – OK", "OK");
const TC = hit("c", "Technical Clearance", "Subject to rectification of minor defects - Subject to rectification or not cleared for dispatch.", "CONDITIONAL");
const DECL = hit("d", "Declaration", "I hereby declare ... Lot cleared for dispatch.", "OK");

const problems = (query: string, draft: string, ordered: RetrievalHit[], facts: AggregateFact[] = []) =>
  findProblems({ query, draft, ordered, cited: renderCitations(draft, ordered).cited, facts });

test("Q03: a result word without the recorded value is flagged", () => {
  const p = problems("Oxygen Index result?", 'The result is "Pass" [S1].', [OI]);
  assert.equal(p.length, 1);
  assert.match(p[0], /quote the recorded value exactly.*OI 31\.5% – Pass/);
  assert.deepEqual(problems("Oxygen Index result?", "OI 31.5% – Pass [S1].", [OI]), []);
});

test("Q07: 'OK' instead of 'present and continuous' is flagged", () => {
  const p = problems("Water blocking result?", "It was OK [S1].", [WB]);
  assert.match(p[0], /present and continuous/);
});

test("no citation at all is flagged", () => {
  const p = problems("Footer email?", "The email is admin@phoenix.com.", [OI]);
  assert.ok(p.some((x) => /cites no source/.test(x)));
});

test("a figure that is in no source and not in the question is flagged", () => {
  const p = problems("Oxygen Index result?", "OI 31.5% – Pass [S1], measured at 27 °C.", [OI]);
  assert.ok(p.some((x) => /not in the SOURCES: 27/.test(x)));
  // ...but figures from the question or the complete lists are fine.
  assert.deepEqual(problems("Which of the 15 tests?", "OI 31.5% – Pass [S1]; 15 tests.", [OI]), []);
});

test("Q36: a decision answer that leaves out a conclusion row is flagged", () => {
  const facts: AggregateFact[] = [{
    heading: "Inspection Conclusion (the lot's decision) in Report POID-1 (Job PH1)",
    counts: { total: 2, passed: 1, failed: 0, conditional: 1, noResult: 0 },
    nonPassOnly: false,
    items: [{ hitId: "c", label: "Technical Clearance: Subject to rectification…" }, { hitId: "d", label: "Declaration: …" }],
  }];
  const p = problems("Cleared for dispatch?", "Yes, the lot was cleared for dispatch [S2].", [TC, DECL], facts);
  assert.ok(p.some((x) => /leaves out items.*\[S1\] Technical Clearance/.test(x)));
});

test("Q16: 'not recorded' while a complete list holds the item is flagged", () => {
  const hk = hit("e", "House Keeping", "Not Ok - Oil spill near test bay", "NOT OK");
  const facts: AggregateFact[] = [{
    heading: '"House Keeping" in 1 report',
    counts: { total: 1, passed: 0, failed: 1, conditional: 0, noResult: 0 },
    nonPassOnly: false,
    items: [{ hitId: "e", label: "Report POID-1: Not Ok - Oil spill near test bay (failed)" }],
  }];
  const p = problems("Housekeeping note?", "The sources do not record any note about housekeeping.", [hk], facts);
  assert.equal(p.length, 1);
  assert.match(p[0], /COMPLETE LISTS contain matching items: \[S1\]/);
});

test("correct abstentions and clarifying questions are left alone", () => {
  assert.deepEqual(problems("Ambient temperature?", "The reports do not record the ambient temperature.", [OI]), []);
  const ask = "Three ABB reports match. Which report do you mean, job PH2026100001 or PH2026100003?";
  assert.equal(isClarification(ask), true);
  assert.deepEqual(problems("SAP code?", ask, [OI]), []);
  assert.equal(isAbstention("The lot was cleared [S1]."), false);
});

test("Q07: a cited answer with a side remark 'does not provide' is still checked", () => {
  const ok = hit("f", "Verification of Water Blocking construction in conductor", "Present and continuous along conductor – OK", "OK");
  const draft =
    "The water blocking verification for the Finolex lot did not pass [S1]. " +
    "The report does not provide information about the water blocking verification for any other batch numbers.";
  const p = problems("Water blocking result for batch FX/ARM/260630/21?", draft, [ok]);
  assert.ok(p.some((x) => /Present and continuous along conductor/.test(x)));
});

test("Q23: a bare result 'Not Ok' must be written, not paraphrased", () => {
  const tr = hit("g", "Test Results", "Not Ok", "NOT OK");
  const p = problems("Green light to ship?", "One item did not pass [S1].", [tr]);
  assert.ok(p.some((x) => /"Not Ok"/.test(x)));
  assert.deepEqual(problems("Green light to ship?", "Test Results: Not Ok [S1].", [tr]), []);
});

test("several reports: answer for the one the question names / give each value", () => {
  const a = hit("r1", "SAP Code", "10461550");
  const b = hit("r2", "SAP Code", "10460112");
  const mk = (singledOut: string[]): AggregateFact[] => [{
    heading: '"SAP Code" in 2 reports', counts: { total: 2, passed: 0, failed: 0, conditional: 0, noResult: 2 },
    nonPassOnly: false,
    items: [{ hitId: "r1", label: "Report A: 10461550" }, { hitId: "r2", label: "Report B: 10460112" }],
    pick: { valuesDiffer: true, singledOut },
  }];
  // Nothing names a report and only one value is given -> give each, or ask.
  assert.ok(problems("SAP code?", "It is 10460112 [S2].", [a, b], mk([])).some((x) => /give each report's value/.test(x)));
  assert.deepEqual(problems("SAP code?", "A: 10461550 [S1]; B: 10460112 [S2].", [a, b], mk([])), []);
  // The question names report A but the answer uses B.
  assert.ok(problems("SAP code?", "It is 10460112 [S2].", [a, b], mk(["r1"])).some((x) => /match only \[S1\]/.test(x)));
});

test("Q02: a short value keeps all its figures (PO number AND its date)", () => {
  const po = hit("h", "PO Details", "PO No. 4500134567 dated 01-Jul-2026");
  const p = problems("PO number and date?", "The PO number is 4500134567 and the date is Aug 12, 2026 [S1].", [po]);
  assert.ok(p.some((x) => /PO No\. 4500134567 dated 01-Jul-2026/.test(x)));
});

test("Q35: a related observation in the list must be addressed", () => {
  const fs = hit("i", "Foundation Structure", "Not Ok", "NOT OK");
  const obs = hit("j", "Inspection Observation 3", "Foundation bolt hole pitch matches approved civil drawing");
  const facts: AggregateFact[] = [{
    heading: '"Foundation Structure" in 1 report', counts: { total: 1, passed: 0, failed: 1, conditional: 0, noResult: 0 },
    nonPassOnly: false,
    items: [{ hitId: "i", label: "Report X: Not Ok" }, { hitId: "j", label: "Foundation bolt hole pitch matches", related: true }],
  }];
  const p = problems("Is the foundation structure acceptable?", 'It is "Not Ok" [S1].', [fs, obs], facts);
  assert.ok(p.some((x) => /also has an observation on this item: \[S2\]/.test(x)));
});

test("Q33: explaining a term the sources do not define is flagged", () => {
  const ob = hit("k", "Inspection Observation 1", "Major");
  const q = "What does the 'Major' severity mean, and how is it different from 'Critical'?";
  const p = problems(q, "'Major' indicates a significant issue that requires correction [S1].", [ob]);
  assert.ok(p.some((x) => /do not define this term/.test(x)));
  assert.deepEqual(problems(q, "The reports do not define 'Major'; it is used as a severity [S1].", [ob])
    .filter((x) => /define this term/.test(x)), []);
});

test("Q33: explaining + 'not defined' + no citation is still flagged (not an abstention)", () => {
  const ob = hit("l", "Inspection Observation 1", "Major");
  const q = "What does the 'Major' severity mean, and how is it different from 'Critical'?";
  const draft = "'Major' indicates a significant issue. However, the reports do not provide a definition.";
  assert.ok(problems(q, draft, [ob]).some((x) => /do not define this term/.test(x)));
});

test("Q06: the question names one report -> other reports' values are flagged", () => {
  const a = hit("m1", "shape of conductor", "Non-compacted circular");
  const b = hit("m2", "shape of conductor", "Sector shaped");
  const facts: AggregateFact[] = [{
    heading: '"shape of conductor" in 2 reports', counts: { total: 2, passed: 0, failed: 0, conditional: 0, noResult: 2 },
    nonPassOnly: false,
    items: [{ hitId: "m1", label: "Report A: Non-compacted circular" }, { hitId: "m2", label: "Report B: Sector shaped" }],
    pick: { valuesDiffer: true, singledOut: ["m2"] },
  }];
  const p = problems("Lot offered as 5 drums: shape?", "Sector shaped [S2]; the other report: Non-compacted circular [S1].", [a, b], facts);
  assert.ok(p.some((x) => /leave out the other reports' values \(\[S1\]\)/.test(x)));
  assert.deepEqual(problems("Lot offered as 5 drums: shape?", "Sector shaped [S2].", [a, b], facts), []);
});
