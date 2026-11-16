# Project Nexus: integration guide

For the developers who will put the assistant inside Plutomen's own product.

Nexus runs as a set of containers on your own machines. Your product talks to
it over a small HTTP API: you send it reports to index, you send it questions,
and it returns an answer with the pages it came from. The web page shipped in
the release (port 4200) is only a test client built on the same API; your own
screen replaces it.

Contents

1. How the pieces fit
2. Reaching the API
3. Signing users in (tokens)
4. Sending reports to be indexed
5. Asking questions
6. Streaming an answer as it is written
7. What comes back
8. Errors and limits
9. Settings
10. Changing the model server
11. Going from the test release to production
12. What is not built yet

---

## 1. How the pieces fit

```
your product (browser or app)
        |  your own session
your backend  -- signs a short-lived token per user --+
        |                                              |
        +--> Nexus API (port 3000 inside Docker) <-----+
                |-- PostgreSQL + pgvector   reports, passages, inspection tables
                |-- Redis                   indexing queue, cache, rate limits
                +-- model server            Ministral 3 14B + nomic-embed-text
```

Nothing leaves your network. The models run locally; there is no call to an
outside service at any point.

Every request carries a token that names the tenant (the customer
organisation). The database enforces that a tenant can only ever read its own
reports (row-level security), so one Nexus installation can serve several of
your customers.

## 2. Reaching the API

The test release publishes one port, the web page on `4200`. The page's web
server forwards anything under `/api/` to the API, so from the same machine the
API is already reachable at:

```
http://localhost:4200/api/healthz
```

For integration work it is simpler to publish the API port itself. Add a file
`docker-compose.override.yml` next to `docker-compose.yml`:

```yaml
services:
  api:
    ports:
      - "3000:3000"
```

then `docker compose up -d`. The API is now at `http://<host>:3000`. All paths
below are relative to that address (or to `http://<host>:4200/api`).

Call the API from your backend where you can. If a browser calls it directly
from another origin, list that origin in `CORS_ORIGINS` (section 9).

## 3. Signing users in (tokens)

Nexus does not have its own login. Your backend, which already knows who the
user is, signs a JSON Web Token and sends it with each request:

```
Authorization: Bearer <token>
```

The token is signed with HS256 using the shared secret `JWT_SECRET`.

| Claim       | Required | Meaning |
|-------------|----------|---------|
| `sub`       | yes      | Your user id. Stored in the audit log with each question. |
| `tenant_id` | yes      | The customer organisation. Decides which reports the user can see. |
| `exp`       | yes, in practice | Expiry. Keep it short (minutes to hours). |
| `iss`, `aud`| optional | Checked only when `JWT_ISSUER` / `JWT_AUDIENCE` are set. |
| `roles`, `sites`, `vendors` | optional | Accepted and carried, but not used to restrict access today. Access is per tenant only. |

Node example (your backend):

```js
import jwt from "jsonwebtoken";

const token = jwt.sign(
  { sub: user.id, tenant_id: user.organisationId },
  process.env.NEXUS_JWT_SECRET,
  { algorithm: "HS256", expiresIn: "15m" }
);
```

Rules:

- The secret stays on your servers. Never send it to a browser or a mobile app.
- A token without `tenant_id` is rejected. There is no default tenant.
- The test release ships with `DEV_MODE=true`, which opens `POST /dev/token`
  so the test page can get a token without a login. Anyone who can reach the
  API can then act as any tenant. Turn it off (`DEV_MODE=false`) and set your
  own `JWT_SECRET` before real data goes in.

## 4. Sending reports to be indexed

### Inspection reports from your system

```
POST /ingest
```

```json
{
  "mongoId": "6712ab34cd56ef7890123456",
  "action": "upsert",
  "xlsxBase64": "<the report workbook, base64>",
  "pdfBase64": "<the same report as PDF, base64, optional>"
}
```

