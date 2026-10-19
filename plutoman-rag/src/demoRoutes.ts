/**
 * Routes for the hosted demo: access-code login and file uploads.
 *
 *   POST   /demo/login     { code }                -> { token, tenantId }
 *   GET    /demo/me        (auth)                  -> { tenantId }
 *   GET    /uploads        (auth)                  -> { uploads, limits }
 *   POST   /uploads        (auth) { filename, fileBase64 } -> 202 { upload }
 *   DELETE /uploads/:id    (auth)                  -> 204
 *
 * LOGIN MODEL. The demo has no user accounts. DEMO_ACCESS_CODES maps each
 * access code to ONE tenant; the code is exchanged for the same short-lived
 * HS256 token the rest of the API already verifies, so every downstream route
 * — search, chat, uploads — is isolated by RLS exactly as in production. This
 * replaces /dev/token, which would mint a token for ANY tenant and must stay
 * off (DEV_MODE=false) on a public URL.
 */
import { Router, Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "./config";
import { requireAuth } from "./auth";
import { rateLimit } from "./rateLimit";
import { enqueueIngest } from "./ingestion/queue";
import { ingestDelete } from "./ingestion/ingestWorker";
import { invalidateTenant } from "./cache";
import { parseAccessCodes } from "./accessCodes";
import {
  ALLOWED_EXTENSIONS,
  createUpload,
  deleteUploadRow,
  getUpload,
  listUploads,
  validateUpload,
} from "./uploads";

/** Forward async errors to Express's error handler (Express 4 does not catch them). */
function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

export const demoRouter = Router();

// ---------------------------------------------------------------------------
// Access-code login
// ---------------------------------------------------------------------------

/** Constant-time compare so response timing does not leak how much of a code matched. */
function codeMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Brute-force guard: at most LOGIN_MAX_ATTEMPTS failed logins per IP per
 * window. In-memory is enough for a single-instance demo; it resets on deploy.
 */
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_ATTEMPTS = 10;
const failures = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: Request): string {
  // Behind Railway's proxy the caller is the first X-Forwarded-For entry.
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

const LoginBody = z.object({ code: z.string().min(1).max(200) });

demoRouter.post("/demo/login", (req: Request, res: Response) => {
  const codes = parseAccessCodes(config.DEMO_ACCESS_CODES);
  if (codes.length === 0) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const ip = clientIp(req);
  const now = Date.now();
  const f = failures.get(ip);
  if (f && f.resetAt > now && f.count >= LOGIN_MAX_ATTEMPTS) {
    res.setHeader("Retry-After", String(Math.ceil((f.resetAt - now) / 1000)));
    res.status(429).json({ error: "Too many attempts. Try again later." });
    return;
  }

  const parsed = LoginBody.safeParse(req.body);
  const given = parsed.success ? parsed.data.code.trim() : "";
  // Compare against EVERY code (no early exit) so timing is independent of
  // which entry matched.
  let tenant: string | null = null;
  for (const c of codes) if (codeMatches(given, c.code)) tenant = c.tenant;

  if (!tenant) {
    const entry = f && f.resetAt > now ? f : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    entry.count++;
    failures.set(ip, entry);
    res.status(401).json({ error: "Invalid access code" });
    return;
  }

  failures.delete(ip);
  const token = jwt.sign(
    { sub: `demo:${tenant}`, tenant_id: tenant, roles: ["viewer"], sites: [], vendors: [] },
    config.JWT_SECRET,
    {
      algorithm: "HS256",
      expiresIn: "12h",
      ...(config.JWT_ISSUER ? { issuer: config.JWT_ISSUER } : {}),
      ...(config.JWT_AUDIENCE ? { audience: config.JWT_AUDIENCE } : {}),
    }
  );
  res.json({ token, tenantId: tenant });
});

demoRouter.get("/demo/me", requireAuth, (req: Request, res: Response) => {
  res.json({ tenantId: req.auth!.tenantId });
});

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

const UploadBody = z.object({
  filename: z.string().min(1).max(255),
  fileBase64: z.string().min(1),
});

demoRouter.get(
  "/uploads",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    res.json({
      uploads: await listUploads(req.auth!.tenantId),
      limits: {
        maxMb: config.UPLOAD_MAX_MB,
        maxFiles: config.UPLOAD_MAX_FILES,
        extensions: ALLOWED_EXTENSIONS,
      },
    });
  })
);

demoRouter.post(
  "/uploads",
  requireAuth,
  rateLimit,
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = UploadBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
      return;
    }
    const { filename, fileBase64 } = parsed.data;
    const tenantId = req.auth!.tenantId;
    const sizeBytes = Buffer.byteLength(fileBase64, "base64");

    const invalid = validateUpload(filename, sizeBytes);
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }

    const created = await createUpload(tenantId, filename, sizeBytes);
    if ("error" in created) {
      res.status(409).json({ error: created.error });
      return;
    }
    const { upload } = created;

    await enqueueIngest(
      {
        tenantId,
        mongoId: upload.mongoId,
        action: "upsert",
        parsedPayload: { fileBase64, filename },
        uploadId: upload.id,
      },
      // The file bytes ride in the job payload; drop the job from Redis once
      // it has run so uploaded files do not accumulate in memory.
      { removeOnComplete: true, removeOnFail: 20 }
    );
    res.status(202).json({ upload });
  })
);

demoRouter.delete(
  "/uploads/:id",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.auth!.tenantId;
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400).json({ error: "Invalid upload id" });
      return;
    }
    const upload = await getUpload(tenantId, id);
    if (!upload) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Remove the indexed content immediately (not via the queue) so a deleted
    // file can never be cited again, then the tracking row, then the cache.
    await ingestDelete({ tenantId, mongoId: upload.mongoId, action: "delete" });
    await deleteUploadRow(tenantId, id);
    await invalidateTenant(tenantId);
    res.status(204).end();
  })
);
