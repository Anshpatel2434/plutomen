# plutoman-rag — Phase-1 foundation

A **multi-tenant hybrid RAG retrieval service**, built as an *extension* that
plugs into a client's existing MEAN app. The client's **MongoDB stays the source
of truth**; this service owns a single shared **PostgreSQL** used purely as a
derived, rebuildable retrieval index.

> **Status:** Phase-1 verified end-to-end (11 reports → 504 chunks; RLS isolation
> proven; grounded cited answers). Phase-2 adds PgBouncer connection pooling, a
> tenant-scoped Redis query cache, and an automated RLS test suite. Phase-3 adds
> isolation hardening (explicit per-query tenant predicate, startup self-check,
> JWT alg allowlist + claim validation, adversarial test suite).

## Architecture (one paragraph)

A data-transfer adapter in the client's app pushes inspection reports to our
`/ingest` API, which enqueues a **BullMQ** (Redis) job. A worker parses the
inspection-report spreadsheet, chunks it (one chunk per checklist row /
observation / conclusion field), embeds each chunk via self-hosted **Ollama**
(`nomic-embed-text`, 768-dim, with the required `search_document:` task prefix),
and writes rows into Postgres. Every row carries a `tenant_id` and isolation is
enforced by **Row-Level Security** — one shared database, no per-tenant schemas.
`/search` runs **hybrid retrieval** — pgvector dense (HNSW, cosine) plus Postgres
full-text (`tsvector` + GIN) — fused with **Reciprocal Rank Fusion (RRF)** in a
single SQL statement, then optionally calls Ollama (`mistral`) for a grounded,
cited answer. All tenant data access goes through `withTenant()`, which sets
`app.tenant_id` per transaction so RLS scopes every query automatically.

## Prerequisites

- Node.js 20+ (Node 24 is supported and verified)
- Docker + Docker Compose (for Postgres/pgvector, PgBouncer, Redis, Ollama)
- ~5 GB disk for the Ollama models

> **Ports (Phase-1 fixes discovered during testing):** Postgres is published on
> host port **5544** (not 5432) to avoid colliding with a native Postgres
> install. The app connects through **PgBouncer on host port 6432**; migrations
> connect **directly to Postgres on 5544** (see `MIGRATION_DATABASE_URL`).

## Step-by-step: run it

```bash
# 1. Bring up infra (Postgres w/ pgvector, Redis, Ollama)
docker compose up -d

# 2. Pull the inference models into the Ollama container
docker compose exec ollama ollama pull nomic-embed-text
docker compose exec ollama ollama pull mistral      # or: ollama pull llama3.3

# 3. Configure env
cp .env.example .env
#   - DATABASE_URL for migrations may use the OWNER role; the app itself should
#     connect as the non-owner plutoman_app role (see .env.example notes).

# 4. Install deps
npm install

# 5. Create schema + RLS (run as DB owner)
npm run migrate

# 6. Ingest the demo corpus (runs inline; needs Ollama up + model pulled)
npm run ingest:demo
#   (add `-- --enqueue` to push to BullMQ instead; then run `npm run worker`)

# 7. Start the API (worker runs separately in prod)
npm run dev            # API on http://localhost:3000
npm run worker         # ingest worker (separate terminal) — only if using --enqueue

# 8. Mint a demo JWT and hit /search
TOKEN=$(npx ts-node scripts/mint-token.ts demo-tenant demo-user)
curl -s http://localhost:3000/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"Which sheet steel thickness failed inspection?","topK":5}' | jq
```

`/healthz` is public; `/ingest` and `/search` require the bearer token.

## Run everything in Docker (testers)

No Node.js needed — only Docker. Everything below runs from `plutoman-rag/`.

```bash
# First run: build the images, start the stack, pull the models and index the
# 11 demo reports (the model download is ~4.7 GB, once).
docker compose --profile app --profile demo up -d --build

# Watch the demo indexing finish (`[ingest:demo] done.`), then open the UI:
docker compose logs -f ingest-demo
#   UI   http://localhost:8080   (calls the API through /api)
#   API  http://localhost:3000   (same API, direct)
```

Later runs only need `docker compose --profile app up -d`. To re-index the demo
reports, `docker compose --profile demo run --rm ingest-demo`.

