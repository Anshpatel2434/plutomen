-- ===========================================================================
-- plutoman-rag  |  006_hierarchy_and_refs.sql
-- ===========================================================================
-- Phase-A completion: the columns Legs 1 & 2 and the citation format need.
--
-- WHAT THIS UNLOCKS
-- -----------------
--   Leg 1 (Structured / Hierarchical RAG) — an SOP is a Section→Step TREE, not
--   a flat list. `parent_chunk_id` makes a step a child of its section, so
--   retrieval can return "a step in its proper context, not a floating chunk"
--   (quotation §1). `chunk_kind` distinguishes the node types.
--
--   Leg 2 (Classic Unstructured RAG) — `source_format` records where a chunk
--   came from (xlsx | pdf | txt | csv | sop) now that more than one parser exists.
--
--   Citations — the quotation asks for `[SOP-102, Section 4, Step 2.1]`.
--   That needs a human-readable document handle (`doc_ref`) plus the structural
--   coordinates (`section_no`, `section_title`, `step_no`). Previously the only
--   handle was the raw Mongo id, which produced `[demo:LT_Mini_Pillar.xlsx | ...]`.
--
-- Idempotent (IF NOT EXISTS / DROP ... IF EXISTS) so re-running is safe. RLS is
-- inherited from the table policies created in 001 — adding columns does not
-- change them, and no new tenant-owned table is introduced here.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
ALTER TABLE documents ADD COLUMN IF NOT EXISTS doc_ref       text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_format text;

COMMENT ON COLUMN documents.doc_ref IS
  'Human-readable handle used in citations, e.g. "SOP-102" or "RPT-LT-0007".';
COMMENT ON COLUMN documents.source_format IS
  'Parser that produced this document: xlsx | pdf | txt | csv | sop.';

-- ---------------------------------------------------------------------------
-- chunks
-- ---------------------------------------------------------------------------
-- Denormalized onto the chunk so a retrieval hit can be cited without joining
-- back to `documents` on every query.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS doc_ref       text;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS source_format text;

-- Node type in the tree:
--   'row'     — one checklist row from an inspection workbook (Phase-1 behaviour)
--   'prose'   — a chunk of free-form text (PDF/TXT/CSV) — Leg 2
--   'section' — an SOP section node, parent of steps — Leg 1
--   'step'    — an SOP step leaf, child of a section — Leg 1
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS chunk_kind text NOT NULL DEFAULT 'row';

-- Structural coordinates used to render `[SOP-102, Section 4, Step 2.1]`.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS section_no    text;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS section_title text;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS step_no       text;

-- THE TREE EDGE. A 'step' points at its 'section'. Self-referencing and
-- ON DELETE CASCADE, so the existing idempotent-replace in the ingest worker
-- (DELETE FROM chunks WHERE tenant_id=$1 AND sop_id=$2) still cleans up whole
-- subtrees correctly.
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS parent_chunk_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chunks_parent_chunk_id_fkey'
  ) THEN
    ALTER TABLE chunks
      ADD CONSTRAINT chunks_parent_chunk_id_fkey
      FOREIGN KEY (parent_chunk_id) REFERENCES chunks(id) ON DELETE CASCADE;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
-- Parent-context lookup: given a page of step hits, fetch their section nodes.
-- Tenant-first so it composes with the RLS predicate.
CREATE INDEX IF NOT EXISTS chunks_tenant_parent_idx
  ON chunks (tenant_id, parent_chunk_id);

-- Citation / document-scoped lookups.
CREATE INDEX IF NOT EXISTS chunks_tenant_docref_idx
  ON chunks (tenant_id, doc_ref);

-- The retrieval filter is `modality = 'text'` AND (increasingly) chunk_kind.
CREATE INDEX IF NOT EXISTS chunks_tenant_kind_idx
  ON chunks (tenant_id, chunk_kind);
