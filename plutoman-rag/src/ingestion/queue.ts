/**
 * BullMQ queue + shared Redis connection for ingestion jobs.
 */
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { config } from "../config";

export const INGEST_QUEUE_NAME = "ingest";

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the ioredis connection it
 * uses for blocking commands. We share one connection factory for queue,
 * worker, and any producers.
 */
export function createRedisConnection(): IORedis {
  return new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

/** Job payload accepted by the ingest queue. */
export interface IngestJobData {
  tenantId: string;
  mongoId: string;
  action: "upsert" | "delete";
  /** For upsert: absolute path to the source file (.xlsx/.pdf/.txt/.csv/.md). */
  fileRef?: string;
  /**
   * For upsert (optional): absolute path to the report's PDF twin. When given,
   * chunks gain POID / Job ID / printed page (see parsePdf.ts), and ingestion
   * FAILS if the PDF is not the same report as the workbook.
   */
  pdfRef?: string;
  /**
   * For upsert: the source file inlined as base64, when the adapter shares no
   * filesystem with the worker.
   *
   * `filename` matters — it is how the worker picks an ingestion strategy
   * (workbook vs SOP tree vs prose), so an inline payload must say what it is.
   * `xlsxBase64` is the Phase-1 field name, kept so existing callers keep
   * working; new callers should send `fileBase64` + `filename`. `pdfBase64` is
   * an inline PDF twin of a workbook (see pdfRef).
   */
  parsedPayload?: {
    xlsxBase64?: string;
    fileBase64?: string;
    filename?: string;
    pdfBase64?: string;
  };
  /** Set for demo-UI uploads: the worker reports progress to this `uploads` row. */
  uploadId?: string;
  /**
   * Per-document sequence number, set by enqueueIngest. The worker applies a
   * job only if no newer job for the same document has been enqueued (see
   * isSuperseded), so the LATEST update always wins whatever order jobs finish
   * in. Absent for inline (non-queued) ingestion, which is always applied.
   */
  seq?: number;
}

/**
 * The producer's Redis connection. Kept in a variable (not inlined) because
 * BullMQ does NOT close a connection instance that was passed in — only ones it
 * created itself — so `ingestQueue.close()` alone leaves this socket open and
 * keeps short-lived scripts (e.g. ingest:demo) from ever exiting. closeQueue()
 * below closes both.
 */
const producerConnection = createRedisConnection();

/** Singleton producer queue. */
export const ingestQueue = new Queue<IngestJobData>(INGEST_QUEUE_NAME, {
  connection: producerConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

/** Graceful shutdown: close the producer queue AND its Redis connection. */
export async function closeQueue(): Promise<void> {
  await ingestQueue.close();
  await producerConnection.quit();
}

/** Redis key holding the latest sequence number enqueued for one document. */
export function seqKey(tenantId: string, mongoId: string): string {
  return `ingest:seq:${tenantId}:${mongoId}`;
}

/**
 * Enqueue an upsert/delete. Every call gets a NEW job: the job id carries a
 * per-document sequence number. (A fixed per-document job id used to make
 * BullMQ silently drop any update of a document whose previous job was still
 * waiting or retained as completed.) Superseded jobs skip themselves in the
 * worker. `|` separates the parts because BullMQ rejects most ids with `:`.
 *
 * `opts` overrides job retention — uploads drop their job (which carries the
 * file bytes) from Redis as soon as it has run.
 */
export async function enqueueIngest(
  data: IngestJobData,
  opts: { removeOnComplete?: boolean | number; removeOnFail?: boolean | number } = {}
): Promise<string> {
  const seq = await producerConnection.incr(seqKey(data.tenantId, data.mongoId));
  const jobId = [data.tenantId, data.mongoId, data.action, seq].join("|");
  const job = await ingestQueue.add(data.action, { ...data, seq }, { jobId, ...opts });
  return job.id ?? jobId;
}