| Service | Image | Role |
|---|---|---|
| `api` | `plutoman-rag:local` | REST API (`/search`, `/chat`, `/ingest`, …), host port `API_HOST_PORT` (3000) |
| `worker` | `plutoman-rag:local` | ingest queue worker |
| `web` | `plutoman-web:local` | demo UI on nginx, host port `WEB_HOST_PORT` (8080); proxies `/api` to `api` |
| `migrate` | `plutoman-rag:local` | one-shot: schema, roles, RLS (re-runs safely on every `up`) |
| `ollama-pull` | `ollama/ollama` | one-shot: pulls `nomic-embed-text` and `GEN_MODEL` |
| `ingest-demo` | `plutoman-rag:local` | one-shot, profile `demo`: indexes `../demo_data` |

Notes:

- Plain `docker compose up -d` (no profile) still starts only the
  infrastructure, for the `npm` workflow above.
- **Port clash?** Every host port is configurable: `POSTGRES_HOST_PORT`,
  `PGBOUNCER_HOST_PORT`, `REDIS_HOST_PORT`, `OLLAMA_HOST_PORT`, `API_HOST_PORT`,
  `WEB_HOST_PORT`, e.g. `POSTGRES_HOST_PORT=5546 docker compose --profile app up -d`.
- **NVIDIA GPU** for Ollama:
  `docker compose -f docker-compose.yml -f docker-compose.gpu.yml --profile app up -d`.
  On CPU only, generated answers can take minutes each.
- This is a **test stack**: `DEV_MODE` defaults to `true` here so the UI can mint
  demo tokens, and the passwords are the demo ones. Do not expose it.
- To queue demo jobs through the worker instead of indexing inline:
  `docker compose --profile demo run --rm ingest-demo node dist/scripts/ingest-demo.js --enqueue`.

## Env vars

| Variable          | Meaning                                                        | Default              |
|-------------------|---------------------------------------------------------------|----------------------|
| `DATABASE_URL`    | App Postgres URL — points at **PgBouncer (host 6432)**, non-owner role | —           |
| `MIGRATION_DATABASE_URL` | Owner URL for `npm run migrate` — **direct to Postgres (host 5544)**, bypasses PgBouncer | falls back to `DATABASE_URL` |
| `PG_APP_USER`     | Least-privilege app role name                                 | `plutoman_app`       |
| `PG_APP_PASSWORD` | App role password                                             | `app_password`       |
| `REDIS_URL`       | Redis URL for BullMQ                                          | `redis://localhost:6379` |
| `OLLAMA_URL`      | Ollama HTTP endpoint                                          | `http://localhost:11434` |
| `EMBED_MODEL`     | Embedding model                                              | `nomic-embed-text`   |
| `EMBED_DIM`       | Embedding dimensionality (must match schema `vector(768)`)   | `768`                |
| `EMBED_VERSION`   | Internal embed schema version (stamped on rows)             | `v1`                 |
| `GEN_MODEL`       | Generation model (`mistral` or `llama3.3`)                  | `mistral`            |
| `JWT_SECRET`      | HS256 secret for Phase-1 auth (prod: JWKS/RS256)           | —                    |
| `JWT_ISSUER`      | Optional expected `iss` claim; validated only when set (Phase-3) | *(unset)*      |
| `JWT_AUDIENCE`    | Optional expected `aud` claim; validated only when set (Phase-3) | *(unset)*      |
| `PORT`            | HTTP port                                                   | `3000`               |
| `CHAT_HISTORY_TURNS` | Recent conversation turns loaded as history per `/chat` turn (coherence + query rewrite) | `6` |
| `CACHE_TTL_SECONDS` | TTL for cached `/search` responses (Phase-2)             | `300`                |
| `CACHE_ENABLED`   | Master switch for the Redis query cache (Phase-2)          | `true`               |
| `RATE_LIMIT_PER_MIN` | Max `/search` + `/ingest` requests per tenant per 60s window (Phase-2 cont.) | `120` |
| `RATE_LIMIT_ENABLED` | Master switch for per-tenant rate limiting (Phase-2 cont.) | `true`             |
| `READ_DATABASE_URL` | Read-replica URL for reads (retrieval); writes stay on `DATABASE_URL` (Phase-2 cont.) | falls back to `DATABASE_URL` |
| `CORS_ORIGINS`    | Comma-separated browser origins allowed to call the API (dev UI support) | `http://localhost:4200` |
| `DEV_MODE`        | Enables the dev-only `POST /dev/token` endpoint; `404` when off. **Local demos only** | `false` |

