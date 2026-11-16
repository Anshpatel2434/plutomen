/**
 * Ingest queue ordering: every enqueue is a new job, and only the latest
 * enqueued job for a document writes.
 *
 * Regression: job ids used to be fixed per document (tenant:mongo:action), so
 * BullMQ silently dropped any re-ingest of a document whose previous job was
 * still waiting or retained as completed — updates never reached the index.
 *
 * The first test is pure; the others need Redis + Postgres (migrations
 * applied), like entities.test.ts.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { enqueueIngest, ingestQueue, closeQueue, seqKey } from "../src/ingestion/queue";
import { isSuperseded, ingestDelete } from "../src/ingestion/ingestWorker";
import { withTenant, closePool } from "../src/db";
import { cacheClient, closeCache } from "../src/cache";

const TENANT = "queue-test-tenant";
const DOC = "queue-test-doc";

test("isSuperseded: only a strictly newer enqueued job supersedes", () => {
  assert.equal(isSuperseded(3, 5), true);
  assert.equal(isSuperseded(5, 5), false);
  assert.equal(isSuperseded(6, 5), false); // counter reset (e.g. Redis flushed): apply
  assert.equal(isSuperseded(undefined, 5), false); // inline ingestion: always apply
  assert.equal(isSuperseded(3, null), false);
});

test("enqueueIngest: two enqueues of one document are two jobs", async () => {
  const a = await enqueueIngest({ tenantId: TENANT, mongoId: DOC, action: "delete" });
  const b = await enqueueIngest({ tenantId: TENANT, mongoId: DOC, action: "delete" });
  assert.notEqual(a, b, "second enqueue must not collapse into the first");
  for (const id of [a, b]) {
    const job = await ingestQueue.getJob(id);
    // A running worker may already have processed (and kept) it; either way
    // it must exist as its own job.
    assert.ok(job, `job ${id} exists`);
    await job.remove().catch(() => undefined);
  }
});

async function docExists(): Promise<boolean> {
  return withTenant(TENANT, async (c) => {
    const r = await c.query(`SELECT 1 FROM documents WHERE tenant_id = $1 AND mongo_id = $2`, [
      TENANT,
      DOC,
    ]);
    return (r.rowCount ?? 0) > 0;
  });
}

test("ingestDelete: a superseded job does not write; the latest one does", async () => {
  await withTenant(TENANT, (c) =>
    c.query(
      `INSERT INTO documents (tenant_id, mongo_id, title) VALUES ($1, $2, 'queue test')
       ON CONFLICT (tenant_id, mongo_id) DO NOTHING`,
      [TENANT, DOC]
    )
  );
  await cacheClient.set(seqKey(TENANT, DOC), "5");

  await ingestDelete({ tenantId: TENANT, mongoId: DOC, action: "delete", seq: 3 });
  assert.equal(await docExists(), true, "older job #3 must not delete over newer #5");

  await ingestDelete({ tenantId: TENANT, mongoId: DOC, action: "delete", seq: 5 });
  assert.equal(await docExists(), false, "latest job #5 applies");
});

after(async () => {
  await withTenant(TENANT, (c) =>
    c.query(`DELETE FROM documents WHERE tenant_id = $1`, [TENANT])
  ).catch(() => undefined);
  await cacheClient.del(seqKey(TENANT, DOC)).catch(() => undefined);
  await closeQueue();
  await closePool();
  await closeCache();
});
