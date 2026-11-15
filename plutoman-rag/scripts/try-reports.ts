/**
 * Development helper: run ready-made reports against a facts-only database
 * (see load-facts-only.ts) and print the tables the answer step would get.
 *
 *   DATABASE_URL=postgres://plutoman_app:app_password@localhost:5432/plutoman_reports_test \
 *     npx tsx scripts/try-reports.ts '{"name":"lots","vendors":["Polycab"]}' ...
 *
 * With no arguments it runs one call of every report. Exits 1 if a query fails.
 */
import { loadDataCatalog, renderCatalog, renderTable } from "../src/data/dataEngine";
import { catalogLists, validateCall, queriesFor, pickSystemPrompt } from "../src/data/reports";
import { runSql } from "../src/data/runSql";
import { pool, readPool } from "../src/db";
import { cacheClient } from "../src/cache";

const DEFAULTS = [
  '{"name":"lots"}',
  '{"name":"lots","vendors":["Polycab"]}',
  '{"name":"lots","person":"Suresh Iyer"}',
  '{"name":"lots","po":"4500134567"}',
  '{"name":"breakdown","by":"vendor","report_type":"LT_Mini_Pillar"}',
  '{"name":"breakdown","by":"test_results","report_type":"LT_Power_Cables"}',
  '{"name":"breakdown","by":"technical_clearance"}',
  '{"name":"breakdown","by":"declaration"}',
  '{"name":"breakdown","by":"purchase_order"}',
  '{"name":"breakdown","by":"po_month"}',
  '{"name":"breakdown","by":"detail","detail_item":"AEML Engineer"}',
  '{"name":"breakdown","by":"SAP Code"}',
  '{"name":"breakdown","by":"worst_observation"}',
  '{"name":"checks","items":["IR Test","insulation resistance"]}',
  '{"name":"checks","items":["Armour Tests"],"vendors":["KEI"]}',
  '{"name":"checks","section":"Physical Checks","jobs":["PH2026100005"],"only":"problems"}',
  '{"name":"checks","vendors":["Siemens"],"only":"notes"}',
  '{"name":"recurring","report_type":"LT_Mini_Pillar"}',
  '{"name":"recurring","section":"Other Compliances for Manufacturing Facility"}',
  '{"name":"observations","report_type":"LT_Power_Cables"}',
  '{"name":"attachments"}',
];

async function main(): Promise<void> {
  const cat = await loadDataCatalog("demo-tenant");
  const lists = catalogLists(cat);
  const args = process.argv.slice(2);
  if (args[0] === "--prompt") {
    // eslint-disable-next-line no-console
    console.log(pickSystemPrompt(renderCatalog(cat)));
    return;
  }
  let failed = 0;
  for (const a of args.length > 0 ? args : DEFAULTS) {
    const call = validateCall(JSON.parse(a), lists);
    // eslint-disable-next-line no-console
    console.log(`\n######## ${a}${call ? "" : "  -> REFUSED"}`);
    if (!call) continue;
    for (const q of queriesFor(call)) {
      try {
        const t = await runSql("demo-tenant", q.sql);
        // eslint-disable-next-line no-console
        console.log(`${renderTable({ title: q.title, sql: q.sql, ...t }, 14)}\n   [${q.sql.length} chars${q.info ? ", info" : ""}]\n`);
      } catch (e) {
        failed++;
        // eslint-disable-next-line no-console
        console.log(`FAILED ${q.title}: ${e instanceof Error ? e.message : e}\n${q.sql}\n`);
      }
    }
  }
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
    await readPool.end().catch(() => undefined);
    cacheClient.disconnect();
  });
