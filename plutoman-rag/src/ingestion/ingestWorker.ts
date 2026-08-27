/**
 * BullMQ worker: consumes the "ingest" queue and materializes reports into the
 * Postgres retrieval index. Runs as its own process (`npm run worker`).
 *
 * Pipeline for an upsert:
 *   parse xlsx -> chunk -> embed (batched) -> within a single withTenant tx:
 *     upsert the `documents` row (on conflict tenant_id, mongo_id)
 *     delete existing chunks for this sop_id (idempotent replace)
 *     batch-insert new chunks (content + generated tsv + embedding)
 *
 * For a delete: remove the document (chunks cascade) for (tenant_id, mongo_id).
 *
 * The whole thing is idempotent: re-running the same job converges to the same
 * state, and job ids in queue.ts collapse duplicate enqueues.
 */
import { readFile } from "fs/promises";
import { Worker } from "bullmq";
import { withTenant } from "../db";
import { invalidateTenant } from "../cache";
import { embed, EMBED_MODEL, EMBED_VERSION, toVectorLiteral } from "../embeddings";
import { parseWorkbookBuffer } from "./parseXlsx";
import { chunkReport } from "./chunk";
import {
  INGEST_QUEUE_NAME,
  IngestJobData,
  createRedisConnection,
} from "./queue";

/** Resolve the xlsx bytes for an upsert job from either a path or inline base64. */
async function loadBuffer(data: IngestJobData): Promise<Buffer> {
  if (data.parsedPayload?.xlsxBase64) {
    return Buffer.from(data.parsedPayload.xlsxBase64, "base64");
  }
  if (data.fileRef) {
    return readFile(data.fileRef);
  }
  throw new Error("upsert job requires fileRef or parsedPayload.xlsxBase64");
}

/**
 * Core upsert routine — exported so the demo script can run ingestion inline
 * without a running worker. All tenant data access goes through withTenant so
 * RLS is always in force.
 */
export async function ingestUpsert(data: IngestJobData): Promise<{ chunks: number }> {
  const buffer = await loadBuffer(data);
  const report = await parseWorkbookBuffer(buffer);
  const { metadata, chunks } = chunkReport(report);

  // Embed all chunk contents in one batched call (documents task prefix).
  const vectors = await embed(
    chunks.map((c) => c.content),
    "document"
  );

  return withTenant(data.tenantId, async (client) => {
    // 1) Upsert the parent document row.
    const docRes = await client.query<{ id: string }>(
      `INSERT INTO documents (tenant_id, mongo_id, type, title, status, section_path, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (tenant_id, mongo_id)
       DO UPDATE SET type = EXCLUDED.type,
                     title = EXCLUDED.title,
                     status = EXCLUDED.status,
                     section_path = EXCLUDED.section_path,
                     updated_at = now()
       RETURNING id`,
      [data.tenantId, data.mongoId, metadata.type, metadata.title, metadata.status, null]
    );
    const documentId = docRes.rows[0].id;

    // 2) Idempotent replace: drop old chunks for this source id.
    await client.query(`DELETE FROM chunks WHERE tenant_id = $1 AND sop_id = $2`, [
      data.tenantId,
      data.mongoId,
    ]);

    // 3) Batch-insert new chunks. We build a single multi-row INSERT with
    //    parameterized placeholders (no string interpolation of values). The
    //    embedding is passed as a pgvector literal string and cast with ::vector.
    if (chunks.length > 0) {
      const cols = 16; // number of bound params per row
      const values: unknown[] = [];
      const rowsSql: string[] = [];

      chunks.forEach((chunk, i) => {
        const base = i * cols;
        // Placeholder list for this row; note ::vector cast on the embedding param.
        rowsSql.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
            `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, ` +
            `$${base + 11}, $${base + 12}, $${base + 13}::vector, $${base + 14}, ` +
            `$${base + 15}, $${base + 16})`
        );
        values.push(
          data.tenantId, // tenant_id
          data.mongoId, // sop_id (= source mongo _id)
          documentId, // document_id
          chunk.sectionPath, // section_path
          chunk.question, // question
          chunk.answer, // answer
          chunk.verdict, // verdict
          metadata.site, // site
          metadata.vendor, // vendor
          metadata.po, // po
          metadata.reportDate, // report_date
          chunk.content, // content (content_tsv is generated from this)
          toVectorLiteral(vectors[i]), // embedding ::vector
          "text", // modality (TODO: multimodal)
          EMBED_MODEL, // embed_model
          EMBED_VERSION // embed_version
        );
      });

      await client.query(
        `INSERT INTO chunks
           (tenant_id, sop_id, document_id, section_path, question, answer, verdict,
            site, vendor, po, report_date, content, embedding, modality,
            embed_model, embed_version)
         VALUES ${rowsSql.join(", ")}`,
        values
      );
    }

    return { chunks: chunks.length };
  });
}

/** Core delete routine — remove a document + its chunks (cascade). */
export async function ingestDelete(data: IngestJobData): Promise<void> {
  await withTenant(data.tenantId, async (client) => {
    await client.query(`DELETE FROM documents WHERE tenant_id = $1 AND mongo_id = $2`, [
      data.tenantId,
      data.mongoId,
    ]);
    // Defensive: chunks reference document_id ON DELETE CASCADE, but chunks may
    // also be keyed only by sop_id in edge cases — clean those too.
    await client.query(`DELETE FROM chunks WHERE tenant_id = $1 AND sop_id = $2`, [
      data.tenantId,
      data.mongoId,
    ]);
  });
}

/** Process a single job (dispatch on action). */
export async function processIngestJob(data: IngestJobData): Promise<void> {
  if (data.action === "delete") {
    await ingestDelete(data);
  } else {
    await ingestUpsert(data);
  }

  // Freshness/compliance (Phase-2): after content changes for this tenant, drop
  // that tenant's cached /search results so stale or withdrawn content can never
  // be served from cache. Scoped to this tenant only (see src/cache.ts).
  await invalidateTenant(data.tenantId);
}

/** Start the worker. Invoked when this module is run as the entrypoint. */
export function startWorker(): Worker<IngestJobData> {
  const worker = new Worker<IngestJobData>(
    INGEST_QUEUE_NAME,
    async (job) => {
      await processIngestJob(job.data);
    },
    { connection: createRedisConnection(), concurrency: 4 }
  );

  worker.on("completed", (job) => {
    // eslint-disable-next-line no-console
    console.log(`[ingest] completed ${job.id} (${job.name})`);
  });
  worker.on("failed", (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[ingest] failed ${job?.id}:`, err.message);
  });

  return worker;
}

// Run standalone: `npm run worker`
if (require.main === module) {
  startWorker();
  // eslint-disable-next-line no-console
  console.log(`[ingest] worker listening on queue "${INGEST_QUEUE_NAME}"`);
}
