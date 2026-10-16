/**
 * Deterministic answer repairs — pure, no DB / LLM.
 *
 * Each case replays a real answer from the 16 Oct 2026 golden-set run
 * (eval-runs/pod-2026-10-16) that failed its pass criteria:
 *   Q33, Q34 — explained a term no source defines (rule 4), even after the
 *              answer check's retry;
 *   Q18      — right content, cited six "Report Details" chunks instead of
 *              the contents page it came from;
 *   Q06      — leaked the model's note "[S1, S3 do not mention it]".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dropUndefinedExplanations } from "../src/retrieval/verify";
import { reattributeCitations, renderCitations, stripLeftoverMarkers } from "../src/retrieval/citations";
import { RetrievalHit } from "../src/retrieval/hybrid";

function hit(id: string, poid: string, page: string, section: string, content: string): RetrievalHit {
  const citation = { sopId: poid, sectionPath: section, poid, jobId: "PH2026100006", page };
  return {
    id, sopId: poid, sectionPath: section, question: null, answer: null, verdict: null,
    site: null, vendor: null, content, score: 0, poid, jobId: "PH2026100006", page, citation,
  };
}

// --- Q33 / Q34: undefined terms ----------------------------------------------

const OBSERVATIONS = [
  hit("o1", "POID-4504515691", "9", "Inspection Observations > 1.", "Observation 1: Major - Severity elevated; lot disposition pending."),
  hit("o2", "POID-4504515691", "9", "Inspection Observations > 2", "Observation 2: Critical - Requires vendor CAPA and re-inspection."),
];

test("Q33: the explanation of 'Major' is removed, the 'not defined' sentences stay", () => {
  const q = "What does the 'Major' severity mean in the Polycab inspection observations, and how is it different from 'Critical'?";
  const a =
    "In the provided sources, the 'Major' severity in the Inspection Observations for Polycab India Ltd. is used to indicate a more significant issue compared to 'Minor' [S1]. " +
    "However, the reports do not define what 'Major' means specifically. " +
    "The term 'Critical' is mentioned in Report POID-4504515691, but it is not compared to any other severity level in the given sources [S2]. " +
    "Therefore, without additional information, it is not possible to determine how 'Critical' differs from 'Major'.";
  const out = dropUndefinedExplanations(q, a, OBSERVATIONS);
  assert.doesNotMatch(out, /more significant issue/);
  assert.match(out, /^The reports do not define what 'Major' means/);
  assert.match(out, /not compared to any other severity level/);
});

test("Q34: invented expansions of AEML are removed", () => {
  const q = "What does AEML stand for in these reports?";
  const a =
    "The reports do not define what AEML stands for. However, in these reports, AEML appears to be the abbreviation for the Assistant Engineer, Manager, or Executive Engineer responsible for the equipment inspection. " +
    "For example, in the reports from ABB India Limited, AEML stands for Assistant Engineer (Projects) or Senior Engineer (QA). " +
    "In the reports from Polycab India Ltd., AEML stands for Executive Engineer (Inspection).";
  const src = [hit("e", "POID-4507044338", "2", "Basic Details > AEML Engineer & Designation", "AEML Engineer & Designation: R. Shah, AE (Projects)")];
  assert.equal(dropUndefinedExplanations(q, a, src), "The reports do not define what AEML stands for.");
});

test("a definition question is left alone when a source does define the term", () => {
  const q = "What does OI stand for?";
  const a = "OI stands for Oxygen Index [S1].";
  const src = [hit("d", "POID-1", "6", "Notes", "OI stands for Oxygen Index.")];
  assert.equal(dropUndefinedExplanations(q, a, src), a);
});

test("ordinary questions are never touched", () => {
  const a = "The Technical Clearance was Yes, which means the lot was recommended [S1].";
  assert.equal(dropUndefinedExplanations("What was the Technical Clearance?", a, OBSERVATIONS), a);
});

test("an answer that only explains still says the term is undefined", () => {
  const out = dropUndefinedExplanations("What does AEML stand for?", "AEML probably stands for an engineering role.", []);
  assert.equal(out, "The reports do not define this term.");
});

// --- Q18: cite the source the statement came from ------------------------------

const DETAILS =
  "[POID-4507044338 | Job PH2026100006 | Larsen & Toubro Ltd. (Electrical & Automation) | IIM Ahmedabad] Report details — Checklist name: LT_Mini_Pillar; Category: LT; Subcategory: Mini Pillar; Site: IIM Ahmedabad; Started by: Dhruvit; Started On: Aug 12, 2026, 01:23 PM; Status: Completed";
const CONTENTS =
  "[POID-4507044338 | Job PH2026100006 | Larsen & Toubro Ltd. (Electrical & Automation) | IIM Ahmedabad] Report contents (table of content) — sections in order: 1. Basic Details (Basic Details) 2. Characteristics _ Parameter (Visual & Physical Checks; BOM Verification; Fabrication & Manufacturing Quality Checks; Raw Material / Bought out Items TC Verification; Photos Upload; Acceptance Tests as per QAP/IS; Other Compliances for Manufacturing Facility) 3. Inspection Observations (Default) 4. Inspection Conclusion (Inspection Summary)";

const Q18_HITS = [
  hit("d1", "POID-4507044338", "2", "Report Details", DETAILS),
  hit("d2", "POID-4589377670", "2", "Report Details", DETAILS.replace("POID-4507044338", "POID-4589377670")),
  hit("d3", "POID-4562922674", "2", "Report Details", DETAILS.replace("POID-4507044338", "POID-4562922674")),
  hit("toc", "POID-4507044338", "1", "Report Contents", CONTENTS),
];

test("Q18: a list cited to Report Details is re-pointed at the contents page", () => {
  const a =
    "The LT_Mini_Pillar inspection reports contain the following sections, in order: 1. Basic Details 2. Characteristics _ Parameter " +
    "(with subsections: Visual & Physical Checks, BOM Verification, Fabrication & Manufacturing Quality Checks, Raw Material / Bought out Items " +
    "TC Verification, Photos Upload, Acceptance Tests as per QAP/IS, Other Compliances for Manufacturing Facility) 3. Inspection Observations " +
    "(Default) 4. Inspection Conclusion (Inspection Summary) [S1; S2; S3]";
  const fixed = reattributeCitations(a, Q18_HITS);
  const { text, cited } = renderCitations(fixed, Q18_HITS);
  assert.deepEqual(cited, [3]);
  assert.match(text, /\[POID-4507044338\.pdf p\.1\]$/);
});

test("a citation with real support is never moved", () => {
  const a = "The report was started by Dhruvit on Aug 12, 2026, 01:23 PM at IIM Ahmedabad [S1].";
  assert.equal(reattributeCitations(a, Q18_HITS), a);
});

test("short statements are left alone", () => {
  const a = "Yes [S1].";
  assert.equal(reattributeCitations(a, Q18_HITS), a);
});

// --- Q06: leaked marker commentary ---------------------------------------------

test("Q06: a bracket of marker commentary is removed", () => {
  const t =
    "The Polycab 1C x 630 sq.mm lot offered as 5 drums has a sector shaped conductor recorded [POID-4552466107.pdf p.4]. " +
    "The other drum does not have the shape of conductor recorded [S1, S3 do not mention it].";
  const out = stripLeftoverMarkers(t);
  assert.doesNotMatch(out, /\bS\d/);
  assert.match(out, /\[POID-4552466107\.pdf p\.4\]/);
  assert.match(out, /recorded\.$/);
});

test("ordinary brackets and rendered labels are kept", () => {
  const t = "Weight 1980 kg [POID-4504515691.pdf p.7] (Sector shaped) [note].";
  assert.equal(stripLeftoverMarkers(t), t);
});

test("V14: a labelled marker list '[Citations: S1, S2]' becomes citations, not text", () => {
  const { text, cited } = renderCitations("The lot was cleared [Citations: S1, S4].", Q18_HITS);
  assert.deepEqual(cited, [0, 3]);
  assert.equal(text, "The lot was cleared [POID-4507044338.pdf p.2; POID-4507044338.pdf p.1].");
});
