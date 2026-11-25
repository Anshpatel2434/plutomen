/**
 * "What about the OTHER Finolex job?" — the report already discussed is the one
 * answer that cannot be right, and saying so in the rewritten query excludes
 * nothing. These pin which report gets left out, and the SQL that leaves it out.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { excludedByContrast, EntityCatalog } from "../src/retrieval/entities";
import { filterSql, RetrievalFilters } from "../src/retrieval/hybrid";
import { buildUserMessage } from "../src/retrieval/generate";
import { closePool } from "../src/db";
import { cacheClient } from "../src/cache";

// Importing either module opens the pool and the Redis client; nothing here
// uses them, so release both or the test process never exits.
after(async () => {
  cacheClient.disconnect();
  await closePool();
});

// Job IDs are recognised by their shape (PH…), so the catalogue holds none.
const CATALOG: EntityCatalog = {
  poids: ["POID-4532592980", "POID-4527422406", "POID-4562922674"],
  vendors: ["Finolex Cables Ltd.", "ABB India Limited"],
  reportTypes: ["LT_Power_Cables", "LT_Mini_Pillar"],
};

const turns = (...contents: string[]) => contents.map((content) => ({ content }));

test("the report discussed in the earlier turns is the one excluded", () => {
  const out = excludedByContrast(
    "What about the other Finolex job, who was the vendor engineer there?",
    turns("Who was the vendor for job PH2026100004?", "The vendor for job PH2026100004 was Finolex Cables Ltd."),
    CATALOG
  );
  assert.deepEqual(out.jobIds, ["PH2026100004"]);
});

test("a report named in THIS message is being asked about, not excluded", () => {
  const out = excludedByContrast(
    "and the other Finolex lot, does PH2026100005 say the same?",
    turns("What was the Offered Qty in PH2026100005?"),
    CATALOG
  );
  assert.deepEqual(out.jobIds, []);
});

test("'other' about something that is not a report excludes nothing", () => {
  // Excluding the report here would throw away exactly what was asked for.
  const out = excludedByContrast(
    "any other issues in this report?",
    turns("Which checks failed in PH2026100001?"),
    CATALOG
  );
  assert.deepEqual(out, { jobIds: [], poids: [] });
});

test("nothing to exclude without a contrast, or without an earlier report", () => {
  assert.deepEqual(
    excludedByContrast("who was the vendor engineer?", turns("Tell me about PH2026100004"), CATALOG),
    { jobIds: [], poids: [] }
  );
  assert.deepEqual(excludedByContrast("what about the other job?", turns("hello"), CATALOG), {
    jobIds: [],
    poids: [],
  });
});

test("POIDs are excluded the same way", () => {
  const out = excludedByContrast(
    "and the other cable report?",
    turns("What was recorded in POID-4532592980?"),
    CATALOG
  );
  assert.deepEqual(out.poids, ["POID-4532592980"]);
});

test("the exclusion keeps rows that have no report id at all", () => {
  // Uploaded documents (a procedure, a specification) carry no job_id / poid;
  // `job_id <> ALL(...)` is NULL for them, which would drop them silently.
  const params: unknown[] = [];
  const f: RetrievalFilters = { excludeJobIds: ["PH2026100004"], excludePoids: ["POID-4532592980"] };
  const sql = filterSql(f, params, "$1").join(" AND ");
  assert.match(sql, /job_id IS NULL OR job_id <> ALL/);
  assert.match(sql, /poid IS NULL OR poid <> ALL/);
  assert.deepEqual(params, [["PH2026100004"], ["POID-4532592980"]]);
});

test("no exclusion means no extra SQL", () => {
  assert.deepEqual(filterSql({}, [], "$1"), []);
});

test("the answer step is told not to discuss the report kept out", () => {
  const hit = {
    id: "c1", sopId: "demo:POID-4527422406", sectionPath: "Basic Details", question: null,
    answer: null, content: "Vendor Engineer: Amit Verma, Quality Engineer", score: 1,
    vendor: "Finolex Cables Ltd.", site: null, verdict: null, poid: "POID-4527422406",
    page: "3", jobId: "PH2026100005",
    citation: { sopId: "demo:POID-4527422406", sectionPath: "Basic Details", poid: "POID-4527422406", page: "3" },
  } as unknown as Parameters<typeof buildUserMessage>[1][number];

  const withExclusion = buildUserMessage("who was the vendor engineer there?", [hit], [], [], "", ["PH2026100004"]);
  assert.match(withExclusion, /OTHER THAN PH2026100004/);
  assert.match(withExclusion, /do not state anything about PH2026100004/);

  // No exclusion -> the prompt is exactly what it was before.
  const without = buildUserMessage("who was the vendor engineer there?", [hit], [], [], "");
  assert.equal(without.includes("OTHER THAN"), false);
});
