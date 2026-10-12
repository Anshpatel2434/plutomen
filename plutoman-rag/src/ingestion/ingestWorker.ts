/**
 * BullMQ worker: consumes the "ingest" queue and materializes reports into the
 * Postgres retrieval index. Runs as its own process (`npm run worker`).
 *
 * Pipeline for an upsert:
 *   parse xlsx [+ optional PDF twin -> POID, Job ID, printed page per chunk;
 *   rejected if it is not the same report] -> chunk -> embed (batched) ->
 *   within a single withTenant tx:
 *     upsert the `documents` row (on conflict tenant_id, mongo_id)
 *     delete existing chunks for this sop_id (idempotent replace)
 *     batch-insert new chunks (content + generated tsv + embedding)
 *
 * For a delete: remove the document (chunks cascade) for (tenant_id, mongo_id).
 *
 * The whole thing is idempotent: re-running the same job converges to the same
 * state. Every enqueue is its own job; when several jobs for one document are
 * in flight, only the most recently enqueued one writes (see writeIsCurrent).
 */
import { readFile } from "fs/promises";
import { Worker } from "bullmq";
import type { PoolClient } from "pg";
import { withTenant } from "../db";
import { cacheClient, invalidateTenant } from "../cache";
import { embed, EMBED_MODEL, EMBED_VERSION, toVectorLiteral } from "../embeddings";
import { parseWorkbookBuffer } from "./parseXlsx";
import { chunkReport } from "./chunk";
import { parsePdfBuffer, locateChunks, ParsedPdf, TWIN_MATCH_THRESHOLD } from "./parsePdf";
import {
  INGEST_QUEUE_NAME,
  IngestJobData,
  createRedisConnection,
  seqKey,
} from "./queue";

/** True when a newer job for the same document has been enqueued. */
export function isSuperseded(jobSeq: number | undefined, latestSeq: number | null): boolean {
  return jobSeq !== undefined && latestSeq !== null && latestSeq > jobSeq;
}

/**
 * First step of every write transaction. Takes a lock on this ONE document
 * (transaction-scoped, so it is safe under PgBouncer transaction pooling and
 * released at COMMIT), then checks that no newer job for it was enqueued. A
 * newer job always bumps the sequence before it can reach this lock, so
 * whichever order the jobs finish in, the latest enqueued state is what stays.
 */
async function writeIsCurrent(client: PoolClient, data: IngestJobData): Promise<boolean> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `${data.tenantId}|${data.mongoId}`,
  ]);
  if (data.seq === undefined) return true;
  const latest = await cacheClient.get(seqKey(data.tenantId, data.mongoId));
  const current = !isSuperseded(data.seq, latest === null ? null : Number(latest));
  if (!current) {
    // eslint-disable-next-line no-console
    console.log(`[ingest] skipped ${data.mongoId} job #${data.seq}: superseded by #${latest}`);
  }
  return current;
}

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

/** Parse the optional PDF twin (path or inline base64); null when none given. */
async function loadPdf(data: IngestJobData): Promise<ParsedPdf | null> {
  if (data.parsedPayload?.pdfBase64) {
    return parsePdfBuffer(Buffer.from(data.parsedPayload.pdfBase64, "base64"));
  }
  if (data.pdfRef) {
    return parsePdfBuffer(await readFile(data.pdfRef));
  }
  return null;
}

/**
 * Core upsert routine — exported so the demo script can run ingestion inline
 * without a running worker. All tenant data access goes through withTenant so
 * RLS is always in force.
 */
export async function ingestUpsert(
  data: IngestJobData
): Promise<{ chunks: number; skipped?: boolean }> {
  const buffer = await loadBuffer(data);
  const report = await parseWorkbookBuffer(buffer);

  // Optional PDF twin -> POID, Job ID and the printed page of every chunk.
  const pdf = await loadPdf(data);
  const ids = pdf ? { poid: pdf.poid, jobId: pdf.jobId } : {};
  const { metadata, chunks } = chunkReport(report, ids);

  let pages: (string | null)[] = chunks.map(() => null);
  if (pdf) {
    const loc = locateChunks(pdf, chunks);
    // Refuse a mismatched pair: attaching the wrong POID would make every
    // citation point at the wrong document (a scored fail), which is worse
    // than having no POID at all. Fail loudly so the job is visible/retryable.
    if (loc.total > 0 && loc.matched / loc.total < TWIN_MATCH_THRESHOLD) {
      throw new Error(
        `PDF ${pdf.poid ?? "(no POID)"} is not the twin of workbook ${data.mongoId}: ` +
          `only ${loc.matched}/${loc.total} items match (need ${TWIN_MATCH_THRESHOLD * 100}%)`
      );
    }
    pages = loc.pages;
  }

  // Embed all chunk contents in one batched call (documents task prefix).
  const vectors = await embed(
    chunks.map((c) => c.content),
    "document"
  );

  return withTenant(data.tenantId, async (client) => {
    if (!(await writeIsCurrent(client, data))) return { chunks: 0, skipped: true };

    // 1) Upsert the parent document row.
    const docRes = await client.query<{ id: string }>(
      `INSERT INTO documents (tenant_id, mongo_id, type, title, status, section_path,
                              poid, job_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (tenant_id, mongo_id)
       DO UPDATE SET type = EXCLUDED.type,
                     title = EXCLUDED.title,
                     status = EXCLUDED.status,
                     section_path = EXCLUDED.section_path,
                     poid = EXCLUDED.poid,
                     job_id = EXCLUDED.job_id,
                     updated_at = now()
       RETURNING id`,
      [
        data.tenantId,
        data.mongoId,
        metadata.type,
        metadata.title,
        metadata.status,
        null,
        ids.poid ?? null,
        ids.jobId ?? null,
      ]
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
      const cols = 19; // number of bound params per row
      const values: unknown[] = [];
      const rowsSql: string[] = [];

      chunks.forEach((chunk, i) => {
        const base = i * cols;
        // Placeholder list for this row; note ::vector cast on the embedding param.
        rowsSql.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
            `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, ` +
            `$${base + 11}, $${base + 12}, $${base + 13}::vector, $${base + 14}, ` +
            `$${base + 15}, $${base + 16}, $${base + 17}, $${base + 18}, $${base + 19})`
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
          EMBED_VERSION, // embed_version
          ids.poid ?? null, // poid    (from the PDF twin, if any)
          ids.jobId ?? null, // job_id  (from the PDF twin, if any)
          pages[i] // page    printed page label, e.g. "2", "6-7", "cover"
        );
      });

      await client.query(
        `INSERT INTO chunks
           (tenant_id, sop_id, document_id, section_path, question, answer, verdict,
            site, vendor, po, report_date, content, embedding, modality,
            embed_model, embed_version, poid, job_id, page)
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
    if (!(await writeIsCurrent(client, data))) return;
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
