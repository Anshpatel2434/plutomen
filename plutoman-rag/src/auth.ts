/**
 * Authentication middleware.
 *
 * Phase-1: verify a JWT signed with an HS256 shared secret (JWT_SECRET).
 * PROD PATH: swap this for asymmetric RS256 verification against the client
 * IdP's JWKS endpoint (fetch keys from JWKS_URI, cache by `kid`). The claim
 * mapping below stays identical; only the verification key source changes.
 *
 * Phase-3 (JWT hardening): verification uses an EXPLICIT algorithm allowlist
 * (`algorithms: ['HS256']`) so `alg:none` and HS/RS algorithm-confusion attacks
 * are rejected outright. Expiry (`exp`) is enforced by jsonwebtoken by default.
 * A token with no `tenant_id` claim is rejected — it must NEVER be treated as
 * some default tenant. Issuer/audience are validated only when JWT_ISSUER /
 * JWT_AUDIENCE are configured (skipped otherwise).
 *
 * The pure verify+map step lives in the exported `verifyToken()` so it is
 * unit-testable in isolation; the middleware just adapts its result/throw to an
 * Express 401. In the RS256/JWKS production path only the key source and the
 * `algorithms` allowlist (['RS256']) change — the claim mapping is unchanged.
 */
import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config";

/** Identity + tenant context extracted from a verified token. */
export interface AuthContext {
  userId: string;
  tenantId: string;
  roles: string[];
  sites: string[];
  vendors: string[];
}

/** Shape of the claims we expect in the JWT payload. */
interface TokenClaims {
  sub?: string;
  tenant_id?: string;
  roles?: string[];
  sites?: string[];
  vendors?: string[];
}

// Augment Express's Request so downstream handlers get typed access to `req.auth`.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/**
 * Verify a raw JWT string and map its claims to an AuthContext.
 *
 * This is the pure, side-effect-free auth core (no Express types), so it can be
 * unit-tested directly. It THROWS on any failure:
 *   - bad/missing signature, unsupported alg (alg:none / confusion), or expiry
 *     (jsonwebtoken raises inside jwt.verify);
 *   - a missing `sub` or `tenant_id` claim (a token without a tenant must never
 *     be treated as a default tenant).
 * Callers (the middleware) translate any throw into a 401.
 */
export function verifyToken(token: string): AuthContext {
  const decoded = jwt.verify(token, config.JWT_SECRET, {
    // EXPLICIT allowlist — rejects alg:none and algorithm-confusion attacks.
    algorithms: ["HS256"],
    // Only enforced when configured; jsonwebtoken skips these when undefined.
    ...(config.JWT_ISSUER ? { issuer: config.JWT_ISSUER } : {}),
    ...(config.JWT_AUDIENCE ? { audience: config.JWT_AUDIENCE } : {}),
  }) as TokenClaims;

  if (!decoded.sub || !decoded.tenant_id) {
    throw new Error("Token missing required claims (sub, tenant_id)");
  }

  return {
    userId: decoded.sub,
    tenantId: decoded.tenant_id,
    roles: decoded.roles ?? [],
    sites: decoded.sites ?? [],
    vendors: decoded.vendors ?? [],
  };
}

/** Express middleware: verifies the bearer token and attaches `req.auth`. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }

  try {
    req.auth = verifyToken(match[1]);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