## Dev UI support (dev-only)

Two small additions let a browser dev UI (e.g. an Angular app on
`http://localhost:4200`) talk to this API locally. **Both are for dev/demo only.**

- **CORS** — enabled before the routes in `src/server.ts`. Allowed origins come
  from `CORS_ORIGINS` (comma-separated; default `http://localhost:4200`); methods
  `GET`/`POST`/`OPTIONS` and headers `Authorization` + `Content-Type` are allowed.
  Preflight (`OPTIONS`) is answered for every route, including `/dev/token`.
- **`POST /dev/token`** — a dev-only endpoint that mints an HS256 JWT so the
  browser can obtain a token **without ever seeing `JWT_SECRET`**. It is gated by
  `DEV_MODE`: when `DEV_MODE` is not `true` the route returns **`404`**
  (effectively hidden in prod). It has **no** auth or rate-limit middleware by
  design. In the real app, JWTs come from the client IdP — keep `DEV_MODE=false`
  in production.

Request body (`tenantId` required; the rest optional):

```json
{ "tenantId": "demo-tenant", "userId": "dev-user", "roles": ["viewer"], "sites": [], "vendors": [] }
```

Response: `{ "token": "<jwt>" }`. Claims: `sub` (from `userId`, default
`"dev-user"`), `tenant_id`, `roles` (default `["viewer"]`), `sites`, `vendors`,
expiring in `12h`.

```bash
# Enable DEV_MODE=true in .env and restart the API first.
curl -s http://localhost:3000/dev/token \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"demo-tenant","userId":"dev-user"}' | jq
# -> { "token": "..." }   (with DEV_MODE=false this returns 404)
```

## Phase 2

Three additive features layered onto the verified Phase-1 foundation. None of
them changes the `withTenant()` / RLS invariants.

### 1. PgBouncer connection pooling

A `pgbouncer` service (image `edoburu/pgbouncer`) sits in front of Postgres and
is published on host port **6432**. The app's `DATABASE_URL` points at it;
migrations keep pointing **directly** at Postgres (5544) via
`MIGRATION_DATABASE_URL`.

- **`POOL_MODE=transaction` is correctness-critical.** It is safe *only* because
  `withTenant()` scopes the tenant GUC with
  `set_config('app.tenant_id', …, is_local=true)` inside a `BEGIN/COMMIT`. The
  tenant context lives and dies within a single transaction, so a pooled backend
  can never leak tenant context to the next client. Session pooling would waste
  the pool; statement pooling would break transactions. **Do not** change
  withTenant's transaction wrapping, and **do not** introduce named prepared
  statements or session-level `SET` without revisiting the pool mode (see the
  note in `src/db.ts`).
- Migrations bypass the pooler because DDL and session-level features are
  incompatible with transaction pooling.

### 2. Tenant-scoped Redis query cache

`src/cache.ts` caches `/search` responses in Redis (reusing `REDIS_URL`).

- **Keys are namespaced by tenant:** `search:{tenantId}:{sha1(query|filters|topK|generate)}`.
  A hit for one tenant can never be served to another. The **raw JWT is never**
  part of the key — only the verified `tenantId` from `req.auth`.
- On a hit, `/search` returns the cached JSON immediately with `"cached": true`.
  On a miss it runs retrieval/generation, then caches the response for
  `CACHE_TTL_SECONDS`. Set `CACHE_ENABLED=false` to bypass the cache entirely.
- **Freshness/compliance:** after a successful ingest upsert *or* delete, the
  worker calls `invalidateTenant(tenantId)` (SCAN + DEL over that tenant's
  prefix) so stale or withdrawn content can't be served from cache.

### 3. Automated RLS test suite

`test/rls.test.ts` uses Node's built-in test runner and connects as the **app
role** (through whatever `DATABASE_URL` points at) to *prove* tenant isolation:
tenant A sees only its own rows; tenant B sees none of A's; a query with no
tenant set returns 0 rows (fails **closed**); a cross-tenant INSERT is rejected
by `WITH CHECK`; and cross-tenant UPDATE/DELETE affect 0 rows. It is
self-contained and idempotent (dedicated `rlstest-a` / `rlstest-b` tenants,
cleaned up afterward).

