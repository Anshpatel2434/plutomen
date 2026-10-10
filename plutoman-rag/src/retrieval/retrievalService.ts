/**
 * HTTP router for ingestion + retrieval.
 *
 *   POST /ingest   (auth) -> validate + enqueue a BullMQ ingest job
 *   POST /search   (auth) -> hybrid retrieve (RLS-scoped) -> optional generate
 *                            -> write audit row -> return { answer, results }
 *   GET  /healthz          -> liveness probe (no auth)
 *
 * All request bodies are zod-validated. Tenant identity always comes from the
 * verified JWT (req.auth.tenantId), never from the request body — a client
 * cannot ingest into or search another tenant.
 */
import { Router, Request, Response } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { requireAuth } from "../auth";
import { withTenant } from "../db";
import { config } from "../config";
import { buildSearchKey, cacheGetJSON, cacheSetJSON } from "../cache";
import { rateLimit, recordUsage, getUsage, approxTokens } from "../rateLimit";
import { enqueueIngest } from "../ingestion/queue";
import { hybridSearch, rerank, RetrievalFilters } from "./hybrid";
import { generateAnswer } from "./generate";
import { condenseQuery } from "./condense";
import { resolveEntities, resolveChatEntities } from "./entities";
import {
  createConversation,
  conversationExists,
  getRecentMessages,
  appendMessage,
} from "../conversation";

export const router = Router();

// --- schemas ----------------------------------------------------------------

const IngestBody = z.object({
  mongoId: z.string().min(1),
  action: z.enum(["upsert", "delete"]).default("upsert"),
  fileRef: z.string().min(1).optional(),
  // Inline the workbook as base64 when the adapter does not share a filesystem.
  xlsxBase64: z.string().min(1).optional(),
  // Optional PDF twin of the same report (path or base64). Supplies POID,
  // Job ID and printed pages for citations; rejected if it is a different report.
  pdfRef: z.string().min(1).optional(),
  pdfBase64: z.string().min(1).optional(),
});

const SearchBody = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(50).optional(),
  filters: z
    .object({
      site: z.string().optional(),
      vendor: z.string().optional(),
      verdict: z.string().optional(),
    })
    .optional(),
  /** Set false to get raw retrieval hits without LLM generation. */
  generate: z.boolean().default(true),
});

const ChatBody = z.object({
  /** Continue an existing thread; omit (or pass an unknown id) to start fresh. */
  conversationId: z.string().min(1).optional(),
  message: z.string().min(1),
  topK: z.number().int().positive().max(50).optional(),
  filters: z
    .object({
      site: z.string().optional(),
      vendor: z.string().optional(),
      verdict: z.string().optional(),
    })
    .optional(),
  /** Set false to get retrieval hits (with rewritten query) but no LLM answer. */
  generate: z.boolean().default(true),
});

const DevTokenBody = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1).optional(),
  roles: z.array(z.string()).optional(),
  sites: z.array(z.string()).optional(),
  vendors: z.array(z.string()).optional(),
});

// --- routes -----------------------------------------------------------------

router.get("/healthz", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

/**
 * POST /dev/token — DEV-ONLY helper that mints an HS256 JWT so a browser dev UI
 * (e.g. the Angular app on http://localhost:4200) can obtain a token WITHOUT
 * ever seeing JWT_SECRET. This exists ONLY for local demos and MUST stay
 * disabled in production: when config.DEV_MODE is not true the route responds
 * 404 (effectively hidden). In the real app the client IdP supplies JWTs.
 *
 * No requireAuth / rateLimit here by design — it is the way to bootstrap a token
 * in dev. CORS preflight (OPTIONS) is handled globally in server.ts.
 */
router.post("/dev/token", (req: Request, res: Response) => {
  if (!config.DEV_MODE) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const parsed = DevTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const { tenantId, userId, roles, sites, vendors } = parsed.data;

  const token = jwt.sign(
    {
      sub: userId ?? "dev-user",
      tenant_id: tenantId,
      roles: roles ?? ["viewer"],
      sites: sites ?? [],
      vendors: vendors ?? [],
    },
    config.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "12h" }
  );

  res.json({ token });
});