| Field | Meaning |
|-------|---------|
| `mongoId` | Your own id for the report. Sending the same id again replaces the earlier version. |
| `action` | `upsert` (default) or `delete`. |
| `xlsxBase64` or `fileRef` | The workbook, inline, or a path the API container can read. One of the two is required for `upsert`. |
| `pdfBase64` or `pdfRef` | Optional PDF of the same report. It supplies the report id (POID), the Job ID and the printed page numbers used in citations. A PDF that belongs to a different report is rejected. |

Response: `202 {"enqueued": true, "jobId": "..."}`. Indexing runs in the
background and normally takes a few seconds per report. Call this whenever a
report is created, changed or deleted in your system; that keeps the assistant
in step without any batch job.

Request bodies may be up to 25 MB.

### Other documents (procedures, specifications, notes)

```
POST   /uploads        {"filename": "SOP-12.pdf", "fileBase64": "..."}   -> 202 {"upload": {...}}
GET    /uploads        -> {"uploads": [...], "limits": {...}}
DELETE /uploads/{id}   -> 204
```

Accepted: `.pdf`, `.xlsx`, `.csv`, `.txt`, `.md`, up to 15 MB each and 50 files
per tenant by default. Each upload has a `status` of `queued`, `processing`,
`ready` or `failed` (with `error`); poll `GET /uploads` until it is `ready`.

### New report layouts

A new checklist layout does not need the model to be retrained. Indexing reads
the workbook's own structure (sections, check titles, recorded answers, notes,
conclusion) and the assistant works from what it finds. What should be done
with a new layout is a test: index a few reports of that layout and ask the
questions your users would ask. So far the system has been measured on two
layouts (LT Mini Pillar and LT Power Cables, 11 reports).

## 5. Asking questions

There are two ways to ask. Use `/chat` for an assistant panel; it remembers the
conversation. Use `/search` for a single question with no memory.

### A conversation

```
POST /chat
```

```json
{ "message": "Which lots from ABB are on hold?", "conversationId": "optional" }
```

Leave `conversationId` out on the first turn. The response contains one; send
it back on the next turn so follow-ups such as "and for Polycab?" are
understood. A conversation belongs to its tenant; an id from another tenant is
treated as unknown and a new conversation is started.

Optional fields: `topK` (how many passages to retrieve, default 8, maximum 50),
`filters` (`site`, `vendor`, `verdict`), and `generate` (`false` returns the
retrieved passages without a written answer).

### A single question

```
POST /search
```

```json
{ "query": "What was the insulation resistance on PH2026100004?" }
```

Same optional fields as `/chat`.

### curl

```bash
curl -s http://localhost:3000/chat \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"How many checks failed in each report?"}'
```

## 6. Streaming an answer as it is written

```
POST /chat/stream
```

Same request body as `/chat`. The response is a stream of server-sent events,
so your screen can show progress instead of a spinner:

```
event: status
data: {"stage":"searching"}

event: status
data: {"stage":"writing"}

event: delta
data: {"text":"Three reports have checks marked "}

event: delta
data: {"text":"Not Ok: "}

event: status
data: {"stage":"checking"}

event: final
data: { ...the same body POST /chat returns... }
```

| Event | Meaning |
|-------|---------|
| `status` | `searching` (finding the reports and computing figures), `writing` (the model is writing), `checking` (the draft is being checked against the records). |
| `delta` | The next piece of the draft. Join the pieces in order. |
| `final` | The finished response. Its `answer` is the answer of record. |
| `error` | The turn failed. `{"error":"internal_error"}`. |

Important: the text in the `delta` events is a draft. After it is written,
Nexus checks it against the records and may correct it (a missing item, a wrong
count, a missing citation). When `final` arrives, replace the draft on screen
with `final.answer`. The test page shows the draft in grey for this reason.

A comment line (`: keep-alive`) is sent every 15 seconds so that proxies do not
close a quiet connection. If you put a reverse proxy in front, turn response
buffering off for this path; the API already sends `X-Accel-Buffering: no`,
which nginx honours.

Browser example:

```js
const res = await fetch("/api/chat/stream", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ message, conversationId }),
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let end;
  while ((end = buffer.indexOf("\n\n")) >= 0) {
    const block = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    const event = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (!data) continue;
    const body = JSON.parse(data);
    if (event === "delta") showDraft(body.text);
    if (event === "status") showStage(body.stage);
    if (event === "final") showAnswer(body);
  }
}
```