```bash
# Requires a running DB with migrations applied first:
docker compose up -d && npm run migrate
npm test        # -> tsx --test test/*.test.ts (exits non-zero on failure)
```

## Phase 2 (cont.)

Three more additive features on the same foundation. None changes the
`withTenant()` / RLS invariants; reads gain a parallel `withTenantRead()` that is
identical except it targets the replica pool and is `SET TRANSACTION READ ONLY`.

### 4. Per-tenant rate limiting

`src/rateLimit.ts` adds a Redis-backed **fixed-window** limiter (reusing the
cache's ioredis client). The `rateLimit` middleware is mounted on `/search` and
`/ingest` **after** `requireAuth`, so it reads the tenant from the verified JWT
(`req.auth.tenantId`), never the body.

- Key `rl:{tenantId}:{epochMinute}` is `INCR`'d per request; the first hit of a
  window arms `EXPIRE 60`. When the count exceeds `RATE_LIMIT_PER_MIN`, the
  request gets **HTTP 429** with a `Retry-After` header (seconds to the next
  window) and JSON `{"error":"rate_limited"}`.
- Keys are **namespaced by tenantId**, so one tenant can never consume another's
  budget. Set `RATE_LIMIT_ENABLED=false` to disable entirely. On a Redis error
  the middleware **fails open** (never takes down the API).

**Verify:**

```bash
TOKEN=$(npx ts-node scripts/mint-token.ts demo-tenant demo-user)
# Temporarily lower the limit to see 429 quickly, e.g. RATE_LIMIT_PER_MIN=5, restart the API.
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code} " http://localhost:3000/search \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d '{"query":"steel thickness","generate":false}'
done; echo
# Expect: 200s until the limit, then 429s. Inspect Retry-After:
curl -s -D - -o /dev/null http://localhost:3000/search \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"steel thickness","generate":false}' | grep -i retry-after
```

### 5. Token / usage metering + `GET /usage`

Also in `src/rateLimit.ts`. Daily per-tenant counters in Redis:
`meter:{tenantId}:{YYYY-MM-DD}:searches` and `:genTokens` (`INCRBY`, ~35-day
TTL).

- `/search` calls `recordUsage(tenantId, {searches:1, genTokens})` on a
  successful **non-cached** response; `genTokens` is approximated from the
  generated answer length (~4 chars/token, `0` when generation is skipped).
- A **cache hit still counts a search** (`searches:1, genTokens:0`).
- `GET /usage` (requires auth) returns today's counters for the caller's tenant:
  `{ tenantId, date, searches, genTokens }`.

**Verify:**

```bash
curl -s http://localhost:3000/usage -H "Authorization: Bearer $TOKEN" | jq
# Run a few /search calls, then GET /usage again and watch searches/genTokens climb.
```

### 6. Read/write split (read-replica routing)

App-side routing so reads can be served by a replica while writes stay on the
primary. This is the **durable** part; the replica container is best-effort.

- `src/db.ts` adds `readPool` (`READ_DATABASE_URL ?? DATABASE_URL`) and
  `withTenantRead()` — same tenant-scoped BEGIN/COMMIT + `set_config` as
  `withTenant()`, plus `SET TRANSACTION READ ONLY` so an accidental write on the
  read path fails loudly. `closePool()` now ends both pools.
- `hybridSearch()` (read-only) uses `withTenantRead()`. The **audit INSERT in
  `/search` stays on the primary** via `withTenant()` (it's a write).
- **When `READ_DATABASE_URL` is unset, reads fall back to the primary** — the app
  runs with no replica at all. Both URLs may point at their own PgBouncer.

**Optional replica container (`postgres-replica`, host port 5545):**

```bash
# Start (or restart) the stack; the replica clones the primary on first boot.
docker compose up -d postgres postgres-replica
docker compose logs -f postgres-replica   # watch for "starting as hot standby"

# Point the app's reads at the replica (in .env), then restart the API:
#   READ_DATABASE_URL=postgres://plutoman_app:app_password@localhost:5545/plutoman
# /search now retrieves from the replica; /ingest + audit still hit the primary.

# Confirm replication is streaming (on the primary):
docker compose exec postgres psql -U plutoman_owner -d plutoman \
  -c "SELECT client_addr, state, sync_state FROM pg_stat_replication;"
```

> **Replica caveats (best-effort):** The replica's first-boot clone only works
> if the **primary was initialized on a fresh volume** so `db/replication/
> init-replication.sql` (creates the `replicator` role) and
> `init-replication.sh` (adds the `host replication ...` pg_hba rule + reloads)
> ran during initdb. If your `pgdata` volume predates this change, either
> `docker compose down -v` (destroys data) and re-migrate, or apply both steps
> manually (see the header comments in those two files), then start the replica.
> The replica is **optional** — leave `READ_DATABASE_URL` unset to run entirely
> on the primary.

## Phase 3 — Isolation Hardening (defense in depth)

Additive hardening on the verified foundation. **Nothing here weakens or replaces
RLS or `withTenant()`** — RLS remains the primary control. Phase-3 adds a second,
independent layer so a hypothetical single-point misconfig still cannot leak.

### 1. Explicit per-query tenant predicate

`hybridSearch()` (`src/retrieval/hybrid.ts`) now binds an explicit
`tenant_id = $N` predicate (from the trusted JWT tenantId) into **both** the
dense (`vec`) and sparse (`kw`) candidate CTEs, alongside `modality='text'`.
This is **redundant with RLS by design** — belt-and-suspenders — so even if an
RLS policy were mis-deployed, cross-tenant chunks are still filtered out. The
`/search` audit INSERT continues to use the trusted `req.auth` tenant.

### 2. Startup isolation self-check (fail fast)

`src/isolationCheck.ts` exports `assertIsolation()`, called in `src/server.ts`
**before `app.listen`**. Using the app pool it asserts:

- the app role is **NOT a superuser** (`pg_roles.rolsuper`) — superusers bypass RLS;
- RLS is **ENABLED and FORCED** (`pg_class.relrowsecurity` **and**
  `relforcerowsecurity`, schema `public`) on `documents`, `chunks`, `audit`.

On success it logs
`[isolation] self-check passed (non-superuser role, RLS enabled+forced on all tenant tables)`.
On any failure it logs a clear message and **`process.exit(1)`** — the service
refuses to accept traffic in an unsafe state.

### 3. JWT hardening (`src/auth.ts`)

- Verification uses an **explicit algorithm allowlist** (`algorithms: ['HS256']`)
  so `alg:none` and HS/RS **algorithm-confusion** attacks are rejected.
- Tokens are rejected (401) when the signature fails, when **expired** (`exp`,
  enforced by jsonwebtoken), or when the **`tenant_id` claim is missing** — a
  token with no tenant is never treated as some default tenant.
- Optional **`iss` / `aud`** validation when `JWT_ISSUER` / `JWT_AUDIENCE` are set
  (skipped otherwise).
- The pure verify+map step is now the exported **`verifyToken(token): AuthContext`**
  (the middleware just adapts its result/throw to a 401), making it unit-testable.
  The RS256/JWKS production path only swaps the key source and the allowlist.

### 4. Adversarial isolation test suite

`test/isolation.test.ts` (Node's built-in runner, part of the `test/*.test.ts`
glob) covers: the explicit-predicate cross-tenant sanity check (DB-connected,
reusing the `rlstest-a`/`rlstest-b` pattern); `alg:none` rejected; expired token
rejected; missing-`tenant_id` rejected; a valid token mapping to the right
tenant; and tenant-namespaced cache keys not colliding across tenants.

```bash
# DB-connected cases require a running DB with migrations applied:
docker compose up -d && npm run migrate
npm test        # -> tsx --test test/*.test.ts (exits non-zero on failure)
```

To see the startup self-check: `npm run dev` prints the `[isolation] self-check
passed …` line before `listening on …`. To see it fail fast, point
`DATABASE_URL` at a superuser role (or a DB where RLS is not forced) — the server
logs the failure and exits with code 1 instead of listening.

## Conversation memory (multi-turn `/chat`)

`POST /chat` (auth + rate-limited) adds multi-turn memory on top of the same
hybrid retrieval that powers `/search`. Conversations and their messages live in
two new tenant-owned tables (`conversations`, `messages`, migration
`002_conversations.sql`) with the **same RLS ENABLED + FORCED** discipline as the
rest of the schema — they are tenant-isolated exactly like `documents` /
`chunks` / `audit`.

**Request** (`message` required; the rest optional):

```json
{
  "conversationId": "…",        // omit to start a new thread
  "message": "what about the cables?",
  "filters": { "site": "…", "vendor": "…", "verdict": "…" },
  "topK": 8,
  "generate": true               // false = hits + rewritten query, no LLM answer
}
```

**Response:**

```json
{
  "conversationId": "…",         // reuse this on the next turn
  "answer": "…",                 // null when generate=false
  "citations": [{ "sopId": "…", "sectionPath": "…" }],
  "results": [ /* retrieval hits */ ],
  "rewrittenQuery": "…"          // the standalone query actually retrieved on
}
```

**How a turn flows:**

1. Identity (`tenantId`, `userId`) comes from the verified JWT, never the body.
2. The conversation is resolved: a supplied `conversationId` is reused **only if
   it exists for this tenant** (RLS makes an unknown/foreign id return nothing,
   which is treated as "not found" → a fresh conversation is created). No client
   can attach to another tenant's thread.
3. The last `CHAT_HISTORY_TURNS` (default `6`) messages are loaded as history.
4. **History-aware rewriting** (`src/retrieval/condense.ts`): a follow-up like
   "what about the cables?" is rewritten into a **standalone search query** that
   folds in the entity/topic from prior turns, via the same Ollama `GEN_MODEL`.
   On empty history or any error it falls back to the raw message — condensing
   never blocks the chat.
5. Hybrid retrieval runs on the **rewritten** query (`rewrittenQuery` in the
   response shows what was actually searched).
6. Generation answers **strictly from the retrieved context** and cites sources.
   History is passed to the model **only for conversational coherence**
   (resolving pronouns / keeping the topic) — it is **never a source of facts**,
   so answers stay grounded and cited (see the grounding invariant comment in
   `src/retrieval/generate.ts`).
7. The user and assistant turns are persisted (tenant-scoped writes on the
   primary), and the request is audited + metered like `/search`.

`/chat` is **not cached** (each turn is conversation-specific); the `/search`
cache path is untouched.

**Two-turn context-retention demo:**

```bash
# DEV_MODE=true (or mint a token however you normally do)
TOKEN=$(curl -s http://localhost:3000/dev/token \
  -H "Content-Type: application/json" \
  -d '{"tenantId":"demo-tenant","userId":"dev-user"}' | jq -r .token)

# Turn 1 — ask about the mini pillars. Capture the returned conversationId.
CID=$(curl -s http://localhost:3000/chat \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"What issues were found on the LT mini pillars?"}' \
  | tee /dev/stderr | jq -r .conversationId)

# Turn 2 — a context-dependent follow-up. Reuse the SAME conversationId.
curl -s http://localhost:3000/chat \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"conversationId\":\"$CID\",\"message\":\"what about the cables?\"}" | jq
# Inspect `.rewrittenQuery` on turn 2 — it should be standalone, e.g.
# "cables on the LT mini pillars", proving the follow-up picked up prior context.
```

## Multi-tenancy / RLS notes

- One shared Postgres, `tenant_id` on every tenant-owned row.
- `documents`, `chunks`, `audit` have RLS **ENABLED + FORCED**.
- Policies filter on `current_setting('app.tenant_id', true)`. If the GUC is
  unset the predicate matches no rows — it fails **closed**, never open.
- The app **must** connect as the non-owner `plutoman_app` role and every
  tenant query **must** go through `withTenant()` (`src/db.ts`).

## Phase-1 scope / not yet

- **Multimodal** (images/videos/documents attached to checklist rows). The
  `chunks.modality` column and a `modality='text'` retrieval filter already exist
  as hooks; image/table embedding + fusion is future work.
- **Per-tenant schema isolation** — intentionally NOT done; single shared DB with
  RLS is the chosen model.
- **Reranker** — `rerank()` in `src/retrieval/hybrid.ts` is an identity stub;
  wire a self-hosted cross-encoder later.
- **Streaming generation**, JWKS/RS256 auth, and a Mongo change-stream adapter
  are also future phases.
```
