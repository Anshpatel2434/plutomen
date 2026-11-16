-- ===========================================================================
-- plutoman-rag  |  009_report_outcome.sql
-- ===========================================================================
-- A report's conclusion in one place. The three conclusion fields (Test
-- Results, Technical Clearance, Declaration) can disagree inside one report,
-- and a query that reads only one of them answers "cleared" for a lot whose
-- other conclusions say otherwise. These two columns make the whole outcome,
-- in the report's own words, one thing to select.
-- Additive and idempotent; filled by the ingest worker.
-- ===========================================================================
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS outcome_summary  text;
ALTER TABLE inspection_reports ADD COLUMN IF NOT EXISTS outcome_conflict boolean NOT NULL DEFAULT false;
