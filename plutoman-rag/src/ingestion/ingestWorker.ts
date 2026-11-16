/**
 * BullMQ worker: consumes the "ingest" queue and materializes source documents
 * into the Postgres retrieval index. Runs as its own process (`npm run worker`).
 *
 * THREE INGESTION STRATEGIES, chosen by what the file actually is:
 *
 *   .xlsx            -> parseXlsx + chunkReport   -> chunk_kind 'row'
 *                       Rigid 5-sheet inspection template. Row-atomic chunking
 *                       is correct here: each checklist row is already a
 *                       self-contained question/answer/verdict. An optional
 *                       PDF twin (pdfRef / pdfBase64) adds the POID, Job ID
 *                       and printed page to every chunk, plus the table of
 *                       contents and footer; ingestion FAILS if the PDF is not
 *                       the same report as the workbook (see parsePdf.ts).
 *
 *   SOP-shaped text  -> parseSop                  -> chunk_kind 'section'/'step'
 *                       Leg 1. Ingested as a TREE: a section node per heading
 *                       and a step leaf per numbered step, linked by
 *                       parent_chunk_id so retrieval returns a step in context.
 *
 *   any other text   -> chunkProse                -> chunk_kind 'prose'
 *                       Leg 2. Free-form PDF/TXT/CSV, segmented with overlap.
 *
 * The SOP branch is attempted first for text documents and FALLS BACK to prose
 * when `parseSop` finds no section structure — a document that is not actually
 * hierarchical must not be forced into a fake tree.
 *
 * For a delete: remove the document (chunks cascade) for (tenant_id, mongo_id).
 *
 * The whole thing is idempotent: re-running the same job converges to the same
 * state. Every enqueue is its own job; when several jobs for one document are
 * in flight, only the most recently enqueued one writes (see writeIsCurrent).
 */
import { readFile } from "fs/promises";
import { basename } from "path";
import { Worker } from "bullmq";
import type { PoolClient } from "pg";
import { withTenant } from "../db";
import { cacheClient, invalidateTenant } from "../cache";
import { config } from "../config";
import { embed, EMBED_MODEL, EMBED_VERSION, toVectorLiteral } from "../embeddings";
import { parseWorkbookBuffer } from "./parseXlsx";
import { chunkReport, tag } from "./chunk";
import {
  parsePdfBuffer,
  locateChunks,
  pdfOnlyChunks,
  ParsedPdf,
  TWIN_MATCH_THRESHOLD,
} from "./parsePdf";
import { parseDocumentBuffer, formatOf } from "./parseDocument";
import { chunkProse } from "./chunkProse";
import { parseSop, sectionEmbedText, stepEmbedText } from "./parseSop";
import { setUploadStatus } from "../uploads";
import { buildFacts, ReportFacts } from "../data/buildFacts";
import { replaceFacts } from "../data/storeFacts";
import {
  INGEST_QUEUE_NAME,
  IngestJobData,
  createRedisConnection,
  seqKey,
} from "./queue";

/** Node type a chunk occupies in the retrieval index. */
export type ChunkKind = "row" | "prose" | "section" | "step";

/**
 * One chunk ready to embed + insert, normalized across all three strategies.
 * `parent_chunk_id` is NOT set here — it is resolved after insert by matching
 * section_no within the document (see linkTree below).
 */
interface PendingChunk {
  sectionPath: string;
  question: string | null;
  answer: string | null;
  verdict: string | null;
  content: string;
  chunkKind: ChunkKind;
  sectionNo: string | null;
  sectionTitle: string | null;
  stepNo: string | null;
  /** Printed page label from the PDF twin ("2", "6-7", "cover"); null otherwise. */
  page?: string | null;
}

/** Document-level metadata shared by every chunk of a source document. */
interface DocMeta {
  site: string | null;
  vendor: string | null;
  po: string | null;
  reportDate: string | null;
  type: string | null;
  title: string | null;
  status: string | null;
  docRef: string;
  sourceFormat: string;
  /** Report identifiers from the PDF twin (null when ingested without one). */
  poid?: string | null;
  jobId?: string | null;
}

/**
 * A readable document handle from the source id: "demo:LT_Mini_Pillar (2).xlsx"
 * -> "LT_Mini_Pillar (2)", "Inspection SOP.pdf" -> "Inspection SOP".
 */
function deriveDocRef(sopId: string): string {
  return sopId
    .replace(/^demo:/, "")
    .replace(/\.(xlsx|pdf|txt|csv|md)$/i, "")
    .trim();
}

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

