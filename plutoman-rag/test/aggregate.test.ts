/**
 * Complete lists (golden-eval change 4).
 *
 * Planner tests are pure (a fixed catalog). The expansion tests read the demo
 * index (Postgres with the demo reports ingested, like entities.test.ts) and
 * pin the exact counts the golden set expects — e.g. 4 of the 15 KEI
 * Acceptance Tests did not pass (Q13) — plus tenant isolation.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  planAggregation,
  expandAggregation,
  aggregateFor,
  tokens,
  renderFacts,
  singledOutReports,
  AggregateCatalog,
} from "../src/retrieval/aggregate";
import { closePool } from "../src/db";
import { closeCache } from "../src/cache";

const CATALOG: AggregateCatalog = {
  titles: [
    "FRLS Outer Sheath-Oxygen Index Test",
    "FRLS Outer Sheath-Smoke Density",
    "FRLS Outer Sheath -Temperature Index",
    "FRLS Outer Sheath -Flammability Test",
    "Outer Sheath Thickness",
    "Weight of Cable",
    "Technical Clearance",
    "Test Results",
    "Declaration",
    "House Keeping",
  ],
  sections: ["Acceptance Tests", "Acceptance Tests as per QAP/IS", "Physical Checks", "Inspection Conclusion"],
};

test("tokens: stop words dropped, light plural strip", () => {
  assert.deepEqual(tokens("How many of the Acceptance Tests did not pass?"), ["acceptance", "test", "not", "pass"]);
});

test("plan: a section + 'did not pass' -> that section, non-pass only (Q13, Q21)", () => {
  const p = planAggregation("How many of the 15 Acceptance Tests in the KEI cable report did not pass?", CATALOG);
  assert.ok(p);
  assert.deepEqual(p.sections.sort(), ["Acceptance Tests", "Acceptance Tests as per QAP/IS"]);
  assert.equal(p.nonPass, true);
  assert.deepEqual(p.titles, []);
});

test("plan: longest phrase wins, no overlapping second match (Q03)", () => {
  const p = planAggregation("What was the Oxygen Index test result for the KEI cable?", CATALOG);
  assert.ok(p);
  assert.deepEqual(p.titles, ["FRLS Outer Sheath-Oxygen Index Test"]);
});

test("plan: a phrase naming too many titles is ignored ('outer sheath')", () => {
  const p = planAggregation("What was the outer sheath result?", CATALOG);
  assert.equal(p, null);
});

test("plan: titles across reports + intents (Q09, Q15)", () => {
  const q09 = planAggregation("Compare the Technical Clearance answers across all six LT_Mini_Pillar reports.", CATALOG);
  assert.ok(q09);
  assert.deepEqual(q09.titles, ["Technical Clearance"]);
  assert.equal(q09.across, true);
  const q15 = planAggregation("Across all the LT power cable reports, which inspections recorded an Oxygen Index fail?", CATALOG);
  assert.ok(q15);
  assert.equal(q15.nonPass && q15.across, true);
});

test("plan: a one-word title written as one word matches a two-word title ('housekeeping')", () => {
  const p = planAggregation("What note did the inspector record about housekeeping for job PH2026100003?", CATALOG);
  assert.ok(p);
  assert.deepEqual(p.titles, ["House Keeping"]);
});

test("plan: decision questions; ordinary questions plan nothing", () => {
  assert.equal(planAggregation("Was the Finolex lot for job PH2026100004 cleared for dispatch?", CATALOG)?.decision, true);
  assert.equal(planAggregation("Who is the vendor for job PH2026100008?", CATALOG), null);
  assert.equal(planAggregation("What is Polycab India's current share price?", CATALOG), null);
});

// --- against the demo index ---------------------------------------------------

const T = "demo-tenant";

test("Q13: exactly 4 of the 15 KEI Acceptance Tests did not pass (3 failed, 1 pending)", async () => {
  const r = await aggregateFor(
    T,
    "How many of the 15 Acceptance Tests in the KEI Industries cable report did not pass, and which ones?",
    { vendors: ["KEI Industries Ltd."] }
  );
  assert.equal(r.facts.length, 1);
  const f = r.facts[0];
  assert.deepEqual(
    { total: f.counts.total, failed: f.counts.failed, conditional: f.counts.conditional },
    { total: 15, failed: 3, conditional: 1 }
  );
  assert.equal(f.items.length, 4);
  assert.ok(f.items.some((it) => /IR Test/.test(it.label)));
  assert.equal(r.hits.length, 4, "the listed items are the sources");
});

test("Q09: Technical Clearance from all six LT_Mini_Pillar reports", async () => {
  const r = await aggregateFor(T, "Compare the Technical Clearance answers across all six LT_Mini_Pillar reports.", {
    reportTypes: ["LT_Mini_Pillar"],
  });
  assert.equal(r.facts.length, 1);
  assert.equal(r.facts[0].items.length, 6);
  assert.equal(new Set(r.hits.map((h) => h.poid)).size, 6);
});

test("decision question: the whole Inspection Conclusion of the named report (Q36)", async () => {
  const r = await aggregateFor(T, "Was the Finolex lot for job PH2026100004 cleared for dispatch?", {
    jobIds: ["PH2026100004"],
  });
  const conclusion = r.facts.find((f) => /lot's decision/.test(f.heading));
  assert.ok(conclusion);
  const ids = new Set(conclusion.items.map((it) => it.hitId));
  assert.deepEqual(
    r.hits.filter((h) => ids.has(h.id)).map((h) => h.question).sort(),
    ["Declaration", "Technical Clearance", "Test Results"]
  );
  assert.ok(r.hits.every((h) => h.jobId === "PH2026100004"));
});

test("unscoped and not 'across': nothing is expanded", async () => {
  const plan = planAggregation("What was the Weight of Cable?", { titles: ["Weight of Cable"], sections: [] });
  assert.ok(plan);
  const r = await expandAggregation(T, plan, {});
  assert.deepEqual(r, { hits: [], facts: [] });
});

test("tenant isolation: another tenant's lists are empty", async () => {
  const plan = planAggregation("Compare the Technical Clearance across all reports", {
    titles: ["Technical Clearance"],
    sections: [],
  });
  assert.ok(plan);
  const own = await expandAggregation(T, plan, {});
  assert.ok(own.hits.length > 0);
  const other = await expandAggregation("some-other-tenant", plan, {});
  assert.equal(other.hits.length, 0);
});

test("renderFacts: exact tally and one line per item with its marker", async () => {
  const r = await aggregateFor(T, "Which acceptance tests did not pass for job PH2026100010?", {
    jobIds: ["PH2026100010"],
  });
  const lines = renderFacts(r.facts, r.hits);
  assert.match(lines[1], /15 item\(s\): 13 passed, 2 did not pass \(1 failed, 1 conditional/);
  assert.equal(lines.filter((l) => /\[S\d+\]$/.test(l)).length, 2);
});

test("decision vs the report's own failures is a conflict (Q36), a clean clearance is not (Q31)", async () => {
  const q36 = await aggregateFor(T, "Was the Finolex lot for job PH2026100004 cleared for dispatch?", {
    jobIds: ["PH2026100004"],
  });
  const conflict = q36.facts.find((f) => f.conflict);
  assert.ok(conflict, "conflict list present");
  const labels = conflict.items.map((it) => it.label).join(" | ");
  for (const x of [/Ovality/, /Conductor Resistance/, /Hot Set/, /Zinc/, /Major/, /Critical/]) assert.match(labels, x);
  const q31 = await aggregateFor(T, "Why was the L&T mini pillar lot rejected?", {
    vendors: ["Larsen & Toubro Ltd. (Electrical & Automation)"],
    reportTypes: ["LT_Mini_Pillar"],
  });
  assert.equal(q31.facts.some((f) => f.conflict), false);
});

after(async () => {
  await closePool();
  await closeCache();
});


test("singledOutReports: the question's own details name one report (Q05, Q06)", () => {
  const docs = new Map([
    ["a", "vendor engineer: suresh iyer, production in-charge. offered qty: 10 drums / 5000 mtr"],
    ["b", "vendor engineer: deepak joshi. offered qty: 5 drums / 2500 mtr. checked for the lot"],
  ]);
  assert.deepEqual(singledOutReports("Where the vendor engineer was Suresh Iyer, what was it?", docs), ["a"]);
  assert.deepEqual(singledOutReports("For the lot offered as 5 drums, what shape?", docs), ["b"]);
  // Function words do not name a report ("for the" is only in b's free text).
  assert.deepEqual(singledOutReports("What is the SAP code for the ABB inspection?", docs), []);
});

test("Q26: three ABB reports, no detail names one -> values differ, none singled out", async () => {
  const r = await aggregateFor(T, "What is the SAP code for the ABB India mini pillar inspection?", {
    vendors: ["ABB India Limited"],
    reportTypes: ["LT_Mini_Pillar"],
  });
  assert.equal(r.facts.length, 1);
  assert.deepEqual(r.facts[0].pick, { valuesDiffer: true, singledOut: [] });
});

test("Q35: a related observation in the same report joins the item's list", async () => {
  const r = await aggregateFor(T, "In POID-4523310336, is the foundation structure acceptable?", {
    poids: ["POID-4523310336"],
  });
  const related = r.facts[0].items.filter((it) => it.related);
  assert.equal(related.length, 1);
  assert.match(related[0].label, /bolt hole pitch matches approved civil drawing/);
});
