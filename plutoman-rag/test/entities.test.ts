/**
 * Entity resolution suite (golden-eval change 5).
 *
 * Pure cases use the demo tenant's real catalog values; the questions are the
 * golden set's own wording. One DB-connected case proves the catalog is
 * tenant-scoped: a tenant can never resolve another tenant's vendors/types.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  EntityCatalog,
  matchEntities,
  matchChatEntities,
  toFilters,
  vendorKeys,
  reportTypeKeys,
  loadCatalog,
} from "../src/retrieval/entities";
import { withTenant, closePool } from "../src/db";
import { invalidateTenant, closeCache } from "../src/cache";

const CATALOG: EntityCatalog = {
  vendors: [
    "ABB India Limited",
    "Kirloskar Electric Company Ltd.",
    "Larsen & Toubro Ltd. (Electrical & Automation)",
    "Siemens Ltd. – Smart Infrastructure",
    "Finolex Cables Ltd.",
    "KEI Industries Ltd.",
    "Polycab India Ltd.",
  ],
  reportTypes: ["LT_Mini_Pillar", "LT_Power_Cables"],
  poids: ["POID-4547081947", "POID-4527422406", "POID-4523310336"],
};
const applied = (q: string) => toFilters(matchEntities(q, CATALOG)).applied;

// --- keys -------------------------------------------------------------------
test("vendor keys: distinctive word + '&' acronym, qualifiers dropped", () => {
  assert.deepEqual(vendorKeys("KEI Industries Ltd."), ["kei"]);
  assert.deepEqual(vendorKeys("Larsen & Toubro Ltd. (Electrical & Automation)"), ["larsen", "l&t"]);
  assert.deepEqual(vendorKeys("Siemens Ltd. – Smart Infrastructure"), ["siemens"]);
});

test("report-type keys include the natural-language forms", () => {
  assert.ok(reportTypeKeys("LT_Mini_Pillar").includes("mini pillar"));
  assert.ok(reportTypeKeys("LT_Power_Cables").includes("power cable"));
});

// --- IDs win -----------------------------------------------------------------
test("job ID in any case becomes the only filter (Q01, Q25)", () => {
  assert.deepEqual(applied("Who is the vendor for job PH2026100008?"), { jobIds: ["PH2026100008"] });
  assert.deepEqual(applied("earthing ok for ph2026100001 pillar??"), { jobIds: ["PH2026100001"] });
});

test("an explicit ID overrides vendor/type (Q36)", () => {
  assert.deepEqual(applied("Was the Finolex lot for job PH2026100004 cleared for dispatch?"), {
    jobIds: ["PH2026100004"],
  });
});

test("POID forms: 'POID-…', 'POID …', and a bare number only if it is a known POID", () => {
  assert.deepEqual(applied("Who prepared POID-4527422406?").poids, ["POID-4527422406"]);
  assert.deepEqual(applied("details of POID 4523310336").poids, ["POID-4523310336"]);
  assert.deepEqual(applied("report 4547081947 vendor").poids, ["POID-4547081947"]);
  // A PO number is ten digits too, but it is not a POID of this tenant.
  assert.equal(applied("price under PO 4500160123?").poids, undefined);
});

// --- vendors / types ---------------------------------------------------------
test("vendor + report type when no ID is named (Q02, Q05)", () => {
  assert.deepEqual(
    applied("For the ABB India mini pillar job where the vendor engineer was Suresh Iyer?"),
    { vendors: ["ABB India Limited"], reportTypes: ["LT_Mini_Pillar"] }
  );
  assert.deepEqual(applied("PO number in the Kirloskar Electric mini pillar report?").vendors, [
    "Kirloskar Electric Company Ltd.",
  ]);
});

test("'L&T' resolves to Larsen & Toubro (Q31); misspelled words do not block a vendor (Q24)", () => {
  assert.deepEqual(applied("Why was the L&T mini pillar lot rejected?").vendors, [
    "Larsen & Toubro Ltd. (Electrical & Automation)",
  ]);
  assert.deepEqual(applied("kei cabel drum lenght verfied??").vendors, ["KEI Industries Ltd."]);
});

test("report type alone, singular or plural (Q09, Q15)", () => {
  assert.deepEqual(applied("Compare the Technical Clearance answers across all six LT_Mini_Pillar reports."), {
    reportTypes: ["LT_Mini_Pillar"],
  });
  assert.deepEqual(applied("Across all the LT power cable reports, which recorded an OI fail?"), {
    reportTypes: ["LT_Power_Cables"],
  });
});

test("two report types named is not a narrowing signal", () => {
  assert.equal(applied("cable entry on the mini pillar").reportTypes, undefined);
});

test("no entity -> no filter (does not narrow ordinary questions)", () => {
  assert.deepEqual(applied("Which tests failed for conductor resistance?"), {});
});

// --- chat turns --------------------------------------------------------------
test("chat: rewrite entities are added for a follow-up (Q39-style)", () => {
  const m = matchChatEntities(
    "and what drum length was verified in it?",
    "drum length verified in POID-4547081947",
    CATALOG
  );
  assert.deepEqual(toFilters(m).applied, { poids: ["POID-4547081947"] });
});

test("chat: contrastive message ignores the rewrite's ID (Q38 'the other Finolex job')", () => {
  const m = matchChatEntities(
    "What about the other Finolex job, who was the vendor engineer there?",
    "vendor engineer of the Finolex job other than PH2026100004",
    CATALOG
  );
  assert.deepEqual(toFilters(m).applied, { vendors: ["Finolex Cables Ltd."] });
});

// --- tenant isolation (DB) ---------------------------------------------------
const T_A = "rlstest-entities-a";
const T_B = "rlstest-entities-b";

after(async () => {
  await withTenant(T_A, (c) => c.query(`DELETE FROM documents WHERE tenant_id = $1`, [T_A]));
  await invalidateTenant(T_A);
  await invalidateTenant(T_B);
  await closePool();
  await closeCache();
});

test("catalog is tenant-scoped: B cannot resolve A's report types or POIDs", async () => {
  await withTenant(T_A, (c) =>
    c.query(
      `INSERT INTO documents (tenant_id, mongo_id, title, poid)
       VALUES ($1, 'ent-doc-1', 'ZZ_Isolation_Probe', 'POID-0000000001')
       ON CONFLICT (tenant_id, mongo_id) DO NOTHING`,
      [T_A]
    )
  );
  await invalidateTenant(T_A);
  await invalidateTenant(T_B);
  const a = await loadCatalog(T_A);
  const b = await loadCatalog(T_B);
  assert.ok(a.reportTypes.includes("ZZ_Isolation_Probe"), "A sees its own report type");
  assert.ok(a.poids.includes("POID-0000000001"), "A sees its own POID");
  assert.ok(!b.reportTypes.includes("ZZ_Isolation_Probe"), "B must not see A's report type");
  assert.ok(!b.poids.includes("POID-0000000001"), "B must not see A's POID");
});
