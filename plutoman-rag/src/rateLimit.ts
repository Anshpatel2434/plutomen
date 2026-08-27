/**
 * Phase-2 (cont.): per-tenant rate limiting + token/usage metering, backed by
 * the same Redis that powers the query cache and BullMQ.
 *
 * SECURITY (critical): every key below is NAMESPACED BY tenantId, and the
 * tenantId always comes from the VERIFIED JWT (`req.auth.tenantId`), never from
 * the request body. One tenant can therefore neither consume another tenant's
 * rate-limit budget nor read/inflate another tenant's usage counters — the
 * tenantId is baked into the key prefix (`rl:{tenantId}:...`,
 * `meter:{tenantId}:...`), exactly like the cache's `search:{tenantId}:...`.
 *
 * We reuse `cacheClient` from cache.ts (a plain ioredis client doing
 * INCR/EXPIRE/INCRBY/GET) rather than opening yet another connection.
 */
import { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { cacheClient } from "./cache";

/** Current epoch minute — the fixed-window bucket id. */
function epochMinute(): number {
  return Math.floor(Date.now() / 60_000);
}

/** UTC calendar day (YYYY-MM-DD) — the usage counter bucket id. */
function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/** Daily counters live ~35 days so a month of usage is queryable. */
const USAGE_TTL_SECONDS = 35 * 24 * 60 * 60;

/**
 * Express middleware: fixed-window per-tenant rate limiter.
 *
 * Key `rl:{tenantId}:{epochMinute}` is INCR'd on every request; on the FIRST
 * hit of a window we set EXPIRE 60s so the bucket self-cleans. If the resulting
 * count exceeds RATE_LIMIT_PER_MIN we reject with 429 + Retry-After (seconds
 * until the next window) and JSON `{error:"rate_limited"}`.
 *
 * Disabled entirely (pass-through) when RATE_LIMIT_ENABLED=false.
 *
 * Mount AFTER requireAuth so req.auth is populated; if it somehow isn't, we
 * fail open to the next handler (auth will have already rejected unauth'd
 * requests) rather than 500 here.
 */
export async function rateLimit(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!config.RATE_LIMIT_ENABLED) {
    next();
    return;
  }

  const tenantId = req.auth?.tenantId;
  if (!tenantId) {
    // No verified tenant context — let the (already-applied) auth layer own the
    // rejection; don't invent a limit bucket we can't scope to a tenant.
    next();
    return;
  }

  try {
    const minute = epochMinute();
    // Cross-tenant safety: tenantId (from the verified JWT) is in the key, so
    // each tenant increments its OWN counter — never another tenant's budget.
    const key = `rl:${tenantId}:${minute}`;
    const count = await cacheClient.incr(key);
    if (count === 1) {
      // First hit in this window — arm the 60s TTL so the bucket expires.
      await cacheClient.expire(key, 60);
    }

    if (count > config.RATE_LIMIT_PER_MIN) {
      const secondsUntilNextWindow = 60 - (Math.floor(Date.now() / 1000) % 60);
      res.setHeader("Retry-After", String(secondsUntilNextWindow));
      res.status(429).json({ error: "rate_limited" });
      return;
    }

    next();
  } catch {
    // Redis hiccup: fail OPEN so a cache/Redis outage doesn't take down the API.
    next();
  }
}

/** Usage deltas to record for a single request. */
export interface UsageDelta {
  /** Number of /search requests to add (typically 1). */
  searches?: number;
  /** Approximate generated tokens to add. */
  genTokens?: number;
}

/** Today's usage counters for a tenant. */
export interface UsageSnapshot {
  tenantId: string;
  date: string;
  searches: number;
  genTokens: number;
}

/**
 * Increment daily usage counters for a tenant. Keys:
 *   meter:{tenantId}:{YYYY-MM-DD}:searches
 *   meter:{tenantId}:{YYYY-MM-DD}:genTokens
 * Each is INCRBY'd and given a ~35-day TTL. Best-effort: metering must never
 * break a successful request, so Redis errors are swallowed.
 */
export async function recordUsage(
  tenantId: string,
  delta: UsageDelta
): Promise<void> {
  const day = utcDay();
  const base = `meter:${tenantId}:${day}`;
  try {
    const pipeline = cacheClient.pipeline();
    if (delta.searches) {
      pipeline.incrby(`${base}:searches`, delta.searches);
      pipeline.expire(`${base}:searches`, USAGE_TTL_SECONDS);
    }
    if (delta.genTokens) {
      pipeline.incrby(`${base}:genTokens`, delta.genTokens);
      pipeline.expire(`${base}:genTokens`, USAGE_TTL_SECONDS);
    }
    await pipeline.exec();
  } catch {
    // Metering is non-critical; never surface a Redis error into the request.
  }
}

/** Read today's usage counters for a tenant (0 when unset). */
export async function getUsage(tenantId: string): Promise<UsageSnapshot> {
  const day = utcDay();
  const base = `meter:${tenantId}:${day}`;
  const [searches, genTokens] = await cacheClient.mget(
    `${base}:searches`,
    `${base}:genTokens`
  );
  return {
    tenantId,
    date: day,
    searches: Number(searches ?? 0),
    genTokens: Number(genTokens ?? 0),
  };
}

/**
 * Rough token estimate from generated text. ~4 chars/token is a widely-used
 * approximation; this is for metering/billing signal, not exact accounting.
 */
export function approxTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
