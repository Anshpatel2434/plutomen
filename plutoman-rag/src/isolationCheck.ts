/**
 * Phase-3: startup isolation self-check (fail fast on misconfig).
 *
 * Defense in depth for tenant isolation. RLS + withTenant() are the runtime
 * controls; this boot-time check refuses to start the process if the database
 * is configured in a way that would silently DEFEAT those controls:
 *
 *   1) The app must NOT connect as a superuser. Superusers bypass RLS entirely
 *      (even FORCE ROW LEVEL SECURITY does not apply to them), so a superuser
 *      connection would leak every tenant's data.
 *   2) RLS must be ENABLED and FORCED on every tenant-owned table (documents,
 *      chunks, audit). "Enabled" alone still exempts the table owner; "forced"
 *      (relforcerowsecurity) makes the policies apply to the owner too.
 *
 * On any failure it logs a clear message and the caller (server.ts) exits(1)
 * BEFORE app.listen — the service never accepts traffic in an unsafe state.
 *
 * Dependency-light by design: reuses the existing app `pool` (via `query`) from
 * src/db.ts, i.e. it checks the SAME role/connection the app actually serves on.
 */
import { query } from "./db";

/** Tenant-owned tables that must have RLS enabled AND forced. */
const TENANT_TABLES = ["documents", "chunks", "audit"] as const;

/**
 * Assert the app's DB connection is isolation-safe, or throw with a clear
 * message. Throws (does not exit) so the caller controls process lifecycle and
 * this stays unit-testable.
 */
export async function assertIsolation(): Promise<void> {
  // 1) Non-superuser check. Superusers bypass RLS, defeating tenant isolation.
  const superRes = await query<{ rolsuper: boolean }>(
    `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`
  );
  if (superRes.rows.length === 0) {
    throw new Error(
      "[isolation] self-check FAILED: could not resolve current_user in pg_roles"
    );
  }
  if (superRes.rows[0].rolsuper) {
    throw new Error(
      "[isolation] self-check FAILED: app connects as a SUPERUSER — superusers " +
        "bypass RLS and would leak cross-tenant data. Use the least-privilege " +
        "plutoman_app role."
    );
  }

  // 2) RLS enabled AND forced on every tenant table (schema 'public').
  const rlsRes = await query<{
    relname: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY($1)`,
    [TENANT_TABLES as unknown as string[]]
  );

  const byName = new Map(rlsRes.rows.map((r) => [r.relname, r]));
  const problems: string[] = [];
  for (const t of TENANT_TABLES) {
    const row = byName.get(t);
    if (!row) {
      problems.push(`${t}: table not found in schema 'public'`);
      continue;
    }
    if (!row.relrowsecurity) problems.push(`${t}: RLS not ENABLED`);
    if (!row.relforcerowsecurity) problems.push(`${t}: RLS not FORCED`);
  }
  if (problems.length > 0) {
    throw new Error(
      "[isolation] self-check FAILED: RLS misconfigured on tenant tables:\n  - " +
        problems.join("\n  - ")
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    "[isolation] self-check passed (non-superuser role, RLS enabled+forced on all tenant tables)"
  );
}
