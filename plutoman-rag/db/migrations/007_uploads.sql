-- ===========================================================================
-- 007_uploads.sql — file uploads from the demo chat UI.
--
-- One row per file a user uploads, tracking its ingestion lifecycle so the UI
-- can show "processing" -> "ready" (or "failed", with the reason).
--
-- The upload's `mongo_id` is the key the ingest pipeline indexes the file
-- under (documents.mongo_id / chunks.sop_id). It is the sanitised filename,
-- so citations read naturally ("[Inspection_March, part 2]") and re-uploading
-- a file of the same name REPLACES the earlier version.
--
-- Same tenancy discipline as every other table: tenant_id on the row, RLS
-- ENABLED + FORCED, per-operation policies on current_setting('app.tenant_id').
-- Idempotent; safe to re-run.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS uploads (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    text NOT NULL,
  mongo_id     text NOT NULL,
  filename     text NOT NULL,
  size_bytes   integer NOT NULL,
  status       text NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  error        text,
  chunk_count  integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mongo_id)
);

CREATE INDEX IF NOT EXISTS uploads_tenant_created_idx ON uploads (tenant_id, created_at DESC);

ALTER TABLE uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS uploads_tenant_select ON uploads;
CREATE POLICY uploads_tenant_select ON uploads
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS uploads_tenant_insert ON uploads;
CREATE POLICY uploads_tenant_insert ON uploads
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS uploads_tenant_update ON uploads;
CREATE POLICY uploads_tenant_update ON uploads
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
         WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS uploads_tenant_delete ON uploads;
CREATE POLICY uploads_tenant_delete ON uploads
  FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON uploads TO plutoman_app;
