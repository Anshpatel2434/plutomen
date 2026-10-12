# Rollback — golden-eval changes

Branch: `testing/pipeline-docker`. **`main` is not affected by any of this.**
Current status against the golden set: [GOLDEN_EVAL_STATUS.md](GOLDEN_EVAL_STATUS.md).

## Round 4 (Docker, queue, replica, notes, change 10)

| Commit | What it changes | Index needs re-ingest? |
|---|---|---|
| `01447a1` | **Eval change 10**: table-of-contents and footer chunks from the PDF | yes |
| `88c648b` | conclusion-row notes indexed | yes |
| `5c4da9e` | citation ranges such as `[S1-S10]` rendered | no |
| `a99a033` | replica: own profile, replication slot, `max_slot_wal_keep_size` | no |
| `556b2b5` | Docker images + compose `app` / `demo` profiles; UI calls `/api` | no |
| `21a628b` | ingest queue: unique sequenced jobs, newest update wins | no |
| tag `pre-round-4` (`1ab0db9`) | the state before this round | — |

No migration in this round. Each commit reverts on its own:

```bash
git revert --no-edit 01447a1                     # e.g. undo change 10 only
git revert --no-edit pre-round-4..HEAD           # undo the whole round
npm run build                                    # or rebuild the images:
docker compose --profile app up -d --build
```

After reverting `01447a1` or `88c648b`, re-index (`npm run ingest:demo`, or
`docker compose --profile demo run --rm ingest-demo`); each report replaces
its own copy, so nothing is duplicated. Reverting `556b2b5` puts the UI back on
`http://localhost:3000` (CORS) and removes the app containers; the
infrastructure services are unchanged. After reverting `a99a033`, drop the slot
on the primary if a replica was ever started with it:
`SELECT pg_drop_replication_slot('plutoman_replica');`.

---

## Changes 6 and 7 (answer generation — no database changes)

| Commit | What it changes |
|---|---|
| `90fa155` | **Eval change 6** — answer policy as a system prompt, sources grouped by report, instruction-leak guard, `src/llm.ts` |
| `68e83c5` | a failed request returns a 500 instead of crashing the API |
| `5c3eb59` | web UI shows `CONDITIONAL` verdicts as neutral |
| `20d42d2` | **Eval change 7** — citations list only the sources the answer uses |
| tag `pre-eval-6-7` (`8f8e209`) | the state before this round |

No migration, no re-ingest. Change 6 is the one with mixed results on Mistral 7B
(see the status file) and reverts on its own:

```bash
git revert --no-edit 90fa155                     # undo #6 only (keeps #7)
git revert --no-edit pre-eval-6-7..HEAD          # undo the whole round
npm run build                                    # then restart the API
```

If answers are cached in Redis (`CACHE_ENABLED=true`), re-ingesting or waiting
for the cache TTL clears answers produced by the reverted code.

---

## Changes 5 and 8 (retrieval only — no database changes)

| Commit | What it changes |
|---|---|
| `781d83d` | **Eval change 8** — rarity-weighted any-word keyword search, typo correction, `KW_MIN_MATCH_SHARE` setting |
| `0bb01a8` | **Eval change 5** — job / POID / vendor / report-type filters resolved from the question; `appliedFilters` in responses |
| `ed18a01` | groundwork for both — tenant-scoped derived-data cache, cleared on ingest |
| tag `pre-eval-5-8` (`032df8c`) | the state before this round |

These change only how retrieval queries the existing index: **no migration, no
re-ingest, no snapshot needed.** Verified on 10 Oct 2026: #8 alone, #5 alone and
the whole range each revert cleanly, compile and pass the offline tests.

```bash
git revert --no-edit 781d83d                     # undo #8 only
git revert --no-edit 0bb01a8                     # undo #5 only
git revert --no-edit pre-eval-5-8..HEAD          # undo #5, #8 and the groundwork
npm run build                                    # then restart the API
```

