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
  /** For upsert: absolute path to an .xlsx file to parse. */
  fileRef?: string;
  /**
   * For upsert (optional): absolute path to the report's PDF twin. When given,
   * chunks gain POID / Job ID / printed page (see parsePdf.ts), and ingestion
   * FAILS if the PDF is not the same report as the workbook.
   */
  pdfRef?: string;
  /** For upsert: inlined payloads (base64), when the adapter shares no filesystem. */
  parsedPayload?: { xlsxBase64?: string; pdfBase64?: string };
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

/** Convenience producer used by the API + demo script. */
export async function enqueueIngest(data: IngestJobData): Promise<string> {
  // Job id keyed by tenant+mongo+action so duplicate enqueues collapse.
  const jobId = `${data.tenantId}:${data.mongoId}:${data.action}`;
  const job = await ingestQueue.add(data.action, data, { jobId });
  return job.id ?? jobId;
}
