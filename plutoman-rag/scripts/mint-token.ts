/**
 * Dev helper: mint an HS256 JWT for the demo tenant so you can curl the API.
 * NOT for production — prod tokens come from the client IdP (RS256/JWKS).
 *
 * Usage: ts-node scripts/mint-token.ts [tenantId] [userId]
 */
import jwt from "jsonwebtoken";
import { config } from "../src/config";

const tenantId = process.argv[2] ?? "demo-tenant";
const userId = process.argv[3] ?? "demo-user";

const token = jwt.sign(
  { sub: userId, tenant_id: tenantId, roles: ["viewer"], sites: [], vendors: [] },
  config.JWT_SECRET,
  { algorithm: "HS256", expiresIn: "12h" }
);

// eslint-disable-next-line no-console
console.log(token);
