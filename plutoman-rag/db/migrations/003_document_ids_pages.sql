-- ===========================================================================
-- plutoman-rag  |  003_document_ids_pages.sql
-- ===========================================================================
-- Golden-eval change 1: every chunk carries the report's POID, Job ID and the
-- PRINTED page it sits on, so answers can cite "POID-4547081947.pdf p.2"
-- (the golden evaluation set scores a citation to the wrong document as a
-- fail). Values come from the report's PDF twin — see
-- src/ingestion/parsePdf.ts.
--
-- PURELY ADDITIVE: nullable columns + indexes only. Existing rows simply have
-- NULLs until re-ingested, and the pre-003 application code keeps working
-- because it lists its INSERT columns explicitly. Idempotent (IF NOT EXISTS).
--
-- RLS: unchanged. These are new columns on tables that already have RLS
-- ENABLED + FORCED and table-level grants to plutoman_app, so the existing
-- tenant policies and grants cover them automatically.
--
-- ROLLBACK (only if you also roll the code back; see ROLLBACK.md):
--   DROP INDEX IF EXISTS chunks_tenant_job_idx, chunks_tenant_poid_idx;
--   ALTER TABLE chunks    DROP COLUMN IF EXISTS poid, DROP COLUMN IF EXISTS job_id,
--                         DROP COLUMN IF EXISTS page;
--   ALTER TABLE documents DROP COLUMN IF EXISTS poid, DROP COLUMN IF EXISTS job_id;
-- ===========================================================================

ALTER TABLE documents ADD COLUMN IF NOT EXISTS poid   text;   -- e.g. "POID-4547081947"
ALTER TABLE documents ADD COLUMN IF NOT EXISTS job_id text;   -- e.g. "PH2026100008"

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS poid   text;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS job_id text;
-- Printed page label: "cover", "2", or a range "6-7" when an item straddles a
-- page break. Text, not int, because "cover" is unnumbered in the PDFs.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS page   text;

-- Lookups / future hard filters by job or document ("job PH2026100008").
CREATE INDEX IF NOT EXISTS chunks_tenant_job_idx  ON chunks (tenant_id, job_id);
CREATE INDEX IF NOT EXISTS chunks_tenant_poid_idx ON chunks (tenant_id, poid);
