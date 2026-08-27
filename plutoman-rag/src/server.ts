/**
 * Express entrypoint. Wires JSON parsing, mounts the retrieval/ingest router,
 * and starts listening. Auth is applied per-route inside the router (so /healthz
 * stays public).
 *
 * The ingestion worker runs as a SEPARATE process (`npm run worker`) so heavy
 * embedding/DB work never blocks the API event loop. For a zero-ops local demo
 * you can also start it in-process by setting START_WORKER_INLINE=1.
 */
import express from "express";
import cors from "cors";
import { config } from "./config";
import { router } from "./retrieval/retrievalService";
import { startWorker } from "./ingestion/ingestWorker";
import { assertIsolation } from "./isolationCheck";

const app = express();

// --- CORS (dev) -----------------------------------------------------------
// Enabled BEFORE the routes so preflight (OPTIONS) is answered for every
// endpoint, including the dev-only POST /dev/token. Allowed origins come from
// CORS_ORIGINS (comma-separated; default http://localhost:4200 — the Angular
// dev UI). Simple and dev/demo-focused; tighten for production.
const corsOrigins = config.CORS_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter((o) => o.length > 0);

app.use(
  cors({
    origin: corsOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  })
);

// Reports can be inlined as base64; allow a generous JSON body limit.
app.use(express.json({ limit: "25mb" }));

// Mount the API.
app.use("/", router);

/**
 * Boot sequence (Phase-3): run the isolation self-check BEFORE listening. If the
 * DB connection is unsafe (superuser role, or RLS not enabled+forced on a tenant
 * table) we refuse to serve traffic and exit(1) with a clear message.
 */
async function main(): Promise<void> {
  try {
    await assertIsolation();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    // eslint-disable-next-line no-console
    console.error("[server] refusing to start due to failed isolation self-check");
    process.exit(1);
  }

  // Optional: run the ingest worker in the same process for convenience.
  if (process.env.START_WORKER_INLINE === "1") {
    startWorker();
    // eslint-disable-next-line no-console
    console.log("[server] ingest worker started in-process (START_WORKER_INLINE=1)");
  }

  app.listen(config.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] plutoman-rag listening on http://localhost:${config.PORT}`);
  });
}

void main();