router.post("/ingest", requireAuth, rateLimit, async (req: Request, res: Response) => {
  const parsed = IngestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const { mongoId, action, fileRef, xlsxBase64, pdfRef, pdfBase64 } = parsed.data;
  const tenantId = req.auth!.tenantId; // from verified JWT

  if (action === "upsert" && !fileRef && !xlsxBase64) {
    res.status(400).json({ error: "upsert requires fileRef or xlsxBase64" });
    return;
  }

  const jobId = await enqueueIngest({
    tenantId,
    mongoId,
    action,
    fileRef,
    pdfRef,
    parsedPayload:
      xlsxBase64 || pdfBase64 ? { xlsxBase64, pdfBase64 } : undefined,
  });

  res.status(202).json({ enqueued: true, jobId });
});

router.post("/search", requireAuth, rateLimit, async (req: Request, res: Response) => {
  const parsed = SearchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const { query, topK, filters, generate } = parsed.data;
  const { tenantId, userId } = req.auth!;

  // 0) Cache lookup (tenant-scoped). The key is derived from the VERIFIED
  //    tenantId (never the raw JWT) plus the request shape, so a hit for one
  //    tenant can never be served to another. Disabled entirely when
  //    CACHE_ENABLED=false.
  const cacheKey = config.CACHE_ENABLED
    ? buildSearchKey(tenantId, query, filters, topK, generate)
    : null;

  if (cacheKey) {
    const cached = await cacheGetJSON<Record<string, unknown>>(cacheKey);
    if (cached) {
      // A cache hit still counts as a search for metering, but produces no new
      // generated tokens (the answer was generated on the original miss).
      await recordUsage(tenantId, { searches: 1, genTokens: 0 });
      res.json({ ...cached, cached: true });
      return;
    }
  }

  // 1) Resolve reports named in the question (job / POID / vendor / report
  //    type) into hard filters, then hybrid retrieval (RLS-scoped to tenant
  //    inside hybridSearch). The resolution is deterministic for a given query
  //    and catalog, and ingest invalidates both, so the cache key stays valid.
  const resolved = await resolveEntities(tenantId, query);
  const rawHits = await hybridSearch(tenantId, query, {
    topN: topK ?? 10,
    filters: { ...(filters as RetrievalFilters | undefined), ...resolved.filters },
  });

  // 2) Reranking hook (identity no-op in Phase-1).
  const hits = await rerank(query, rawHits);

  // 3) Optional grounded generation.
  const generation = generate
    ? await generateAnswer(query, hits)
    : { answer: null, citations: hits.map((h) => h.citation) };

  // 4) Audit the request (RLS-scoped write). This is a WRITE, so it MUST go to
  //    the PRIMARY via withTenant() — never the read-only replica path (see
  //    src/db.ts withTenantRead). Retrieval above went through the read path
  //    (hybridSearch -> withTenantRead), but the audit INSERT stays on primary.
  //    Audit is written on every request, including cache misses; cache HITS
  //    short-circuit above and are not re-audited (the original request that
  //    populated the cache was audited).
  await withTenant(tenantId, async (client) => {
    // tenant_id here is the TRUSTED tenant from the verified JWT (req.auth),
    // never the request body — matching the app.tenant_id GUC that RLS enforces.
    await client.query(
      `INSERT INTO audit (tenant_id, user_id, query, retrieved_ids)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, query, hits.map((h) => h.id)]
    );
  });

  const responseBody = {
    answer: generation.answer,
    citations: generation.citations,
    results: hits,
    // Which reports the question was narrowed to (empty object = no narrowing).
    appliedFilters: resolved.applied,
  };

  // 5) Populate the cache on a miss. `cached: true` is added only when SERVING
  //    from cache, so the stored copy never contains that flag.
  if (cacheKey) {
    await cacheSetJSON(cacheKey, responseBody, config.CACHE_TTL_SECONDS);
  }

  // 6) Meter usage on a successful (non-cached) response: one search plus an
  //    approximation of generated tokens from the answer length (0 when
  //    generation was skipped or produced no text).
  await recordUsage(tenantId, {
    searches: 1,
    genTokens: approxTokens(generation.answer),
  });

  res.json(responseBody);
});

/**
 * POST /chat — multi-turn conversational retrieval with memory.
 *
 * Like /search but conversation-aware. Each turn:
 *   1) resolves (or creates) a tenant-scoped conversation,
 *   2) loads recent history (CHAT_HISTORY_TURNS),
 *   3) rewrites the follow-up into a STANDALONE search query (condenseQuery),
 *   4) runs the SAME hybrid retrieval as /search on that rewritten query,
 *   5) generates a grounded, cited answer (history is passed ONLY for coherence,
 *      never as a source of facts), and
 *   6) persists the user + assistant turns.
 *
 * NOT cached: every turn is conversation-specific, so unlike /search there is no
 * Redis cache path here. The /search cache path is left untouched.
 *
 * Tenant + user identity always come from the verified JWT (req.auth), never the
 * body. A conversationId that does not exist FOR THIS TENANT (RLS returns
 * nothing) is treated as "not found" and a fresh conversation is created — a
 * client can never attach to or read another tenant's conversation.
 */
router.post("/chat", requireAuth, rateLimit, async (req: Request, res: Response) => {
  const parsed = ChatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid body", details: parsed.error.flatten() });
    return;
  }
  const { conversationId: reqConversationId, message, topK, filters, generate } =
    parsed.data;
  const { tenantId, userId } = req.auth!; // trusted identity from the JWT

  // 1) Resolve the conversation. Reuse the supplied id only if it exists for
  //    THIS tenant; otherwise start a fresh thread (never leak across tenants).
  let conversationId: string;
  if (reqConversationId && (await conversationExists(tenantId, reqConversationId))) {
    conversationId = reqConversationId;
  } else {
    const created = await createConversation(tenantId, userId, message.slice(0, 80));
    conversationId = created.id;
  }

  // 2) Load recent history (chronological). Empty for a brand-new conversation.
  const history = await getRecentMessages(
    tenantId,
    conversationId,
    config.CHAT_HISTORY_TURNS
  );

  // 3) History-aware rewrite -> standalone search query. Falls back to `message`
  //    on empty history or any Ollama error (never blocks the chat).
  const searchQuery = await condenseQuery(history, message);

  // 4) Resolve the report(s) the turn is about — from the user's own message,
  //    plus the rewrite unless the message is contrastive ("the OTHER Finolex
  //    job") — then hybrid retrieval (RLS-scoped) on the rewritten query.
  const resolved = await resolveChatEntities(tenantId, message, searchQuery);
  const rawHits = await hybridSearch(tenantId, searchQuery, {
    topN: topK ?? 8,
    filters: { ...(filters as RetrievalFilters | undefined), ...resolved.filters },
  });

  // 5) Reranking hook (identity no-op in Phase-1).
  const hits = await rerank(searchQuery, rawHits);

  // 6) Grounded generation. The ORIGINAL user `message` is the question; history
  //    is passed only for conversational coherence (see generateAnswer's
  //    grounding invariant) — answers stay grounded in the retrieved context.
  const generation = generate
    ? await generateAnswer(message, hits, history)
    : { answer: null as string | null, citations: hits.map((h) => h.citation) };

  // 7) Persist both turns (user first, then assistant) so the next turn has
  //    context. Writes go to the primary via appendMessage -> withTenant.
  await appendMessage(tenantId, conversationId, "user", message);
  if (generation.answer !== null) {
    await appendMessage(
      tenantId,
      conversationId,
      "assistant",
      generation.answer,
      generation.citations
    );
  }

  // 8) Audit the request (RLS-scoped WRITE, primary via withTenant) — same
  //    pattern as /search. tenant_id/user_id are the trusted JWT values.
  await withTenant(tenantId, async (client) => {
    await client.query(
      `INSERT INTO audit (tenant_id, user_id, query, retrieved_ids)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, userId, searchQuery, hits.map((h) => h.id)]
    );
  });

  // 9) Meter usage (same as /search): one "search" plus approx generated tokens.
  await recordUsage(tenantId, {
    searches: 1,
    genTokens: approxTokens(generation.answer),
  });

  res.json({
    conversationId,
    answer: generation.answer,
    citations: generation.citations,
    results: hits,
    rewrittenQuery: searchQuery,
    appliedFilters: resolved.applied,
  });
});

/**
 * GET /usage — today's per-tenant usage counters (searches + approx genTokens),
 * scoped to the VERIFIED tenant from the JWT. Read-only; no rate limit needed.
 */
router.get("/usage", requireAuth, async (req: Request, res: Response) => {
  const { tenantId } = req.auth!;
  const usage = await getUsage(tenantId);
  res.json(usage);
});
