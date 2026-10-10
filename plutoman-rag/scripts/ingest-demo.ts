/**
 * Demo ingestion: load every ../demo_data/*.xlsx, assign a demo tenant, and
 * ingest so the corpus becomes searchable.
 *
 * PDF twins (golden-eval change 1): each workbook is paired with the PDF of
 * the SAME report in demo_data (POID-*.pdf) by matching item titles + values
 * (see parsePdf.locateChunks). A paired report is keyed by its POID and its
 * chunks get POID / Job ID / printed page for citations. An unpaired workbook
 * still ingests, keyed by file name, without those fields.
 *
 * One copy per report: the pre-twin key for a paired file ("demo:<file>.xlsx")
 * is deleted, so the same report is never indexed twice (that would double
 * counts such as "all six mini-pillar reports").
 *
 * By default this runs ingestion INLINE (no worker/Redis needed) via
 * ingestUpsert, which is the least-friction path for a demo. Pass --enqueue to
 * push jobs onto the BullMQ queue instead (requires `npm run worker` running).
 *
 * Requires: Postgres migrated + Ollama up with the embed model pulled.
 */
import { readdir, readFile } from "fs/promises";
import { resolve, join, basename } from "path";
import { ingestUpsert, ingestDelete } from "../src/ingestion/ingestWorker";
import { enqueueIngest, closeQueue } from "../src/ingestion/queue";
import { parseWorkbookBuffer } from "../src/ingestion/parseXlsx";
import { chunkReport } from "../src/ingestion/chunk";
import {
  parsePdfBuffer,
  locateChunks,
  ParsedPdf,
  TWIN_MATCH_THRESHOLD,
} from "../src/ingestion/parsePdf";
import { closePool } from "../src/db";
import { invalidateTenant, closeCache } from "../src/cache";

const DEMO_TENANT = "demo-tenant";

interface Twin {
  file: string;
  pdf: ParsedPdf;
  score: number;
}

/**
 * Pair each workbook with its PDF twin: the PDF with the highest title+value
 * match score, if it clears TWIN_MATCH_THRESHOLD. Each PDF is used at most
 * once; on the demo data every workbook scores 100% against its twin and at
 * most ~81% against any other report.
 */
async function pairTwins(demoDir: string, xlsxFiles: string[], pdfFiles: string[]) {
  const pdfs = await Promise.all(
    pdfFiles.map(async (f) => ({ f, pdf: await parsePdfBuffer(await readFile(join(demoDir, f))) }))
  );
  const twins = new Map<string, Twin>();
  const claimed = new Set<string>();
  for (const file of xlsxFiles) {
    const { chunks } = chunkReport(await parseWorkbookBuffer(await readFile(join(demoDir, file))));
    const ranked = pdfs
      .filter((p) => !claimed.has(p.f))
      .map((p) => {
        const r = locateChunks(p.pdf, chunks);
        return { f: p.f, pdf: p.pdf, score: r.total ? r.matched / r.total : 0 };
      })
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (best && best.score >= TWIN_MATCH_THRESHOLD && best.pdf.poid) {
      twins.set(file, { file: best.f, pdf: best.pdf, score: best.score });
      claimed.add(best.f);
    }
  }
  return twins;
}

async function main(): Promise<void> {
  const useQueue = process.argv.includes("--enqueue");
  const demoDir = resolve(__dirname, "..", "..", "demo_data");

  let files: string[];
  let pdfFiles: string[];
  try {
    const all = await readdir(demoDir);
    files = all.filter((f) => f.toLowerCase().endsWith(".xlsx"));
    pdfFiles = all.filter((f) => f.toLowerCase().endsWith(".pdf"));
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[ingest:demo] demo_data folder not found at ${demoDir}`);
    process.exit(1);
    return;
  }

  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[ingest:demo] no .xlsx files in ${demoDir}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[ingest:demo] found ${files.length} workbook(s) and ${pdfFiles.length} PDF(s) in ${demoDir}`
  );
  const twins = await pairTwins(demoDir, files, pdfFiles);

  for (const file of files) {
    const twin = twins.get(file);
    const legacyId = `demo:${basename(file)}`;
    // Paired reports are keyed by POID; unpaired ones keep the file-name key.
    const mongoId = twin ? twin.pdf.poid! : legacyId;
    const fileRef = join(demoDir, file);
    const pdfRef = twin ? join(demoDir, twin.file) : undefined;
    const data = { tenantId: DEMO_TENANT, mongoId, action: "upsert" as const, fileRef, pdfRef };

    // Remove this report's pre-twin copy so it is indexed exactly once.
    if (twin) {
      await ingestDelete({ tenantId: DEMO_TENANT, mongoId: legacyId, action: "delete" });
    }

    const pairing = twin
      ? `${twin.pdf.poid} / ${twin.pdf.jobId} (${(twin.score * 100).toFixed(0)}% match)`
      : "no PDF twin";
    if (useQueue) {
      const jobId = await enqueueIngest(data);
      // eslint-disable-next-line no-console
      console.log(`[ingest:demo] enqueued ${file} [${pairing}] -> job ${jobId}`);
    } else {
      // eslint-disable-next-line no-console
      process.stdout.write(`[ingest:demo] ingesting ${file} [${pairing}] ... `);
      const { chunks } = await ingestUpsert(data);
      // eslint-disable-next-line no-console
      console.log(`ok (${chunks} chunks)`);
    }
  }

  if (!useQueue) {
    // Inline ingestion bypasses the BullMQ worker (which is where cache
    // invalidation normally happens), so proactively drop this tenant's cached
    // /search results here — otherwise a demo re-run could serve stale hits.
    const deleted = await invalidateTenant(DEMO_TENANT);
    // eslint-disable-next-line no-console
    console.log(`[ingest:demo] invalidated ${deleted} cached search key(s)`);
    await closePool();
    // Close the Redis cache client too so the process terminates cleanly
    // (importing invalidateTenant opens a persistent ioredis connection).
    await closeCache();
    // Importing queue.ts constructs the BullMQ producer Queue, which opens its
    // own Redis connection at module load. Inline mode never uses it, but if it
    // is left open the process never exits (hung after "done") — close it too.
    await closeQueue();
    // eslint-disable-next-line no-console
    console.log(`[ingest:demo] done. tenant="${DEMO_TENANT}"`);
  } else {
    // Enqueue path: the worker performs the actual ingest AND cache
    // invalidation. Close the cache client so this launcher exits cleanly.
    await closeCache();
    // eslint-disable-next-line no-console
    console.log(`[ingest:demo] all jobs enqueued. Ensure the worker is running.`);
    process.exit(0);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[ingest:demo] failed:", err);
  process.exit(1);
});
