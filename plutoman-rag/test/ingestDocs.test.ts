/**
 * Free-form document reading — pure, no DB / LLM.
 *
 * Pins the procedure (SOP) detection found in the 19 Oct 2026 upload test: a
 * real SOP is read as Section -> Step; a report PDF with numbered headings and
 * figures at line starts ("4.5 s") is NOT, and falls back to prose passages.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSop } from "../src/ingestion/parseSop";

const SOP = `SOP-207 Cable Drum Handling and Storage

Section 1: Receiving
1.1 Check the drum flange for cracks before unloading.
1.2 Record the drum serial number in the receiving register.

Section 2: Storage
2.1 Store drums upright on a level, drained surface.
2.2 The maximum stacking height for cable drums is two drums.
2.3 Keep drums at least 1.5 metres away from heat sources.

Section 3: Rolling
3.1 Roll drums only in the direction of the arrow on the flange.`;

test("a real SOP is read as sections and steps", () => {
  const sop = parseSop(SOP);
  assert.ok(sop);
  assert.equal(sop!.docRef, "SOP-207");
  const numbered = sop!.sections.filter((s) => s.sectionNo !== "0"); // "0" = the title preamble
  assert.deepEqual(numbered.map((s) => [s.sectionNo, s.steps.length]), [["1", 2], ["2", 3], ["3", 1]]);
  assert.match(numbered[1].steps[1].text, /maximum stacking height for cable drums is two drums/);
});

test("a report with numbered headings and figures is not a procedure", () => {
  const report = `Project Nexus — Golden Set Evaluation
37/40
4.5 s
median time to a full, cited answer
1. What was tested
The Golden Q&A Set covers 22 RAG scenarios with 40 cases.
2. Results by expected behaviour
Answer 29 29 / 29 29 / 29
13.1 s
3. Results by scenario`;
  assert.equal(parseSop(report), null);
});

test("one numbered step is not enough to make a procedure", () => {
  assert.equal(parseSop("1. Scope\n1.1 This note covers cable drums in general use.\n2. Notes\nNothing further."), null);
});