Revert `ed18a01` only together with both #5 and #8 (they use it). Leftover
`derived:*` keys in Redis are harmless after a rollback and expire within 5
minutes; to clear them at once:
`docker exec plutoman-redis sh -c "redis-cli --scan --pattern 'derived:*' | xargs -r redis-cli DEL"`.

To soften #8 without a code change, set `KW_MIN_MATCH_SHARE` in `.env` (0..1;
lower = more keyword matches) and restart.

---

## Changes 1–3 (indexing — database changes)

| Commit | What it changes | Index needs re-ingest? |
|---|---|---|
| `4129699` | **Eval change 1** — POID, Job ID and printed page on every chunk (PDF twin, migration `003`, `pdf-parse` dependency) | yes |
| `8a5e5ba` | **Eval change 2** — Basic Details and report details become searchable chunks | yes |
| `e7e9be4` | **Eval change 3** — verdict normalisation (pass / fail / `CONDITIONAL`) | yes |
| tag `pre-eval-changes` (`d43a578`) | the state before all three | — |

Database snapshot taken before any re-indexing: `backups/pre-eval-changes.dump`
(13 documents, 564 chunks, 5 conversations, 13 audit rows). It is git-ignored —
keep it until the changes are accepted.

All commands below are run from `plutoman-rag/`. Each path was verified on
10 Oct 2026: every commit reverts cleanly on its own and all three together,
and the code compiles after each; the snapshot restores into a fresh database
with RLS forced and the app role's grants intact.

---

## Undo a single change

```bash
git revert --no-edit <commit>        # e.g. git revert --no-edit e7e9be4
npm install                           # only needed when reverting change 1 (drops pdf-parse)
npm run build
```

Then re-index:

- **Change 2 or 3 reverted** (change 1 still in place): just re-run
  `npm run ingest:demo`. Reports stay keyed by POID, so nothing is duplicated.
- **Change 1 reverted**: reports go back to file-name keys (`demo:<file>.xlsx`)
  and the reverted loader does not know about the POID-keyed copies, so remove
  those first or every report will be indexed twice:

  ```bash
  docker exec plutoman-postgres psql -U plutoman_owner -d plutoman \
    -c "DELETE FROM documents WHERE tenant_id = 'demo-tenant' AND mongo_id LIKE 'POID-%';"
  npm run ingest:demo
  ```

  The `poid` / `job_id` / `page` columns from migration `003` can stay — the
  older code ignores them. To drop them as well, run the `ROLLBACK` block at the
  top of `db/migrations/003_document_ids_pages.sql`.

## Undo everything (back to `pre-eval-changes`)

**Code** — keeps history, nothing is lost:

```bash
git revert --no-edit pre-eval-changes..HEAD
npm install && npm run build
```

**Data** — either restore the snapshot (exact pre-change state, including the
old index) …

```bash
# stop the API / worker first if they are running
docker exec plutoman-postgres psql -U plutoman_owner -d postgres \
  -c "DROP DATABASE plutoman WITH (FORCE);" -c "CREATE DATABASE plutoman;"
docker exec -i plutoman-postgres pg_restore -U plutoman_owner -d plutoman \
  --no-owner --role=plutoman_owner < backups/pre-eval-changes.dump
```

… or rebuild the index from source with the reverted code (the index is
derived data and always rebuildable):

```bash
docker exec plutoman-postgres psql -U plutoman_owner -d plutoman \
  -c "DELETE FROM documents WHERE tenant_id = 'demo-tenant';"
npm run ingest:demo
```

## Data changes made during this work

- Re-ingesting replaced the 11 file-name-keyed demo reports with POID-keyed
  ones (`ingest:demo` deletes each report's old copy so it is stored once).
- Deleted test document `queue-test-001` from `demo-tenant` — a leftover from
  queue testing that duplicated report POID-4504515691 and would have doubled
  it in counts. It is in the snapshot if it is ever needed.
