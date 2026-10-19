/**
 * File uploads for the demo chat UI.
 *
 * A user uploads a file -> a row in `uploads` (status "queued") -> an ingest
 * job carrying the upload id -> the worker flips it to "processing", then
 * "ready" (with its chunk count) or "failed" (with the reason). The UI polls
 * GET /uploads to show that lifecycle.
 *
 * Every read and write goes through withTenant(), so RLS confines a user to
 * their own tenant's uploads — the same isolation as the rest of the index.
 */
import { withTenant } from "./db";
import { config } from "./config";

export type UploadStatus = "queued" | "processing" | "ready" | "failed";

export interface UploadRow {
  id: string;
  mongoId: string;
  filename: string;
  sizeBytes: number;
  status: UploadStatus;
  error: string | null;
  chunkCount: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Extensions the ingest pipeline can handle (see ingestWorker.buildChunks). */
export const ALLOWED_EXTENSIONS = [".pdf", ".xlsx", ".csv", ".txt", ".md"] as const;

/**
 * The key a file is indexed under — its sanitised filename.
 *
 * Doubles as the citation handle (deriveDocRef strips the extension), so it is
 * kept human-readable: path parts, control characters and anything that could
 * break a [citation tag] are removed.
 */
export function uploadKey(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const cleaned = Array.from(base)
    // Control characters and square brackets (which would break a [citation]).
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch !== "[" && ch !== "]")
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return cleaned || "upload";
}

/** Validate an upload request; returns an error message, or null when OK. */
export function validateUpload(filename: string, sizeBytes: number): string | null {
  const lower = filename.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return `Unsupported file type. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}`;
  }
  if (sizeBytes <= 0) return "The file is empty";
  if (sizeBytes > config.UPLOAD_MAX_MB * 1024 * 1024) {
    return `File is larger than the ${config.UPLOAD_MAX_MB} MB limit`;
  }
  return null;
}

interface DbRow {
  id: string;
  mongo_id: string;
  filename: string;
  size_bytes: number;
  status: UploadStatus;
  error: string | null;
  chunk_count: number | null;
  created_at: Date;
  updated_at: Date;
}

const toRow = (r: DbRow): UploadRow => ({
  id: r.id,
  mongoId: r.mongo_id,
  filename: r.filename,
  sizeBytes: r.size_bytes,
  status: r.status,
  error: r.error,
  chunkCount: r.chunk_count,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

/**
 * Record an upload (or reset an existing one of the same name to "queued").
 * Enforces the per-tenant file cap, counting a re-upload as a replacement.
 */
export async function createUpload(
  tenantId: string,
  filename: string,
  sizeBytes: number
): Promise<{ upload: UploadRow } | { error: string }> {
  const mongoId = uploadKey(filename);
  return withTenant(tenantId, async (client) => {
    const count = await client.query<{ n: string; exists: boolean }>(
      `SELECT count(*) AS n, bool_or(mongo_id = $2) AS exists FROM uploads WHERE tenant_id = $1`,
      [tenantId, mongoId]
    );
    const n = Number(count.rows[0].n);
    if (!count.rows[0].exists && n >= config.UPLOAD_MAX_FILES) {
      return { error: `This workspace already holds ${n} files (limit ${config.UPLOAD_MAX_FILES}). Delete one first.` };
    }
    const res = await client.query<DbRow>(
      `INSERT INTO uploads (tenant_id, mongo_id, filename, size_bytes, status)
       VALUES ($1, $2, $3, $4, 'queued')
       ON CONFLICT (tenant_id, mongo_id)
       DO UPDATE SET filename = EXCLUDED.filename, size_bytes = EXCLUDED.size_bytes,
                     status = 'queued', error = NULL, chunk_count = NULL, updated_at = now()
       RETURNING *`,
      [tenantId, mongoId, filename, sizeBytes]
    );
    return { upload: toRow(res.rows[0]) };
  });
}

export async function listUploads(tenantId: string): Promise<UploadRow[]> {
  return withTenant(tenantId, async (client) => {
    const res = await client.query<DbRow>(
      `SELECT * FROM uploads WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    return res.rows.map(toRow);
  });
}

export async function getUpload(tenantId: string, id: string): Promise<UploadRow | null> {
  return withTenant(tenantId, async (client) => {
    const res = await client.query<DbRow>(`SELECT * FROM uploads WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
    return res.rows[0] ? toRow(res.rows[0]) : null;
  });
}

/** Worker hook: move an upload through its lifecycle. No-op if it was deleted meanwhile. */
export async function setUploadStatus(
  tenantId: string,
  id: string,
  status: UploadStatus,
  extra: { error?: string; chunkCount?: number } = {}
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE uploads SET status = $3, error = $4, chunk_count = $5, updated_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, status, extra.error?.slice(0, 500) ?? null, extra.chunkCount ?? null]
    );
  });
}

export async function deleteUploadRow(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, async (client) => {
    await client.query(`DELETE FROM uploads WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  });
}