/** Parse the optional PDF twin of a workbook (path or inline base64); null when none given. */
async function loadPdf(data: IngestJobData): Promise<ParsedPdf | null> {
  if (data.parsedPayload?.pdfBase64) {
    return parsePdfBuffer(Buffer.from(data.parsedPayload.pdfBase64, "base64"));
  }
  if (data.pdfRef) {
    return parsePdfBuffer(await readFile(data.pdfRef));
  }
  return null;
}

/** Resolve the bytes for an upsert job from either a path or inline base64. */
async function loadBuffer(data: IngestJobData): Promise<Buffer> {
  const inline = data.parsedPayload?.fileBase64 ?? data.parsedPayload?.xlsxBase64;
  if (inline) return Buffer.from(inline, "base64");
  if (data.fileRef) return readFile(data.fileRef);
  throw new Error("upsert job requires fileRef or an inline base64 payload");
}

/**
 * Determine the filename used for format detection. An inline payload carries
 * its own `filename` (the adapter knows what it sent); a fileRef uses its path.
 * Falls back to the mongoId, which for the demo corpus embeds the extension.
 */
function resolveFilename(data: IngestJobData): string {
  return (
    data.parsedPayload?.filename ??
    (data.fileRef ? basename(data.fileRef) : undefined) ??
    data.mongoId
  );
}

