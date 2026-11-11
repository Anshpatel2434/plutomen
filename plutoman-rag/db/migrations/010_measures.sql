-- ===========================================================================
-- plutoman-rag  |  010_measures.sql
-- ===========================================================================
-- STANDARD MEASURES for the data engine, defined once here instead of being
-- re-invented by the model in every query.
--
-- WHY. With only the two base tables, the model had to work out for itself how
-- to count checks, compute a pass rate or add up quantities — and got it subtly
-- wrong: joining items to reports and summing a per-report tally once per item,
-- counting "Not Attached" photos as "Not Ok", listing quantities it could not
-- add because they are text ("10 Drums / 5000 mtr"). Each measure below is
-- written and tested once; the model only chooses one and filters it.
--
--   inspection_items.marked   the result word as the inspector wrote it
--                             ('Ok', 'Not Ok', 'Attached', 'Not Attached')
--   inspection_amounts        every "<number> <unit>" recorded in a report, as
--                             a number, so quantities can be summed and compared
--   checks                    the checked items only (one row per check)
--   report_summary            one row per report with its tallies and pass rate
--   section_summary           the same per report section
--
-- SECURITY. The views are security_invoker, so row-level security of the
-- underlying tables applies to whoever queries them (a plain view would run as
-- its owner and show every tenant's rows). inspection_amounts has the same
-- ENABLED + FORCED tenant policy as the other tables.
-- Additive and idempotent.
-- ===========================================================================

ALTER TABLE inspection_items ADD COLUMN IF NOT EXISTS marked text;

CREATE TABLE IF NOT EXISTS inspection_amounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES inspection_reports(document_id) ON DELETE CASCADE,
  tenant_id     text NOT NULL,
  report_id     text NOT NULL,
  job_id        text,
  report_type   text,
  site          text,
  vendor        text,
  inspection_date date,
  area          text NOT NULL,
  section       text,
  item          text NOT NULL,     -- e.g. "Offered Qty", "Ovality of Cable"
  amount        numeric NOT NULL,  -- 5000
  unit          text NOT NULL,     -- "mtr" (lower case, singular)
  value         text,              -- the full recorded value the amount was read from
  page          text,
  position      integer NOT NULL
);

CREATE INDEX IF NOT EXISTS inspection_amounts_tenant_doc_idx ON inspection_amounts (tenant_id, document_id);
CREATE INDEX IF NOT EXISTS inspection_amounts_tenant_item_idx ON inspection_amounts (tenant_id, item);

ALTER TABLE inspection_amounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_amounts FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inspection_amounts_tenant ON inspection_amounts;
CREATE POLICY inspection_amounts_tenant ON inspection_amounts
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_amounts TO plutoman_app;

-- --- checks: one row per checked item ----------------------------------------
CREATE OR REPLACE VIEW checks WITH (security_invoker = true) AS
SELECT report_id, job_id, report_type, site, vendor, inspection_date,
       section, item, value, measurement, note, result, marked, page, position
  FROM inspection_items
 WHERE area = 'Characteristics' AND result IS NOT NULL;

-- --- report_summary: one row per report --------------------------------------
CREATE OR REPLACE VIEW report_summary WITH (security_invoker = true) AS
SELECT r.report_id, r.job_id, r.report_type, r.category, r.subcategory, r.site, r.vendor,
       r.inspection_date, r.prepared_by, r.status,
       r.test_results, r.test_results_result,
       r.technical_clearance, r.clearance_result,
       r.declaration, r.declaration_result,
       r.outcome_summary, r.outcome_conflict,
       r.items_checked     AS checks,
       r.items_passed      AS passed,
       r.items_failed      AS failed,
       r.items_conditional AS conditional,
       ROUND(100.0 * r.items_passed / NULLIF(r.items_checked, 0), 1) AS pass_rate_percent,
       (SELECT count(*)::int FROM inspection_items i
         WHERE i.document_id = r.document_id AND i.area = 'Characteristics' AND i.marked = 'Not Ok') AS marked_not_ok
  FROM inspection_reports r;

-- --- section_summary: one row per report section -----------------------------
CREATE OR REPLACE VIEW section_summary WITH (security_invoker = true) AS
SELECT report_id, job_id, report_type, site, vendor, inspection_date, section,
       count(*)::int                                       AS checks,
       count(*) FILTER (WHERE result = 'PASS')::int        AS passed,
       count(*) FILTER (WHERE result = 'FAIL')::int        AS failed,
       count(*) FILTER (WHERE result = 'CONDITIONAL')::int AS conditional,
       ROUND(100.0 * count(*) FILTER (WHERE result = 'PASS') / NULLIF(count(*), 0), 1) AS pass_rate_percent,
       count(*) FILTER (WHERE marked = 'Not Ok')::int      AS marked_not_ok
  FROM inspection_items
 WHERE area = 'Characteristics' AND result IS NOT NULL
 GROUP BY report_id, job_id, report_type, site, vendor, inspection_date, section;

GRANT SELECT ON inspection_amounts, checks, report_summary, section_summary TO plutoman_analyst;
GRANT SELECT ON checks, report_summary, section_summary TO plutoman_app;
