/**
 * Ready-made reports (src/data/reports.ts): what the model asks for is checked
 * against the workspace, and every fixed query passes the same guard as
 * model-written SQL. All pure (no database, no model).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  BREAKDOWN_BY,
  REPORT_NAMES,
  catalogLists,
  columnName,
  parsePick,
  pickSystemPrompt,
  queriesFor,
  resolveNames,
  scopeOf,
  validateCall,
} from "../src/data/reports";
import { DataCatalog } from "../src/data/dataEngine";
import { guardSql } from "../src/data/sqlGuard";
import { pool } from "../src/db";
import { cacheClient } from "../src/cache";

after(async () => {
  await pool.end().catch(() => undefined);
  cacheClient.disconnect();
});

const CAT: DataCatalog = {
  reportIds: [],
  reports: 4,
  firstDate: "2026-01-01",
  lastDate: "2026-02-01",
  vendors: [
    { name: "Acme Pumps Ltd.", reports: 2 },
    { name: "Zenith Valves (India)", reports: 1 },
    { name: "O'Brien & Sons", reports: 1 },
  ],
  sites: ["North Yard"],
  reportTypes: [
    { name: "Pumps", reports: 3 },
    { name: "Valves", reports: 1 },
  ],
  items: [
    { reportType: "Pumps", group: "Basic Details", items: ["Client Engineer & Designation", "Offered Qty", "PO Details", "SAP Code"] },
    { reportType: "Pumps", group: "Characteristics / Acceptance Tests", items: ["Pressure Test", "HV Test", "Operator's check"] },
    { reportType: "Pumps", group: "Characteristics / Packing", items: ["End caps"] },
    { reportType: "Valves", group: "Characteristics / Acceptance Tests", items: ["Hydraulic pressure test at 1.5x", "HV Test"] },
    { reportType: "Valves", group: "Observations", items: ["Observation 1"] },
  ],
  quantities: [{ item: "Offered Qty", units: ["nos"] }],
};
const LISTS = catalogLists(CAT);

test("catalog lists: details, sections and checks are told apart", () => {
  assert.deepEqual(LISTS.details, ["Client Engineer & Designation", "Offered Qty", "PO Details", "SAP Code"]);
  assert.deepEqual(LISTS.sections, ["Acceptance Tests", "Packing"]);
  assert.ok(LISTS.checks.includes("Hydraulic pressure test at 1.5x"));
  assert.ok(!LISTS.checks.includes("Observation 1"));
});

test("names: exact first, else every catalog name that contains it", () => {
  assert.deepEqual(resolveNames("acme", LISTS.vendors), ["Acme Pumps Ltd."]);
  assert.deepEqual(resolveNames("HV test", LISTS.checks), ["HV Test"]);
  assert.deepEqual(resolveNames("pressure test", LISTS.checks), ["Pressure Test"]);
  assert.deepEqual(resolveNames("pressure", LISTS.checks).sort(), ["Hydraulic pressure test at 1.5x", "Pressure Test"]);
  assert.deepEqual(resolveNames("Havells", LISTS.vendors), []);
  assert.deepEqual(resolveNames(42, LISTS.vendors), []);
});

test("a call that names something the workspace does not hold is refused", () => {
  assert.equal(validateCall({ name: "lots", vendors: ["Havells"] }, LISTS), null);
  assert.equal(validateCall({ name: "lots", report_type: "Transformers" }, LISTS), null);
  assert.equal(validateCall({ name: "checks", items: ["Torque test"] }, LISTS), null);
  assert.equal(validateCall({ name: "checks" }, LISTS), null); // nothing to show
  assert.equal(validateCall({ name: "breakdown", by: "colour" }, LISTS), null);
  assert.equal(validateCall({ name: "profit" }, LISTS), null);
  assert.equal(validateCall("lots", LISTS), null);
});

test("a call is normalised to catalog spellings", () => {
  const c = validateCall({ name: "Checks", items: ["hv test", "pressure"], vendor: "zenith", jobs: ["JOB2026000123", "x y; drop"] }, LISTS);
  assert.ok(c);
  assert.deepEqual(c.vendors, ["Zenith Valves (India)"]);
  assert.deepEqual(c.items.sort(), ["HV Test", "Hydraulic pressure test at 1.5x", "Pressure Test"]);
  assert.deepEqual(c.jobs, ["JOB2026000123"]);
  assert.equal(c.only, "all");
  assert.equal(validateCall({ name: "checks", section: "packing" }, LISTS)?.only, "problems");

  const b = validateCall({ name: "breakdown", by: "detail", detail_item: "client engineer" }, LISTS);
  assert.equal(b?.detailItem, "Client Engineer & Designation");
  // A Basic Details item written straight into "by".
  assert.equal(validateCall({ name: "breakdown", by: "SAP Code" }, LISTS)?.detailItem, "SAP Code");
  assert.equal(validateCall({ name: "breakdown" }, LISTS)?.by, "vendor");
  assert.equal(validateCall({ name: "lots", po: "PO No. 4500134567" }, LISTS)?.po, "4500134567");
});

test("the model's reply: JSON, with or without a fence, one report", () => {
  assert.deepEqual(parsePick('{"reports": [{"name": "lots"}]}'), [{ name: "lots" }]);
  assert.deepEqual(parsePick('```json\n{"reports": [{"name": "lots", "vendors": ["Acme"]}]}\n```'), [{ name: "lots", vendors: ["Acme"] }]);
  assert.deepEqual(parsePick('{"reports": []}'), []);
  assert.deepEqual(parsePick("LOOKUP"), []);
  assert.deepEqual(parsePick('{"reports": [{"name": "lots"}'), []);
  assert.equal(parsePick('{"reports": [{"name":"a"},{"name":"b"},{"name":"c"}]}').length, 1);
});

test("every fixed query passes the SQL guard", () => {
  const calls: Record<string, unknown>[] = [
    { name: "lots" },
    { name: "lots", vendors: ["O'Brien"], person: "R. Sharma'; DROP", po: "4500134567", site: "North Yard" },
    { name: "checks", items: ["Operator's check", "HV Test"], vendors: ["Acme"] },
    { name: "checks", section: "Packing", jobs: ["JOB2026000123"], only: "problems" },
    { name: "checks", vendors: ["Zenith"], only: "notes" },
    { name: "recurring", report_type: "Pumps", section: "Acceptance Tests" },
    { name: "observations", report_type: "Valves" },
    { name: "attachments" },
    { name: "lots", test_results: "not_ok", technical_clearance: "yes", declaration: "not_cleared", conflict: true },
    { name: "lots", technical_clearance: "Subject to rectification", declaration: "rejected" },
    { name: "breakdown", by: "detail", detail_item: "Client Engineer" },
    ...Object.keys(BREAKDOWN_BY).map((by) => ({ name: "breakdown", by, report_type: "Pumps" })),
  ];
  const seen = new Set<string>();
  for (const raw of calls) {
    const c = validateCall(raw, LISTS);
    assert.ok(c, JSON.stringify(raw));
    seen.add(c.name);
    const queries = queriesFor(c);
    assert.ok(queries.length > 0);
    for (const q of queries) {
      const g = guardSql(q.sql);
      assert.ok(g.ok, `${q.title}: ${g.ok ? "" : g.reason}\n${q.sql}`);
    }
  }
  assert.deepEqual([...seen].sort(), [...REPORT_NAMES].sort());
});

test("filters: the kind of lot is kept apart from who is asked about", () => {
  const c = validateCall({ name: "checks", items: ["HV Test"], vendors: ["Acme"], report_type: "Pumps" }, LISTS);
  assert.ok(c);
  const s = scopeOf(c);
  assert.equal(s.kind, "report_type = 'Pumps'");
  assert.ok(s.all.includes("vendor IN ('Acme Pumps Ltd.')"));
  // The summary over every lot of the kind does not carry the vendor filter.
  const summary = queriesFor(c)[1].sql;
  assert.ok(!summary.includes("Acme Pumps"));
  assert.equal(scopeOf(validateCall({ name: "lots" }, LISTS)!).all, "TRUE");
  assert.equal(scopeOf(validateCall({ name: "lots" }, LISTS)!).narrowed, false);
  const held = scopeOf(validateCall({ name: "lots", test_results: "Not Ok", technical_clearance: "yes" }, LISTS)!);
  assert.ok(held.narrowed);
  assert.ok(held.all.includes("test_results_result = 'FAIL' AND clearance_result = 'PASS'"));
  // A quote in a name cannot end the literal.
  assert.ok(scopeOf(validateCall({ name: "lots", vendors: ["O'Brien"] }, LISTS)!).all.includes("'O''Brien & Sons'"));
});

test("column names from item names", () => {
  assert.equal(columnName("AEML Engineer & Designation"), "aeml_engineer_designation");
  assert.equal(columnName("3-phase check"), "detail_3_phase_check");
});

test("the picker prompt lists every report and the workspace", () => {
  const p = pickSystemPrompt("Vendors: 'Acme Pumps Ltd.' (2)");
  for (const n of REPORT_NAMES) assert.ok(p.includes(n), n);
  assert.ok(p.includes("Acme Pumps Ltd."));
});