// ---------------------------------------------------------------------------
// Strategy 1 — inspection workbook (row-atomic, Phase-1 behaviour)
// ---------------------------------------------------------------------------
async function buildFromWorkbook(
  buffer: Buffer,
  mongoId: string,
  pdf: ParsedPdf | null
): Promise<{ meta: DocMeta; chunks: PendingChunk[]; facts: ReportFacts }> {
  const report = await parseWorkbookBuffer(buffer);
  const ids = pdf ? { poid: pdf.poid, jobId: pdf.jobId } : {};
  const { metadata, chunks: xlsxChunks } = chunkReport(report, ids);
  const chunks = [...xlsxChunks];

  let pages: (string | null)[] = chunks.map(() => null);
  if (pdf) {
    const loc = locateChunks(pdf, xlsxChunks);
    // Refuse a mismatched pair: attaching the wrong POID would make every
    // citation point at the wrong document (a scored fail), which is worse
    // than having no POID at all. Fail loudly so the job is visible/retryable.
    if (loc.total > 0 && loc.matched / loc.total < TWIN_MATCH_THRESHOLD) {
      throw new Error(
        `PDF ${pdf.poid ?? "(no POID)"} is not the twin of workbook ${mongoId}: ` +
          `only ${loc.matched}/${loc.total} items match (need ${TWIN_MATCH_THRESHOLD * 100}%)`
      );
    }
    pages = loc.pages;
    // Table of contents + footer: only in the PDF, so added after the twin check.
    const extra = pdfOnlyChunks(pdf, tag(metadata, ids));
    chunks.push(...extra.chunks);
    pages = [...pages, ...extra.pages];
  }

  // The data engine's rows for this report (every item, with its printed page).
  const pageOf = new Map(xlsxChunks.map((c, i) => [c.sectionPath, pages[i] ?? null]));
  const facts = buildFacts(report, metadata, { reportId: ids.poid ?? mongoId, jobId: ids.jobId }, pageOf);

  return {
    facts,
    meta: {
      ...metadata,
      // The POID is the report's real document handle when the twin is known.
      docRef: ids.poid ?? deriveDocRef(mongoId),
      sourceFormat: "xlsx",
      poid: ids.poid ?? null,
      jobId: ids.jobId ?? null,
    },
    chunks: chunks.map((c, i) => ({
      sectionPath: c.sectionPath,
      question: c.question,
      answer: c.answer,
      verdict: c.verdict,
      content: c.content,
      chunkKind: "row" as const,
      sectionNo: null,
      sectionTitle: null,
      stepNo: null,
      page: pages[i] ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Strategy 2 — SOP tree (Leg 1)
// ---------------------------------------------------------------------------
/**
 * Flatten a parsed SOP into section nodes and step leaves.
 *
 * Both kinds are retrievable in their own right: a broad question ("what does
 * the isolation procedure cover?") should match the SECTION, while a specific
 * one ("how do I verify isolation?") should match the STEP. The step's embedded
 * text carries its section heading so it stays self-describing even in
 * isolation; the parent edge then returns the full section alongside it.
 */
function buildFromSop(
  text: string,
  mongoId: string,
  sourceFormat: string
): { meta: DocMeta; chunks: PendingChunk[] } | null {
  const sop = parseSop(text);
  if (!sop) return null;

  const docRef = sop.docRef ?? deriveDocRef(mongoId);
  const chunks: PendingChunk[] = [];

  for (const section of sop.sections) {
    const sectionPath = `Section ${section.sectionNo}: ${section.title}`;

    chunks.push({
      sectionPath,
      question: section.title,
      answer: section.intro || null,
      verdict: null,
      content: sectionEmbedText(section, sop.title),
      chunkKind: "section",
      sectionNo: section.sectionNo,
      sectionTitle: section.title,
      stepNo: null,
    });

    for (const step of section.steps) {
      chunks.push({
        sectionPath: `${sectionPath} > Step ${step.stepNo}`,
        question: `Step ${step.stepNo}`,
        answer: step.text,
        verdict: null,
        content: stepEmbedText(section, step, sop.title),
        chunkKind: "step",
        sectionNo: section.sectionNo,
        sectionTitle: section.title,
        stepNo: step.stepNo,
      });
    }
  }

  return {
    meta: {
      site: null,
      vendor: null,
      po: null,
      reportDate: null,
      type: "SOP",
      title: sop.title,
      status: null,
      docRef,
      sourceFormat,
    },
    chunks,
  };
}

// ---------------------------------------------------------------------------
// Strategy 3 — free-form prose (Leg 2)
// ---------------------------------------------------------------------------
function buildFromProse(
  text: string,
  mongoId: string,
  sourceFormat: string,
  title: string | null
): { meta: DocMeta; chunks: PendingChunk[] } {
  const docRef = deriveDocRef(mongoId);
  const pieces = chunkProse(text, {
    maxChars: config.PROSE_CHUNK_CHARS,
    overlapChars: config.PROSE_CHUNK_OVERLAP,
  });

  return {
    meta: {
      site: null,
      vendor: null,
      po: null,
      reportDate: null,
      type: sourceFormat.toUpperCase(),
      title,
      status: null,
      docRef,
      sourceFormat,
    },
    chunks: pieces.map((p) => ({
      // Just "part N" — the document handle is already the first element of
      // the citation label, so including docRef here rendered as the redundant
      // "[POID-4504515691, POID-4504515691 / part 3]".
      sectionPath: `part ${p.index + 1}`,
      question: null,
      answer: null,
      verdict: null,
      content: p.content,
      chunkKind: "prose" as const,
      sectionNo: null,
      sectionTitle: null,
      stepNo: null,
    })),
  };
}

/** Dispatch a source document to the right ingestion strategy. */
async function buildChunks(
  buffer: Buffer,
  filename: string,
  data: IngestJobData
): Promise<{ meta: DocMeta; chunks: PendingChunk[]; facts?: ReportFacts }> {
  const mongoId = data.mongoId;
  if (/\.xlsx$/i.test(filename)) {
    return buildFromWorkbook(buffer, mongoId, await loadPdf(data));
  }

  const format = formatOf(filename);
  if (!format) {
    throw new Error(
      `No ingestion strategy for "${filename}". Supported: .xlsx, .pdf, .txt, .csv, .md`
    );
  }

  const doc = await parseDocumentBuffer(buffer, filename);

  // Leg 1 first: if the document has real section structure, keep the tree.
  const sop = buildFromSop(doc.text, mongoId, format);
  if (sop) return sop;

  // Leg 2: ordinary prose.
  const firstLine = doc.text.split("\n").find((l) => l.trim().length > 0) ?? null;
  return buildFromProse(doc.text, mongoId, format, firstLine?.slice(0, 120) ?? null);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Column list for the chunk insert, in bound-parameter order. */
const CHUNK_COLUMNS = [
  "tenant_id",
  "sop_id",
  "document_id",
  "section_path",
  "question",
  "answer",
  "verdict",
  "site",
  "vendor",
  "po",
  "report_date",
  "content",
  "embedding",
  "modality",
  "embed_model",
  "embed_version",
  "doc_ref",
  "source_format",
  "chunk_kind",
  "section_no",
  "section_title",
  "step_no",
  "poid",
  "job_id",
  "page",
] as const;

/** Index of `embedding` — the only column needing a ::vector cast. */
const EMBEDDING_COL = CHUNK_COLUMNS.indexOf("embedding");

/**
 * Core upsert routine — exported so the demo script can run ingestion inline
 * without a running worker. All tenant data access goes through withTenant so
 * RLS is always in force.
 */
export async function ingestUpsert(
  data: IngestJobData
): Promise<{ chunks: number; skipped?: boolean }> {
  const buffer = await loadBuffer(data);
  const filename = resolveFilename(data);
  const { meta, chunks, facts } = await buildChunks(buffer, filename, data);

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
                              doc_ref, source_format, poid, job_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (tenant_id, mongo_id)
       DO UPDATE SET type = EXCLUDED.type,
                     title = EXCLUDED.title,
                     status = EXCLUDED.status,
                     section_path = EXCLUDED.section_path,
                     doc_ref = EXCLUDED.doc_ref,
                     source_format = EXCLUDED.source_format,
                     poid = EXCLUDED.poid,
                     job_id = EXCLUDED.job_id,
                     updated_at = now()
       RETURNING id`,
      [
        data.tenantId,
        data.mongoId,
        meta.type,
        meta.title,
        meta.status,
        null,
        meta.docRef,
        meta.sourceFormat,
        meta.poid ?? null,
        meta.jobId ?? null,
      ]
    );
    const documentId = docRes.rows[0].id;

    // 2) Idempotent replace: drop old chunks for this source id. Step rows
    //    cascade from their section parents, and all of them match sop_id
    //    anyway, so this clears the whole previous tree.
    await client.query(`DELETE FROM chunks WHERE tenant_id = $1 AND sop_id = $2`, [
      data.tenantId,
      data.mongoId,
    ]);

    // 3) Batch-insert new chunks as a single multi-row INSERT with bound
    //    parameters (no value interpolation into SQL text).
    if (chunks.length > 0) {
      const cols = CHUNK_COLUMNS.length;
      const values: unknown[] = [];
      const rowsSql: string[] = [];

      chunks.forEach((chunk, i) => {
        const base = i * cols;
        rowsSql.push(
          "(" +
            CHUNK_COLUMNS.map(
              (_, c) => `$${base + c + 1}${c === EMBEDDING_COL ? "::vector" : ""}`
            ).join(", ") +
            ")"
        );
        values.push(
          data.tenantId,
          data.mongoId, // sop_id (= source mongo _id)
          documentId,
          chunk.sectionPath,
          chunk.question,
          chunk.answer,
          chunk.verdict,
          meta.site,
          meta.vendor,
          meta.po,
          meta.reportDate,
          chunk.content, // content_tsv is generated from this
          toVectorLiteral(vectors[i]),
          "text", // modality (Leg 3 will add others)
          EMBED_MODEL,
          EMBED_VERSION,
          meta.docRef,
          meta.sourceFormat,
          chunk.chunkKind,
          chunk.sectionNo,
          chunk.sectionTitle,
          chunk.stepNo,
          meta.poid ?? null,
          meta.jobId ?? null,
          chunk.page ?? null
        );
      });

      await client.query(
        `INSERT INTO chunks (${CHUNK_COLUMNS.join(", ")}) VALUES ${rowsSql.join(", ")}`,
        values
      );

      // 4) LINK THE TREE (Leg 1). Point every step at the section sharing its
      //    section_no within this document. Done as a set-based UPDATE after
      //    insert rather than a two-phase insert, so the write stays one
      //    statement and does not depend on insert ordering.
      await client.query(
        `UPDATE chunks AS child
            SET parent_chunk_id = parent.id
           FROM chunks AS parent
          WHERE child.tenant_id = $1 AND child.sop_id = $2
            AND child.chunk_kind = 'step'
            AND parent.tenant_id = $1 AND parent.sop_id = $2
            AND parent.chunk_kind = 'section'
            AND parent.section_no = child.section_no`,
        [data.tenantId, data.mongoId]
      );
    }

    // 5) The data engine's rows, replaced in the same transaction as the
    //    chunks so counts and passages can never disagree. Documents that are
    //    not inspection workbooks have none.
    await replaceFacts(client, data.tenantId, documentId, facts ?? null);

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
    if (data.uploadId) await setUploadStatus(data.tenantId, data.uploadId, "processing");
    const { chunks, skipped } = await ingestUpsert(data);
    // A superseded job wrote nothing; the newer job reports the upload's status.
    if (data.uploadId && !skipped) {
      // A file that parses to nothing (e.g. an image-only PDF with no text
      // layer) is not "ready" — nothing in it can ever be found.
      if (chunks === 0) {
        await setUploadStatus(data.tenantId, data.uploadId, "failed", {
          error: "No readable text was found in this file.",
          chunkCount: 0,
        });
      } else {
        await setUploadStatus(data.tenantId, data.uploadId, "ready", { chunkCount: chunks });
      }
    }
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
      try {
        await processIngestJob(job.data);
      } catch (err) {
        // Only the LAST attempt marks the upload failed; earlier ones retry.
        const attempts = job.opts.attempts ?? 1;
        if (job.data.uploadId && job.attemptsMade + 1 >= attempts) {
          await setUploadStatus(job.data.tenantId, job.data.uploadId, "failed", {
            error: err instanceof Error ? err.message : String(err),
          }).catch(() => undefined);
        }
        throw err;
      }
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
