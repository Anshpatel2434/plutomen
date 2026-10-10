/**
 * Phase-2: tenant-scoped Redis query cache for /search responses.
 *
 * We reuse the same Redis that backs BullMQ (REDIS_URL). Cached values are the
 * final /search response JSON, keyed by (tenant, normalized query, filters,
 * topK, generate).
 *
 * SECURITY (critical): every cache key is NAMESPACED BY tenantId
 * (`search:{tenantId}:...`). A cache hit computed for one tenant can never be
 * served to another because the tenantId is baked into the key prefix AND into
 * the hashed payload. The raw JWT is NEVER part of the key — only the verified
 * tenantId (from req.auth) is. Invalidation (invalidateTenant) is likewise
 * scoped to a single tenant's prefix, so one tenant can never flush another's.
 */
import { createHash } from "crypto";
import IORedis from "ioredis";
import { config } from "./config";

/**
 * Dedicated Redis client for the cache. Separate from the BullMQ connection
 * factory (queue.ts) since this one does plain GET/SET/SCAN and does not need
 * BullMQ's `maxRetriesPerRequest: null` blocking-command setting.
 */
export const cacheClient = new IORedis(config.REDIS_URL);

/** Filters shape as it appears in a /search request body (kept loose on purpose). */
export type SearchFilters = Record<string, unknown> | undefined;

/**
 * Build a deterministic, tenant-scoped cache key.
 *
 * Prefix `search:{tenantId}:` isolates tenants (and enables SCAN-based
 * invalidation). The suffix is a sha1 over the normalized query, the
 * canonicalized filters, topK and the generate flag, so semantically identical
 * requests collapse to the same key while different ones do not collide.
 */
export function buildSearchKey(
  tenantId: string,
  query: string,
  filters: SearchFilters,
  topK: number | undefined,
  generate: boolean
): string {
  const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, " ");
  // JSON.stringify(undefined) === undefined, so coalesce to a stable token.
  const filtersPart = filters ? JSON.stringify(filters) : "null";
  const payload = `${normalizedQuery}|${filtersPart}|${topK ?? "default"}|${generate}`;
  const hash = createHash("sha1").update(payload).digest("hex");
  return `search:${tenantId}:${hash}`;
}

/** Read a cached JSON value, or null on miss / parse error. */
export async function cacheGetJSON<T = unknown>(key: string): Promise<T | null> {
  const raw = await cacheClient.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt entry — treat as a miss rather than throwing into the request path.
    return null;
  }
}

/** Store a JSON value with a TTL (seconds). */
export async function cacheSetJSON(
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  await cacheClient.set(key, JSON.stringify(value), "EX", ttlSeconds);
}

/**
 * Invalidate ALL cached search results and derived data for a single tenant.
 *
 * Called after a successful ingest upsert/delete so stale or withdrawn content
 * can never be served from cache. Uses a non-blocking SCAN cursor (never
 * KEYS, which blocks Redis) over the tenant's namespace and DELs in batches.
 * Scoped to `search:{tenantId}:*` and `derived:{tenantId}:*` — one tenant's
 * ingest cannot flush another's.
 */
export async function invalidateTenant(tenantId: string): Promise<number> {
  // Cached /search responses AND per-tenant derived data (see
  // getTenantDerived) — both are stale once this tenant's content changes.
  let deleted = 0;
  for (const pattern of [`search:${tenantId}:*`, `derived:${tenantId}:*`]) {
    let cursor = "0";
    do {
      const [next, keys] = await cacheClient.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100
      );
      cursor = next;
      if (keys.length > 0) {
        deleted += await cacheClient.del(...keys);
      }
    } while (cursor !== "0");
  }
  return deleted;
}

/**
 * Per-tenant DERIVED data cache: small values computed from a tenant's indexed
 * content (e.g. the entity catalog for query filters, the search lexicon for
 * typo correction) that are too costly to recompute on every query.
 *
 * Keyed `derived:{tenantId}:{name}` — tenant-namespaced exactly like the search
 * cache, so one tenant's derived data can never be served to another — and
 * dropped by invalidateTenant() on every ingest, with the TTL as a ceiling.
 * Redis trouble fails OPEN to computing directly: derived data is an
 * optimisation and must never break a request.
 */
export async function getTenantDerived<T>(
  tenantId: string,
  name: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  const key = `derived:${tenantId}:${name}`;
  try {
    const cached = await cacheGetJSON<T>(key);
    if (cached !== null) return cached;
  } catch {
    return compute();
  }
  const value = await compute();
  try {
    await cacheSetJSON(key, value, ttlSeconds);
  } catch {
    // Non-critical: the next request recomputes.
  }
  return value;
}

/** Graceful shutdown helper. */
export async function closeCache(): Promise<void> {
  await cacheClient.quit();
}
