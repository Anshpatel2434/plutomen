/**
 * Postgres access layer.
 *
 * The golden rule: ALL tenant-scoped data access goes through `withTenant`,
 * which opens a transaction and sets the `app.tenant_id` GUC via SET LOCAL so
 * Row-Level Security scopes every statement to that tenant. Never run tenant
 * queries on a bare pool client — RLS would fail closed (return nothing) at
 * best, and there is no legitimate reason to bypass it.
 */
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { config } from "./config";

/**
 * Shared connection pool. The app connects as the least-privilege app role.
 *
 * PGBOUNCER (Phase-2): DATABASE_URL points at PgBouncer in transaction pooling
 * mode (host port 6432), NOT directly at Postgres. This is safe because every
 * tenant query is wrapped by `withTenant` in a BEGIN/COMMIT with
 * set_config(..., is_local=true): the tenant GUC lives and dies inside one
 * transaction, so a pooled backend never leaks tenant context to the next
 * client. Migrations bypass PgBouncer via MIGRATION_DATABASE_URL (direct 5544).
 *
 * IMPORTANT: do NOT introduce node-postgres NAMED prepared statements or any
 * session-level `SET` (as opposed to `SET LOCAL` / set_config is_local=true)
 * without reconsidering the pool mode. Transaction-mode PgBouncer only
 * guarantees a stable backend for the duration of a single transaction; named
 * statements and session GUCs assume a sticky session and will break or leak.
 * Our queries use the extended protocol with UNNAMED statements, which
 * transaction pooling handles correctly.
 */
export const pool = new Pool({ connectionString: config.DATABASE_URL });

/**
 * READ/WRITE SPLIT (Phase-2 cont.): a separate pool for READ-ONLY tenant queries
 * routed to a read replica.
 *
 *   reads  -> READ_DATABASE_URL (replica)   via withTenantRead()
 *   writes -> DATABASE_URL       (primary)   via withTenant()
 *
 * When READ_DATABASE_URL is unset, this falls back to DATABASE_URL so the app
 * runs perfectly well against the primary alone (the replica is optional).
 * Both URLs may point at their OWN PgBouncer in transaction mode — the same
 * withTenant single-transaction discipline makes that safe on either side.
 */
export const readPool = new Pool({
  connectionString: config.READ_DATABASE_URL ?? config.DATABASE_URL,
});

/**
 * Run `fn` inside a transaction scoped to a single tenant.
 *
 * We use `SET LOCAL`, so the GUC is bound to THIS transaction only and is
 * automatically discarded on COMMIT/ROLLBACK — even though the underlying
 * connection is recycled back into the pool. That prevents tenant bleed across
 * pooled connections.
 *
 * NOTE: SET LOCAL does not accept a bound parameter placeholder for the value,
 * so we use set_config(name, value, is_local=true) which DOES take params and
 * is injection-safe.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // set_config(setting, value, is_local) — is_local=true == SET LOCAL semantics.
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Run a READ-ONLY `fn` inside a tenant-scoped transaction on the read replica
 * (readPool). Same discipline as withTenant — BEGIN, set the tenant GUC so RLS
 * scopes every statement, run `fn`, COMMIT — with two differences:
 *
 *   1) It uses `readPool` (READ_DATABASE_URL / replica), not the primary pool.
 *   2) It marks the transaction READ ONLY immediately after BEGIN, so an
 *      accidental write on the read path fails LOUDLY (Postgres error) instead
 *      of silently hitting a replica that can't accept writes anyway.
 *
 * We still set app.tenant_id via set_config(..., is_local=true) so RLS scopes
 * this transaction to the tenant, exactly like withTenant. Keeping the
 * BEGIN/COMMIT wrapper is also what makes transaction-mode PgBouncer safe in
 * front of the replica.
 */
export async function withTenantRead<T>(
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await readPool.connect();
  try {
    await client.query("BEGIN");
    // Fail closed on any accidental write attempted on the read path.
    await client.query("SET TRANSACTION READ ONLY");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Plain, non-tenant-scoped query. Use ONLY for migrations / bootstrap / health
 * checks that legitimately operate outside tenant scope. Never for tenant data.
 */
export async function query<R extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = []
): Promise<QueryResult<R>> {
  return pool.query<R>(text, params as unknown[]);
}

/** Graceful shutdown helper. Ends BOTH the primary and read-replica pools. */
export async function closePool(): Promise<void> {
  await Promise.all([pool.end(), readPool.end()]);
}