`EventSource` cannot be used because it only supports GET without headers.

## 7. What comes back

`POST /chat` (and the `final` event) returns:

```json
{
  "conversationId": "0b6f...",
  "answer": "Job PH2026100003 (ABB India Limited) has 14 checks marked Not Ok ... [POID-4532592979.pdf p.3]",
  "citations": [
    { "sopId": "...", "sectionPath": "Visual & Physical Checks > Earthing", "poid": "POID-4532592979", "jobId": "PH2026100003", "page": "3" }
  ],
  "results": [ { "id": "...", "content": "...", "score": 0.71, "poid": "...", "jobId": "...", "page": "3", "vendor": "...", "site": "...", "verdict": "NOT OK", "sectionPath": "..." } ],
  "route": "data",
  "tables": [
    { "title": "Checks marked Not Ok per report", "columns": ["report_id", "job_id", "vendor", "failed"], "rows": [ { "report_id": "POID-...", "job_id": "PH2026100003", "vendor": "ABB India Limited", "failed": 14 } ], "sql": "SELECT ..." }
  ],
  "coverage": { "reportsTotal": 11, "reportsInResult": 3 },
  "rewrittenQuery": "...",
  "appliedFilters": { "jobIds": ["PH2026100003"] },
  "verification": { "problems": [], "retried": false, "remaining": [] }
}
```

| Field | Use it for |
|-------|-----------|
| `answer` | The text to show. Sources appear inside it as labels such as `[POID-4532592979.pdf p.3]`. `null` when `generate` was `false`. |
| `citations` | The sources the answer actually cites: report id, Job ID, page and section. Use these to link back to the report in your product. |
| `results` | The passages that were retrieved, best first. Useful for a "sources" panel. |
| `tables` | Present when the question needed counting, listing or comparing across records. These are the exact rows the database computed, and the figures in the answer come from them. Show them under the answer as tables; the test page does. `sql` is the query that produced each one, for audit. |
| `coverage` | How many of the tenant's reports appear in the computed result, out of how many exist. |
| `route` | `"data"` when computed tables were used, absent otherwise. |
| `rewrittenQuery` | What a follow-up was understood to mean. |
| `appliedFilters` | Which reports the question was narrowed to. |
| `verification` | What the answer check found in the first draft and whether a corrected answer replaced it. For diagnostics; do not show to end users. |

`POST /search` returns the same fields without `conversationId` and
`rewrittenQuery`, plus `cached: true` when the answer came from the cache.

How the assistant behaves, so your screen can allow for it:

- It answers only from the indexed reports and says so when they do not record
  something.
- When a question fits several reports and nothing singles one out, it asks
  which is meant or gives each report's value separately.
- When a question assumes something the reports contradict, it says so first.
- It will not reveal its instructions or set the reports aside when asked to.

## 8. Errors and limits

| Status | Body | Meaning |
|--------|------|---------|
| 400 | `{"error":"Invalid body","details":{...}}` | A field is missing or of the wrong type. |
| 401 | `{"error":"Missing or malformed Authorization header"}` / `{"error":"Invalid or expired token"}` | Send a fresh token. |
| 429 | `{"error":"rate_limited"}` with a `Retry-After` header (seconds) | The tenant exceeded `RATE_LIMIT_PER_MIN` requests in this minute. |
| 500 | `{"error":"internal_error"}` | The request failed inside Nexus (for example the model server is down). Details are in the API container's log, never in the response. |

`GET /healthz` returns `{"status":"ok"}` without a token; use it for health
checks. `GET /usage` returns the tenant's question count and generated-token
estimate for today.

Timing. On a single NVIDIA RTX 4090, a lookup in one report takes about 5 to 6
seconds, a question across several reports about 9 seconds, and one question in
ten takes around 30 seconds (the ones whose draft had to be corrected). Without
a GPU an answer takes minutes. Set your HTTP timeouts to at least 120 seconds
and prefer `/chat/stream`, where the first words appear within a few seconds.

## 9. Settings

