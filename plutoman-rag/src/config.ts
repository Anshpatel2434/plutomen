/**
 * Centralized, validated configuration.
 * Loads .env once and validates it with zod so the process fails fast on
 * misconfiguration instead of blowing up deep inside a request.
 */
import * as dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const ConfigSchema = z.object({
  DATABASE_URL: z.string().url({ message: "DATABASE_URL must be a valid URL" }),
  // Owner/superuser connection used ONLY by the migration runner (it creates
  // extensions, roles, tables, policies — things the least-privilege app role
  // deliberately cannot do). Optional: falls back to DATABASE_URL if unset.
  MIGRATION_DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url(),
  OLLAMA_URL: z.string().url(),

  EMBED_MODEL: z.string().min(1).default("nomic-embed-text"),
  EMBED_DIM: z.coerce.number().int().positive().default(768),
  EMBED_VERSION: z.string().min(1).default("v1"),
  GEN_MODEL: z.string().min(1).default("mistral"),

  JWT_SECRET: z.string().min(1),

  // --- Conversation memory (multi-turn /chat) -----------------------------
  // How many recent conversation turns to load as history for a /chat turn.
  // Used for (a) history-aware query rewriting (condenseQuery) and (b)
  // conversational coherence in generation. History is NEVER a source of facts.
  CHAT_HISTORY_TURNS: z.coerce.number().int().positive().default(6),

  // --- Keyword ranker (eval change 8) ------------------------------------
  // Share (0..1) of a question's rarity-weighted (IDF) words a chunk must
  // contain to count as a keyword match. See src/retrieval/keywords.ts.
  KW_MIN_MATCH_SHARE: z.coerce.number().min(0).max(1).default(0.4),

  // --- Answer check (eval change 9) ----------------------------------------
  // Check each generated answer against its sources and retry once with the
  // problems found (see src/retrieval/verify.ts). "false" turns it off.
  VERIFY_ANSWERS: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  // --- Phase-3: JWT hardening ---------------------------------------------
  // Optional issuer/audience validation. When set, jwt.verify enforces the
  // `iss` / `aud` claims; when unset, the check is skipped (HS256 default).
  JWT_ISSUER: z.string().min(1).optional(),
  JWT_AUDIENCE: z.string().min(1).optional(),

  PORT: z.coerce.number().int().positive().default(3000),

  // --- Phase-2: Redis query cache -----------------------------------------
  // TTL (seconds) applied to cached /search responses. Keep short enough that
  // eventual staleness between ingests is acceptable; ingest also proactively
  // invalidates the tenant's cache (see src/cache.ts + ingestWorker.ts).
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Master switch. When false, /search bypasses the cache entirely (no reads,
  // no writes). Coerced boolean so "false"/"0" in .env disable it.
  CACHE_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  // --- Phase-2 (cont.): per-tenant rate limiting --------------------------
  // Max /search + /ingest requests per tenant per fixed 60s window. Requests
  // beyond this within the same window get a 429 with Retry-After.
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  // Master switch. When false, the rateLimit middleware is a no-op. Coerced
  // boolean (same enum/transform style as CACHE_ENABLED) so "false"/"0" disable it.
  RATE_LIMIT_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),

  // --- Phase-2 (cont.): read/write split ----------------------------------
  // Optional read-replica connection string. Reads (hybrid retrieval) route
  // here; writes (ingest, audit) always go to DATABASE_URL (the primary). When
  // unset, reads fall back to the primary so the app runs with no replica.
  // Like DATABASE_URL, this can point at its own PgBouncer (transaction mode).
  READ_DATABASE_URL: z.string().url().optional(),

  // --- Dev UI support (CORS + dev-only token endpoint) --------------------
  // Comma-separated list of browser origins allowed to call this API (CORS).
  // Kept as a raw string here; parsed into an array where used (see server.ts).
  // Default matches the local Angular dev UI.
  CORS_ORIGINS: z.string().min(1).default("http://localhost:4200"),
  // Master switch for the dev-only POST /dev/token endpoint. When false the
  // endpoint responds 404 (effectively hidden in prod). Coerced boolean (same
  // enum/transform style as CACHE_ENABLED) so "true"/"1" enable it. Default
  // false — enable ONLY for local demos; the real app supplies JWTs.
  DEV_MODE: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/** Parsed, validated, immutable config for the whole process. */
export const config: AppConfig = ConfigSchema.parse(process.env);
