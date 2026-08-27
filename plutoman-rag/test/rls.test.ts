/**
 * Automated Row-Level Security (RLS) test suite — runs on every build.
 *
 * PROVES tenant isolation end-to-end against the REAL database, connecting as
 * the least-privilege app role (whatever DATABASE_URL points at — in Phase-2
 * that is PgBouncer -> Postgres). It exercises the same withTenant() path the
 * app uses, so a regression in RLS policies, grants, or the tenant-GUC wiring
 * fails the build.
 *
 * PREREQUISITES (see README): a running DB with migrations applied:
 *     docker compose up -d && npm run migrate
 * Then: npm test
 *
 * The suite is self-contained and idempotent: it uses dedicated throwaway
 * tenants (`rlstest-a`, `rlstest-b`), seeds via withTenant (which also proves
 * INSERT WITH CHECK), and removes all rlstest-* rows in an after() hook.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { withTenant, query, closePool } from "../src/db";

const TENANT_A = "rlstest-a";
const TENANT_B = "rlstest-b";
const DOC_A = "rlstest-a-doc-1";
const DOC_B = "rlstest-b-doc-1";

/** Insert a documents row for `tenant` via withTenant (idempotent). */
async function seedDoc(tenant: string, mongoId: string): Promise<void> {
  await withTenant(tenant, async (client) => {
    await client.query(
      `INSERT INTO documents (tenant_id, mongo_id, type, title, status)
       VALUES ($1, $2, 'rlstest', 'RLS test doc', 'Completed')
       ON CONFLICT (tenant_id, mongo_id) DO NOTHING`,
      [tenant, mongoId]
    );
  });
}

/** Delete all rlstest-* rows for `tenant` via withTenant (stays in the RLS model). */
async function cleanupTenant(tenant: string): Promise<void> {
  await withTenant(tenant, async (client) => {
    // chunks would cascade from documents, but this tenant only seeds documents.
    await client.query(`DELETE FROM documents WHERE tenant_id = $1`, [tenant]);
  });
}

before(async () => {
  // Seeding through withTenant with the correct tenant GUC proves INSERT WITH
  // CHECK accepts a matching tenant_id (the negative case is asserted below).
  await seedDoc(TENANT_A, DOC_A);
  await seedDoc(TENANT_B, DOC_B);
});

after(async () => {
  await cleanupTenant(TENANT_A);
  await cleanupTenant(TENANT_B);
  await closePool();
});

test("tenant A sees its own doc and NOT tenant B's", async () => {
  const { seesOwn, seesOther } = await withTenant(TENANT_A, async (client) => {
    const own = await client.query(
      `SELECT count(*)::int AS n FROM documents WHERE mongo_id = $1`,
      [DOC_A]
    );
    const other = await client.query(
      `SELECT count(*)::int AS n FROM documents WHERE mongo_id = $1`,
      [DOC_B]
    );
    return { seesOwn: own.rows[0].n as number, seesOther: other.rows[0].n as number };
  });
  assert.equal(seesOwn, 1, "tenant A should see its own seeded doc");
  assert.equal(seesOther, 0, "tenant A must NOT see tenant B's doc");
});

test("tenant B sees 0 of tenant A's docs", async () => {
  const n = await withTenant(TENANT_B, async (client) => {
    const res = await client.query(
      `SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1`,
      [TENANT_A]
    );
    return res.rows[0].n as number;
  });
  assert.equal(n, 0, "tenant B must see none of tenant A's rows");
});

test("no tenant set -> RLS fails CLOSED (0 rows)", async () => {
  // query() runs on a bare pool client with NO app.tenant_id GUC set, so the
  // policy predicate (tenant_id = NULL) matches nothing.
  const res = await query<{ n: number }>(`SELECT count(*)::int AS n FROM documents`);
  assert.equal(res.rows[0].n, 0, "without a tenant set, documents must be invisible");
});

test("INSERT WITH CHECK: tenant A cannot insert a row for tenant B", async () => {
  await assert.rejects(
    () =>
      withTenant(TENANT_A, async (client) => {
        await client.query(
          `INSERT INTO documents (tenant_id, mongo_id, type)
           VALUES ($1, $2, 'rlstest')`,
          [TENANT_B, "rlstest-a-forging-b"]
        );
      }),
    /row-level security|violates|policy/i,
    "inserting a cross-tenant row must be rejected by WITH CHECK"
  );
});

test("cross-tenant UPDATE/DELETE affect 0 rows", async () => {
  const { updated, deleted } = await withTenant(TENANT_B, async (client) => {
    const upd = await client.query(
      `UPDATE documents SET title = 'hacked' WHERE tenant_id = $1`,
      [TENANT_A]
    );
    const del = await client.query(`DELETE FROM documents WHERE tenant_id = $1`, [
      TENANT_A,
    ]);
    return { updated: upd.rowCount ?? 0, deleted: del.rowCount ?? 0 };
  });
  assert.equal(updated, 0, "tenant B must not be able to UPDATE tenant A's rows");
  assert.equal(deleted, 0, "tenant B must not be able to DELETE tenant A's rows");

  // Confirm tenant A's doc still exists and is untouched.
  const stillThere = await withTenant(TENANT_A, async (client) => {
    const res = await client.query(
      `SELECT title FROM documents WHERE mongo_id = $1`,
      [DOC_A]
    );
    return res.rows[0]?.title as string | undefined;
  });
  assert.equal(stillThere, "RLS test doc", "tenant A's row must be intact");
});
