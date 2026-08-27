/**
 * Demo ingestion: load every ../demo_data/*.xlsx, assign a demo tenant, derive a
 * stable mongoId from the filename, and ingest so the corpus becomes searchable.
 *
 * By default this runs ingestion INLINE (no worker/Redis needed) via
 * ingestUpsert, which is the least-friction path for a demo. Pass --enqueue to
 * push jobs onto the BullMQ queue instead (requires `npm run worker` running).
 *
 * Requires: Postgres migrated + Ollama up with the embed model pulled.
 */
import { readdir } from "fs/promises";
import { resolve, join, basename } from "path";
import { ingestUpsert } from "../src/ingestion/ingestWorker";
import { enqueueIngest } from "../src/ingestion/queue";
import { closePool } from "../src/db";
import { invalidateTenant, closeCache } from "../src/cache";

const DEMO_TENANT = "demo-tenant";

async function main(): Promise<void> {
  const useQueue = process.argv.includes("--enqueue");
  const demoDir = resolve(__dirname, "..", "..", "demo_data");

  let files: string[];
  try {
    files = (await readdir(demoDir)).filter((f) => f.toLowerCase().endsWith(".xlsx"));
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
  console.log(`[ingest:demo] found ${files.length} workbook(s) in ${demoDir}`);

  for (const file of files) {
    // Stable mongoId per file so re-runs upsert rather than duplicate.
    const mongoId = `demo:${basename(file)}`;
    const fileRef = join(demoDir, file);
    const data = { tenantId: DEMO_TENANT, mongoId, action: "upsert" as const, fileRef };

    if (useQueue) {
      const jobId = await enqueueIngest(data);
      // eslint-disable-next-line no-console
      console.log(`[ingest:demo] enqueued ${file} -> job ${jobId}`);
    } else {
      // eslint-disable-next-line no-console
      process.stdout.write(`[ingest:demo] ingesting ${file} ... `);
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
