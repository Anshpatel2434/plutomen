/**
 * Data engine — the parts that need no database and no model.
 *
 *   buildFacts     a real demo report becomes one report row + one row per item
 *   guardSql       model-written SQL: what is allowed, and what is refused
 *   parsePlan      reading the model's reply (LOOKUP, or titled sql blocks)
 *   inventedNumbers / citationsFrom   the answer may only use the database's figures
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { resolve } from "path";
import { parseWorkbookBuffer } from "../src/ingestion/parseXlsx";
import { chunkReport } from "../src/ingestion/chunk";
import { buildFacts } from "../src/data/buildFacts";
import { guardSql, MAX_ROWS } from "../src/data/sqlGuard";
import { parsePlan, inventedNumbers, citationsFrom, renderTable, DataTable } from "../src/data/dataEngine";

import { closePool } from "../src/db";
import { cacheClient } from "../src/cache";

const DEMO = resolve(__dirname, "..", "..", "demo_data");

// Importing the engine opens the pool and the Redis client; nothing here uses
// them, so release both or the test process never exits.
after(async () => {
  cacheClient.disconnect();
  await closePool();
});

// --- buildFacts ---------------------------------------------------------------

test("a report becomes one report row and one row per recorded item", async () => {
  // LT_Power_Cables (2).xlsx is the KEI report (POID-4547081947 / PH2026100008).
  const report = await parseWorkbookBuffer(readFileSync(resolve(DEMO, "LT_Power_Cables (2).xlsx")));
  const { metadata } = chunkReport(report);
  const pages = new Map([["Characteristics > Acceptance Tests > IR Test", "5"]]);
  const f = buildFacts(report, metadata, { reportId: "POID-4547081947", jobId: "PH2026100008" }, pages);

  assert.equal(f.report.reportId, "POID-4547081947");
  assert.equal(f.report.vendor, "KEI Industries Ltd.");
  assert.equal(f.report.reportType, "LT_Power_Cables");
  assert.equal(f.report.inspectionDate, "2026-08-12");
  assert.equal(f.report.testResultsResult, "FAIL"); // "Not Ok"
  assert.equal(f.report.clearanceResult, "CONDITIONAL"); // "Subject to rectification of minor defects"

  // Every sheet row is an item, in order, with nothing dropped.
  const expected = report.basicDetails.length + report.characteristics.length + report.observations.length + 3;
  assert.equal(f.items.length, expected);
  assert.deepEqual(f.items.map((i) => i.position), f.items.map((_, i) => i));

  // Golden Q13: 4 of the 15 Acceptance Tests did not pass (3 failed, 1 pending).
  const tests = f.items.filter((i) => i.area === "Characteristics" && i.section === "Acceptance Tests");
  assert.equal(tests.length, 15);
  assert.equal(tests.filter((i) => i.result === "FAIL").length, 3);
  assert.equal(tests.filter((i) => i.result === "CONDITIONAL").length, 1);
  assert.equal(tests.find((i) => i.item === "IR Test")?.page, "5");

  // Facts about the lot are never counted as checks.
  assert.ok(f.items.filter((i) => i.area === "Basic Details").every((i) => i.result === null));
  assert.equal(f.items.find((i) => i.item === "SAP Code")?.area, "Basic Details");

  // The tally counts checks only, and adds up.
  const r = f.report;
  assert.equal(r.itemsChecked, r.itemsPassed + r.itemsFailed + r.itemsConditional);
  assert.ok(r.itemsChecked > 0 && r.itemsChecked <= report.characteristics.length);
});

// --- guardSql ------------------------------------------------------------------

const ok = (sql: string) => {
  const g = guardSql(sql);
  assert.ok(g.ok, `expected allowed: ${sql} -> ${!g.ok ? g.reason : ""}`);
  return g.ok ? g.sql : "";
};
const refused = (sql: string) => assert.equal(guardSql(sql).ok, false, `expected refused: ${sql}`);

test("ordinary reporting queries are allowed and capped", () => {
  const wrapped = ok("SELECT vendor, count(*) AS reports FROM inspection_reports GROUP BY vendor ORDER BY reports DESC;");
  assert.ok(wrapped.endsWith(`LIMIT ${MAX_ROWS}`));
  ok(`SELECT vendor, SUM(items_failed) AS failed, ROUND(100.0 * SUM(items_passed) / NULLIF(SUM(items_checked), 0), 1) AS "Pass rate"
        FROM inspection_reports WHERE vendor ILIKE '%polycab%' GROUP BY vendor`);
  ok(`WITH f AS (SELECT report_id, count(*) AS n FROM inspection_items WHERE result IN ('FAIL','CONDITIONAL') GROUP BY report_id)
      SELECT r.report_id, r.job_id, r.vendor, f.n FROM inspection_reports r JOIN f ON f.report_id = r.report_id ORDER BY f.n DESC LIMIT 5`);
  ok("SELECT EXTRACT(month FROM inspection_date) AS month, count(*) FROM inspection_reports GROUP BY 1");
  ok("SELECT report_id, item, value FROM inspection_items WHERE note ILIKE '%; drop table%' AND result IS DISTINCT FROM 'PASS'");
});

test("anything that is not one read-only SELECT over the inspection tables is refused", () => {
  refused("DELETE FROM inspection_items");
  refused("SELECT 1; DROP TABLE chunks");
  refused("SELECT * FROM chunks");
  refused("SELECT * FROM inspection_reports r JOIN audit a ON true");
  refused("SELECT * FROM inspection_reports, messages");
  refused("SELECT * FROM public.documents");
  refused('SELECT * FROM "chunks"');
  refused("SELECT * INTO copy_of FROM inspection_reports");
  refused("SELECT report_id FROM inspection_reports -- all of them");
  refused("SELECT 1"); // reads no inspection table
  refused("UPDATE inspection_reports SET vendor = 'x'");
});

test("reaching for another tenant or the server is refused", () => {
  refused("SELECT set_config('app.tenant_id', 'other-tenant', true), report_id FROM inspection_reports");
  refused("SELECT current_setting('app.tenant_id') FROM inspection_reports");
  refused("SELECT pg_sleep(60) FROM inspection_reports");
  refused("SELECT pg_read_file('/etc/passwd') FROM inspection_reports");
  refused("SELECT * FROM pg_roles");
  refused("SELECT * FROM information_schema.tables");
  refused("SELECT lo_import('/etc/passwd') FROM inspection_reports");
  refused("SELECT dblink('host=x', 'select 1') FROM inspection_reports");
  refused("SELECT report_id FROM inspection_reports WHERE vendor = $$x$$");
});

// --- parsePlan -----------------------------------------------------------------

test("the model's reply is LOOKUP or up to three titled queries", () => {
  assert.deepEqual(parsePlan("LOOKUP"), { route: "lookup" });
  assert.deepEqual(parsePlan("This asks for one value.\nLOOKUP"), { route: "lookup" });

  const one = parsePlan("TITLE: Reports per vendor\n```sql\nSELECT vendor, count(*) FROM inspection_reports GROUP BY 1\n```");
  assert.equal(one.route, "data");
  assert.deepEqual(one.route === "data" && one.queries.map((q) => q.title), ["Reports per vendor"]);

  const many = parsePlan(
    ["TITLE: a", "```sql", "SELECT 1 FROM inspection_reports", "```", "TITLE: b", "```sql", "SELECT 2 FROM inspection_reports", "```",
     "```sql", "SELECT 3 FROM inspection_reports", "```", "```sql", "SELECT 4 FROM inspection_reports", "```"].join("\n")
  );
  assert.equal(many.route === "data" && many.queries.length, 3);
  assert.equal(many.route === "data" && many.queries[2].title, "Result 3");

  const bare = parsePlan("SELECT count(*) FROM inspection_reports");
  assert.equal(bare.route, "data");
});

// --- wording the result ----------------------------------------------------------

const TABLE: DataTable = {
  title: "Failed tests per vendor",
  sql: "",
  columns: ["report_id", "job_id", "vendor", "item", "failed", "page"],
  rows: [
    { report_id: "POID-4547081947", job_id: "PH2026100008", vendor: "KEI Industries Ltd.", item: "IR Test", failed: "3", page: "5" },
    { report_id: "POID-4504515691", job_id: "PH2026100010", vendor: "Polycab India Ltd.", item: "IR Test", failed: "1", page: "5" },
    { report_id: "POID-4504515691", job_id: "PH2026100010", vendor: "Polycab India Ltd.", item: "Tensile", failed: "1", page: "5" },
  ],
};

test("a figure the database did not produce is caught", () => {
  assert.deepEqual(inventedNumbers("KEI has 3 failed tests and Polycab 1, across 3 rows.", [TABLE], "How many failed?"), []);
  assert.deepEqual(inventedNumbers("That is a 75% failure rate.", [TABLE], "How many failed?"), ["75"]);
  // A figure the user typed is theirs, not the model's.
  assert.deepEqual(inventedNumbers("None of the 15 tests is listed.", [TABLE], "Which of the 15 tests failed?"), []);
  // Identifiers in the rows are not "invented".
  assert.deepEqual(inventedNumbers("See POID-4547081947 (PH2026100008), page 5.", [TABLE], "?"), []);
});

test("citations come from the rows: one per report page", () => {
  const c = citationsFrom([TABLE]);
  assert.deepEqual(c.map((x) => [x.poid, x.page]), [["POID-4547081947", "5"], ["POID-4504515691", "5"]]);
  assert.equal(c[0].jobId, "PH2026100008");
  // An aggregate (no report_id column) cites nothing.
  assert.deepEqual(citationsFrom([{ title: "t", sql: "", columns: ["vendor", "n"], rows: [{ vendor: "x", n: 2 }] }]), []);
});

test("a result table is shown to the model row by row, with its size", () => {
  const text = renderTable(TABLE);
  assert.match(text, /^Failed tests per vendor \(3 rows\)/);
  assert.match(text, /report_id: POID-4547081947 \| job_id: PH2026100008/);
  assert.match(renderTable({ ...TABLE, rows: [] }), /\(no rows\)/);
});
