/**
 * A chat turn uses the earlier turns only when the new question needs them.
 * The cases below are the ones testers reported: a question that stands on its
 * own was being narrowed to whatever report came up in the turn before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSelfContained } from "../src/retrieval/followUp";

const standalone = (m: string, namesOwnEntity = false) =>
  assert.equal(isSelfContained(m, namesOwnEntity), true, `expected to stand alone: ${m}`);
const needsHistory = (m: string, namesOwnEntity = false) =>
  assert.equal(isSelfContained(m, namesOwnEntity), false, `expected to need history: ${m}`);

test("the reported failure: a corpus-wide count asked as a later turn", () => {
  // Asked as turn 2 after a turn about one report, this was rewritten into
  // "vendors covered in reports other than 4562922674" and answered "2".
  standalone("how many different vendors are covered?");
  standalone("How many reports per vendor");
  standalone("how many distinct purchase orders do these reports cover?");
  standalone("Which reports have SA 8000 compliance marked Not Ok?");
  standalone("How many AEML engineers were involved, and who covered the most reports?");
});

test("'different' does not make a question a contrastive follow-up", () => {
  // The rewriter's rule for "the other / another / a different ONE" was firing
  // on the adjective in "how many different vendors".
  standalone("how many different vendors are covered?");
  standalone("Does any PO number show up under two different vendors?");
});

test("a question that names its own report stands alone", () => {
  standalone("in report 4562922674: which points are not compliant?", true);
  standalone("give me list of IIM Ahmedabad site reports", true);
  standalone("List the checks that failed in the L&T mini pillar report.", true);
});

test("an elliptical follow-up keeps its history", () => {
  needsHistory("which points are not compliant?");
  needsHistory("what about the cables?");
  needsHistory("how much percentage this report is compliant?");
  needsHistory("and for Polycab?");
  needsHistory("was it cleared for dispatch?");
  needsHistory("what about the other one?");
  needsHistory("show me the same for the previous report");
});

test("a pronoun keeps history even when a report is named", () => {
  needsHistory("does it also cover POID-4504515691?", true);
});

test("'that' as a plain conjunction is not a reference", () => {
  // "...a declaration that the material is rejected" points at nothing earlier.
  standalone("How many lots carry a declaration that the material is rejected, and whose are they?");
});

test("a global quantifier is enough on its own", () => {
  standalone("list every check that failed in any report");
});

test("'of them' still points back at a set discussed earlier", () => {
  needsHistory("list everything that failed across all of them");
});

test("'these reports' means everything held, not an earlier one", () => {
  standalone("how many distinct purchase orders do these reports cover?");
  needsHistory("what else was wrong in these checks?");
});
