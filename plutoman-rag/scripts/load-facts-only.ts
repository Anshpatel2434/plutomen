/**
 * Development helper: fill ONLY the data engine's tables (inspection_reports,
 * inspection_items, inspection_amounts) from ../demo_data, with no embeddings
 * and no chunks. For a throw-away database that has the fact migrations
 * (008-012) applied on top of a stub `documents` table, so the standard
 * measures and the ready-made reports can be tested without Ollama or pgvector.
 *
 *   FACTS_DATABASE_URL=postgres://postgres@localhost:5432/plutoman_reports_test \
 *     npx tsx scripts/load-facts-only.ts
 *
 * Not part of the product: the real path is `npm run ingest:demo`.
 */
import { readdir, readFile } from "fs/promises";
import { resolve, join } from "path";
import { Client } from "pg";
import type { PoolClient } from "pg";
import { parseWorkbookBuffer } from "../src/ingestion/parseXlsx";
import { chunkReport } from "../src/ingestion/chunk";
import { parsePdfBuffer, locateChunks, ParsedPdf, TWIN_MATCH_THRESHOLD } from "../src/ingestion/parsePdf";
import { buildFacts } from "../src/data/buildFacts";
import { replaceFacts } from "../src/data/storeFacts";

const TENANT = "demo-tenant";

async function main(): Promise<void> {
  const url = process.env.FACTS_DATABASE_URL;
  if (!url) throw new Error("set FACTS_DATABASE_URL");
  const dir = process.env.DEMO_DATA_DIR ?? resolve(__dirname, "..", "..", "demo_data");
  const files = await readdir(dir);
  const pdfs: { f: string; pdf: ParsedPdf }[] = [];
  for (const f of files.filter((x) => x.toLowerCase().endsWith(".pdf"))) {
    pdfs.push({ f, pdf: await parsePdfBuffer(await readFile(join(dir, f))) });
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("DELETE FROM documents WHERE tenant_id = $1", [TENANT]);
  const claimed = new Set<string>();
  for (const file of files.filter((x) => x.toLowerCase().endsWith(".xlsx")).sort()) {
    const report = await parseWorkbookBuffer(await readFile(join(dir, file)));
    const plain = chunkReport(report).chunks;
    const best = pdfs
      .filter((p) => !claimed.has(p.f))
      .map((p) => {
        const r = locateChunks(p.pdf, plain);
        return { ...p, score: r.total ? r.matched / r.total : 0 };
      })
      .sort((a, b) => b.score - a.score)[0];
    const pdf = best && best.score >= TWIN_MATCH_THRESHOLD && best.pdf.poid ? best.pdf : null;
    if (pdf && best) claimed.add(best.f);
    const ids = pdf ? { poid: pdf.poid, jobId: pdf.jobId } : {};
    const { metadata, chunks } = chunkReport(report, ids);
    const pages = pdf ? locateChunks(pdf, chunks).pages : chunks.map(() => null);
    const pageOf = new Map(chunks.map((c, i) => [c.sectionPath, pages[i] ?? null]));
    const facts = buildFacts(report, metadata, { reportId: ids.poid ?? file, jobId: ids.jobId }, pageOf);
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [TENANT]);
    const doc = await client.query<{ id: string }>("INSERT INTO documents (tenant_id) VALUES ($1) RETURNING id", [TENANT]);
    await replaceFacts(client as unknown as PoolClient, TENANT, doc.rows[0].id, facts);
    await client.query("COMMIT");
    // eslint-disable-next-line no-console
    console.log(`${file} -> ${facts.report.reportId} ${facts.report.jobId ?? ""} ${facts.items.length} items, ${facts.amounts.length} amounts`);
  }
  await client.end();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
