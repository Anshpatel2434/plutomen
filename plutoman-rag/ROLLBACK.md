# Rollback — golden-eval changes 1–3

Branch: `testing/pipeline-docker`. **`main` is not affected by any of this.**

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
