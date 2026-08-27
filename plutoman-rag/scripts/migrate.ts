/**
 * Minimal migration runner: executes db/migrations/*.sql in filename order
 * against DATABASE_URL. Idempotent SQL (CREATE ... IF NOT EXISTS, DROP POLICY
 * IF EXISTS) means re-running is safe.
 *
 * NOTE: run this as the DB OWNER/superuser (it creates extensions, roles, and
 * policies). The application then connects as the least-privilege app role.
 */
import { readdir, readFile } from "fs/promises";
import { join, resolve } from "path";
import { Pool } from "pg";
import { config } from "../src/config";

async function main(): Promise<void> {
  const dir = resolve(__dirname, "..", "db", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();

  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.log("[migrate] no migration files found in", dir);
    return;
  }

  // Prefer the owner/superuser URL for DDL; fall back to DATABASE_URL.
  const migrationUrl = config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL;
  const pool = new Pool({ connectionString: migrationUrl });
  try {
    for (const file of files) {
      const sql = await readFile(join(dir, file), "utf8");
      // eslint-disable-next-line no-console
      console.log(`[migrate] applying ${file} ...`);
      await pool.query(sql);
      // eslint-disable-next-line no-console
      console.log(`[migrate] done ${file}`);
    }
  } finally {
    await pool.end();
  }
  // eslint-disable-next-line no-console
  console.log("[migrate] all migrations applied");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[migrate] failed:", err);
  process.exit(1);
});
