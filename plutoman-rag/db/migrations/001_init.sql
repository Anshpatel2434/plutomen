-- ===========================================================================
-- plutoman-rag  |  001_init.sql
-- ===========================================================================
-- This is the schema for a SINGLE shared Postgres used purely as a derived,
-- rebuildable retrieval index. MongoDB (the client's MEAN app) remains the
-- source of truth; everything here can be dropped and rebuilt from ingest.
--
-- MULTI-TENANCY MODEL
-- -------------------
-- One shared database. Every tenant-owned row carries a `tenant_id`. Tenant
-- isolation is enforced by Postgres Row-Level Security (RLS) — NOT by separate
-- databases or schemas.
--
-- HOW RLS IS APPLIED AT RUNTIME (read this before touching src/db.ts)
-- ------------------------------------------------------------------
--   1. The application connects as a DEDICATED, NON-OWNER role
--      (see PG_APP_USER / plutoman_app below). Non-owner is important: table
--      owners and superusers bypass RLS by default. We additionally `FORCE`
--      RLS so even the owner is subject to it, but the app must still use the
--      least-privilege role.
--   2. Per transaction, the app runs:
--          SET LOCAL app.tenant_id = '<tenant>';
--      and every policy filters on `current_setting('app.tenant_id', true)`.
--   3. If `app.tenant_id` is unset, `current_setting(..., true)` returns NULL
--      and the policy predicate `tenant_id = NULL` matches no rows — i.e. a
--      forgotten SET LOCAL fails CLOSED (returns nothing), never open.
--
-- All application data access therefore MUST go through db.ts:withTenant().
-- ===========================================================================

-- pgvector: provides the `vector` type + HNSW / IVFFlat indexes.
CREATE EXTENSION IF NOT EXISTS vector;

-- gen_random_uuid() lives in pgcrypto on some builds; ensure it exists.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Application role
-- ---------------------------------------------------------------------------
-- The app connects as this NON-owner role so RLS is enforced. Created here for
-- convenience in local/dev; in prod, provision it out-of-band with a managed
-- secret. Adjust the password to match PG_APP_PASSWORD in your .env.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plutoman_app') THEN
    CREATE ROLE plutoman_app LOGIN PASSWORD 'app_password';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- documents: one row per source report (mirrors a Mongo document by mongo_id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  mongo_id      text NOT NULL,            -- source _id in the client's MongoDB
  type          text,                     -- e.g. checklist category ("LT")
  title         text,                     -- e.g. "LT_Mini_Pillar"
  status        text,                     -- e.g. "Completed"
  section_path  text,                     -- optional top-level grouping
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mongo_id)            -- upsert key
);

-- ---------------------------------------------------------------------------
-- chunks: the retrievable units (one per checklist row / observation / etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  sop_id        text NOT NULL,            -- source mongo _id this chunk derives from
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  section_path  text,                     -- "Characteristics > Visual & Physical Checks > Dimensions"
  question      text,                     -- the checklist Title / Observations label
  answer        text,                     -- the Input / Answer value
  verdict       text,                     -- normalized OK / NOT OK / etc.
  site          text,                     -- denormalized metadata for filtering
  vendor        text,
  po            text,
  report_date   date,
  content       text NOT NULL,            -- self-describing sentence used for embed + FTS
  -- Full-text search vector: generated column keeps it perfectly in sync with
  -- `content` on every INSERT/UPDATE with zero trigger maintenance.
  content_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED,
  embedding     vector(768),             -- nomic-embed-text dimensionality
  modality      text NOT NULL DEFAULT 'text',  -- TODO(multimodal): 'image' | 'table' | ...
  embed_model   text,                    -- provenance: which model produced `embedding`
  embed_version text,                    -- provenance: our internal embed schema version
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- audit: one row per search request (for observability + compliance)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text,
  user_id       text,
  query         text,
  retrieved_ids uuid[],
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Dense ANN index. cosine distance operator is `<=>` with vector_cosine_ops.
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw
  ON chunks USING hnsw (embedding vector_cosine_ops);

-- Sparse / keyword index over the generated tsvector.
CREATE INDEX IF NOT EXISTS chunks_content_tsv_gin
  ON chunks USING gin (content_tsv);

-- Tenant scoping helpers (RLS predicate + common lookups).
CREATE INDEX IF NOT EXISTS chunks_tenant_idx      ON chunks (tenant_id);
CREATE INDEX IF NOT EXISTS documents_tenant_idx   ON documents (tenant_id);
CREATE INDEX IF NOT EXISTS chunks_tenant_sop_idx  ON chunks (tenant_id, sop_id);

-- ===========================================================================
-- Row-Level Security
-- ===========================================================================
-- ENABLE turns policies on; FORCE makes them apply even to the table owner so
-- there is no accidental bypass path. The predicate reads the per-transaction
-- GUC `app.tenant_id` set by withTenant().
--
-- current_setting('app.tenant_id', true): the `true` = "missing_ok", so an
-- unset GUC yields NULL rather than erroring -> predicate matches no rows.

-- documents ------------------------------------------------------------------
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS documents_tenant_select ON documents;
CREATE POLICY documents_tenant_select ON documents
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS documents_tenant_insert ON documents;
CREATE POLICY documents_tenant_insert ON documents
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS documents_tenant_update ON documents;
CREATE POLICY documents_tenant_update ON documents
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
         WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS documents_tenant_delete ON documents;
CREATE POLICY documents_tenant_delete ON documents
  FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true));

-- chunks ---------------------------------------------------------------------
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chunks_tenant_select ON chunks;
CREATE POLICY chunks_tenant_select ON chunks
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS chunks_tenant_insert ON chunks;
CREATE POLICY chunks_tenant_insert ON chunks
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS chunks_tenant_update ON chunks;
CREATE POLICY chunks_tenant_update ON chunks
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
         WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS chunks_tenant_delete ON chunks;
CREATE POLICY chunks_tenant_delete ON chunks
  FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true));

-- audit ----------------------------------------------------------------------
ALTER TABLE audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_tenant_select ON audit;
CREATE POLICY audit_tenant_select ON audit
  FOR SELECT USING (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS audit_tenant_insert ON audit;
CREATE POLICY audit_tenant_insert ON audit
  FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS audit_tenant_update ON audit;
CREATE POLICY audit_tenant_update ON audit
  FOR UPDATE USING (tenant_id = current_setting('app.tenant_id', true))
         WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS audit_tenant_delete ON audit;
CREATE POLICY audit_tenant_delete ON audit
  FOR DELETE USING (tenant_id = current_setting('app.tenant_id', true));

-- ---------------------------------------------------------------------------
-- Grants: least privilege for the app role. No DDL, no ownership.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO plutoman_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON documents, chunks, audit TO plutoman_app;
