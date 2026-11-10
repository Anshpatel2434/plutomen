/**
 * Run one validated, model-written query for a tenant.
 *
 * READ ONLY transaction (withTenantRead) + `plutoman_analyst`, a role that can
 * SELECT the two inspection tables and nothing else + row-level security on
 * the caller's tenant + a statement timeout. See sqlGuard.ts for the layers.
 */
import { withTenantRead } from "../db";
import { guardSql } from "./sqlGuard";

export interface SqlTable {
  columns: string[];
  rows: Record<string, unknown>[];
}

/** Raised for a query that is refused or fails; `message` is safe to show the model. */
export class SqlError extends Error {}

const TIMEOUT_MS = 8000;

export async function runSql(tenantId: string, rawSql: string): Promise<SqlTable> {
  const guarded = guardSql(rawSql);
  if (!guarded.ok) throw new SqlError(guarded.reason);
  try {
    return await withTenantRead(tenantId, async (client) => {
      // The timeout is set as the app role, then the role drops to the analyst
      // for the model's statement. Both end with the transaction.
      await client.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
      await client.query("SET LOCAL ROLE plutoman_analyst");
      const res = await client.query(guarded.sql);
      return { columns: res.fields.map((f) => f.name), rows: res.rows as Record<string, unknown>[] };
    });
  } catch (err) {
    if (err instanceof SqlError) throw err;
    // Postgres' message names the bad column / syntax, which is what the
    // model needs to correct itself. It contains no data.
    throw new SqlError(err instanceof Error ? err.message : String(err));
  }
}
