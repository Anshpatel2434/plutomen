/**
 * Phase-3: adversarial isolation test suite (defense in depth).
 *
 * Complements test/rls.test.ts. Covers the SECOND, independent controls added in
 * Phase-3: the explicit per-query tenant predicate, JWT hardening (alg allowlist,
 * expiry, required tenant_id claim), and tenant-namespaced cache keys.
 *
 * PREREQUISITES for the DB-connected case(s) (see README):
 *     docker compose up -d && npm run migrate
 * Then: npm test   (-> tsx --test test/*.test.ts; exits non-zero on failure)
 *
 * The pure auth/cache cases need no DB. DB-connected cases reuse the withTenant()
 * helper and the rlstest-a / rlstest-b seed+cleanup pattern from rls.test.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { withTenant, closePool } from "../src/db";
import { verifyToken } from "../src/auth";
import { buildSearchKey, closeCache } from "../src/cache";
import { config } from "../src/config";

const TENANT_A = "rlstest-a";
const TENANT_B = "rlstest-b";
const DOC_A = "rlstest-a-iso-doc-1";
const DOC_B = "rlstest-b-iso-doc-1";

/** Insert a documents row for `tenant` via withTenant (idempotent). */
async function seedDoc(tenant: string, mongoId: string): Promise<void> {
  await withTenant(tenant, async (client) => {
    await client.query(
      `INSERT INTO documents (tenant_id, mongo_id, type, title, status)
       VALUES ($1, $2, 'isotest', 'isolation test doc', 'Completed')
       ON CONFLICT (tenant_id, mongo_id) DO NOTHING`,
      [tenant, mongoId]
    );
  });
}

/** Remove this suite's rows for `tenant` (stays inside the RLS model). */
async function cleanupTenant(tenant: string): Promise<void> {
  await withTenant(tenant, async (client) => {
    await client.query(
      `DELETE FROM documents WHERE tenant_id = $1 AND type = 'isotest'`,
      [tenant]
    );
  });
}

before(async () => {
  await seedDoc(TENANT_A, DOC_A);
  await seedDoc(TENANT_B, DOC_B);
});

after(async () => {
  await cleanupTenant(TENANT_A);
  await cleanupTenant(TENANT_B);
  await closePool();
  await closeCache();
});

// --- 1) Explicit-predicate sanity (DB-connected) ---------------------------
test("explicit predicate + RLS agree: A querying tenant_id=B sees 0 rows", async () => {
  const n = await withTenant(TENANT_A, async (client) => {
    // Belt-and-suspenders: an explicit cross-tenant predicate under tenant A's
    // GUC must return nothing — the Phase-3 predicate and RLS both filter it out.
    const res = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1`,
      [TENANT_B]
    );
    return res.rows[0].n as number;
  });
  assert.equal(n, 0, "tenant A must see 0 rows when explicitly filtering for tenant B");
});

// --- 2) Auth: alg:none rejected -------------------------------------------
test("auth: alg:none token is rejected", () => {
  const b64url = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const header = b64url({ alg: "none", typ: "JWT" });
  const payload = b64url({ sub: "u", tenant_id: TENANT_A });
  // alg:none tokens carry an empty signature segment.
  const noneToken = `${header}.${payload}.`;
  assert.throws(
    () => verifyToken(noneToken),
    "alg:none must be rejected by the HS256 algorithm allowlist"
  );
});

// --- 3) Auth: expired token rejected --------------------------------------
test("auth: expired token is rejected", () => {
  const expired = jwt.sign(
    { sub: "u", tenant_id: TENANT_A },
    config.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "-1s" }
  );
  assert.throws(() => verifyToken(expired), "expired token must be rejected");
});

// --- 4) Auth: missing tenant_id rejected ----------------------------------
test("auth: token without tenant_id is rejected", () => {
  const noTenant = jwt.sign({ sub: "u" }, config.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: "5m",
  });
  assert.throws(
    () => verifyToken(noTenant),
    "a token with no tenant_id must never authenticate"
  );
});

// --- 5) Auth: valid token maps tenant -------------------------------------
test("auth: valid token maps to the correct tenant", () => {
  const good = jwt.sign(
    { sub: "user-1", tenant_id: TENANT_A, roles: ["viewer"] },
    config.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "5m" }
  );
  const ctx = verifyToken(good);
  assert.equal(ctx.tenantId, TENANT_A, "tenantId must map from the tenant_id claim");
  assert.equal(ctx.userId, "user-1", "userId must map from the sub claim");
  assert.deepEqual(ctx.roles, ["viewer"], "roles must map from the roles claim");
});

// --- 6) Cache key namespacing ---------------------------------------------
test("cache: same query, different tenants -> distinct namespaced keys", () => {
  const q = "steel thickness";
  const keyA = buildSearchKey(TENANT_A, q, undefined, undefined, true);
  const keyB = buildSearchKey(TENANT_B, q, undefined, undefined, true);
  assert.notEqual(keyA, keyB, "different tenants must not share a cache key");
  assert.ok(keyA.includes(TENANT_A), "key A must contain tenant A's id");
  assert.ok(keyB.includes(TENANT_B), "key B must contain tenant B's id");
});