Set in the `x-nexus-env` block of `docker-compose.yml` (or the API container's
environment).

| Setting | Default in the release | Meaning |
|---------|------------------------|---------|
| `JWT_SECRET` | a placeholder | The shared signing secret. Replace it. |
| `JWT_ISSUER`, `JWT_AUDIENCE` | unset | When set, tokens must carry matching `iss` / `aud`. |
| `DEV_MODE` | `true` | Opens `POST /dev/token`. Must be `false` outside local testing. |
| `CORS_ORIGINS` | `http://localhost:4200` | Comma-separated browser origins allowed to call the API directly. |
| `RATE_LIMIT_PER_MIN` | `120` | Requests per tenant per minute. `RATE_LIMIT_ENABLED=false` turns the limit off. |
| `CACHE_ENABLED` | `false` | Cache identical `/search` questions for `CACHE_TTL_SECONDS` (300). Cleared for a tenant whenever its reports change. |
| `GEN_MODEL` | `ministral-3:14b` | The model that writes answers. |
| `EMBED_MODEL` | `nomic-embed-text` | The model that indexes text. Changing it means re-indexing everything. |
| `DATA_ENGINE`, `DATA_MODE` | `true`, `augment` | Counting, listing and comparing are computed by the database and given to the model. Leave as shipped. |
| `DATA_REPORTS` | `false` | Experimental, leave off. When `true`, for questions about many lots the model first picks one of six ready-made reports whose queries are fixed in code. Measured with Ministral 3 14B it did not improve accuracy on unseen questions. |
| `VERIFY_ANSWERS` | `true` | Check each answer against its sources and correct it once. Leave on. |
| `CHAT_HISTORY_TURNS` | `6` | How many earlier turns a conversation remembers. |
| `UPLOAD_MAX_MB`, `UPLOAD_MAX_FILES` | `15`, `50` | Limits for `/uploads`. |
| `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY` | `ollama`, unset, unset | Which server runs the model (section 10). |
| `READ_DATABASE_URL` | unset | Optional read replica for retrieval. |

## 10. Changing the model server

The model is Ministral 3 14B. By default it is run by Ollama, which is simple
to ship and fine for a handful of users. The same model can be run by any
server that speaks the OpenAI chat-completions API, such as vLLM, which handles
many simultaneous users better. Only settings change:

```yaml
LLM_PROVIDER: openai
LLM_BASE_URL: http://vllm:8000/v1
GEN_MODEL: ministral-3-14b        # the name the server serves the model under
```

Indexing (`EMBED_MODEL`) always stays on Ollama. Measured results for both
servers are in the evaluation notes delivered with the release.

## 11. Going from the test release to production

1. Set a long random `JWT_SECRET` and keep it in your secret store.
2. Set `DEV_MODE=false`.
3. Change the database passwords in `docker-compose.yml` (three places:
   the `postgres` service and the two database URLs).
4. Do not publish the API port to the internet. Keep it on a private network
   and let only your backend reach it, or put it behind your gateway with TLS.
5. The sample reports are indexed on first start under the tenant
   `demo-tenant`. Other tenants cannot see them. Do not issue tokens for
   `demo-tenant` in production.
6. Back up the `nexus-data` volume (PostgreSQL). It holds the index, the
   conversations and the audit log. The index can be rebuilt from your own
   reports; the conversations and audit log cannot.
7. Run on a machine with an NVIDIA GPU of 16 GB or more (24 GB recommended)
   and start with the GPU compose file as described in `RUN_ME.md`.

## 12. What is not built yet

- **Images and other media.** Ministral 3 can read images, and it was chosen
  for that, but the pipeline today indexes and answers from text only. Photos
  attached to a report are noted as attachments and their contents are not
  read.
- **Access narrower than the tenant.** The `roles`, `sites` and `vendors`
  claims are carried but not enforced.
- **Indexing status for `/ingest`.** The call returns a job id and there is no
  endpoint yet to ask whether that job finished. `/uploads` does report status.
- **Deleting a conversation** and listing a user's past conversations.

If any of these is needed for your first release, tell us which and we will
schedule it.
