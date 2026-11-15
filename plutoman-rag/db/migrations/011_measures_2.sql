-- 011_measures_2.sql
--
-- Second round of standard measures, from the sealed set C run (2026-11-11):
--
-- 1. `checks` left out every check row that records a reading without a
--    verdict ("41.8 mm"), so "how many checks" and every share came out with
--    the wrong whole (149 of 150, 380 of 443). A check row is any row of the
--    Characteristics area that is not a photo / file attachment. Rows with no
--    verdict have result NULL. The summaries count them (`checks`) and say how
--    many there are (`no_verdict`); pass_rate_percent is over the rows that
--    carry a verdict.
-- 2. `lot_quantities`: each quantity of a lot next to the lot's outcome, so
--    "how many metres sit in lots that came out Not Ok" is one filter, not a
--    sub-query the model has to get right.
-- 3. `dated_items`: dates written inside values ("PO No. 45… dated
--    01-Jul-2026") as a real date that can be ordered and compared.

DROP VIEW IF EXISTS report_summary, section_summary, checks, lot_quantities;

CREATE OR REPLACE VIEW checks WITH (security_invoker = true) AS
SELECT report_id, job_id, report_type, site, vendor, inspection_date,
       section, item, value, measurement, note, result, marked, page, position
  FROM inspection_items
 WHERE area = 'Characteristics'
   AND (marked IS NULL OR marked NOT IN ('Attached', 'Not Attached'));

-- Column order of 010 is kept (CREATE OR REPLACE may only append).
CREATE OR REPLACE VIEW report_summary WITH (security_invoker = true) AS
SELECT r.report_id, r.job_id, r.report_type, r.category, r.subcategory, r.site, r.vendor,
       r.inspection_date, r.prepared_by, r.status,
       r.test_results, r.test_results_result,
       r.technical_clearance, r.clearance_result,
       r.declaration, r.declaration_result,
       r.outcome_summary, r.outcome_conflict,
       COALESCE(t.checks, 0)      AS checks,
       COALESCE(t.passed, 0)      AS passed,
       COALESCE(t.failed, 0)      AS failed,
       COALESCE(t.conditional, 0) AS conditional,
       ROUND(100.0 * t.passed / NULLIF(t.checks - t.no_verdict, 0), 1) AS pass_rate_percent,
       COALESCE(t.marked_not_ok, 0) AS marked_not_ok,
       COALESCE(t.no_verdict, 0)  AS no_verdict
  FROM inspection_reports r
  LEFT JOIN LATERAL (
    SELECT count(*)::int                                       AS checks,
           count(*) FILTER (WHERE i.result = 'PASS')::int        AS passed,
           count(*) FILTER (WHERE i.result = 'FAIL')::int        AS failed,
           count(*) FILTER (WHERE i.result = 'CONDITIONAL')::int AS conditional,
           count(*) FILTER (WHERE i.marked = 'Not Ok')::int      AS marked_not_ok,
           count(*) FILTER (WHERE i.result IS NULL)::int         AS no_verdict
      FROM inspection_items i
     WHERE i.document_id = r.document_id AND i.area = 'Characteristics'
       AND (i.marked IS NULL OR i.marked NOT IN ('Attached', 'Not Attached'))
  ) t ON true;

CREATE OR REPLACE VIEW section_summary WITH (security_invoker = true) AS
SELECT report_id, job_id, report_type, site, vendor, inspection_date, section,
       count(*)::int                                       AS checks,
       count(*) FILTER (WHERE result = 'PASS')::int        AS passed,
       count(*) FILTER (WHERE result = 'FAIL')::int        AS failed,
       count(*) FILTER (WHERE result = 'CONDITIONAL')::int AS conditional,
       ROUND(100.0 * count(*) FILTER (WHERE result = 'PASS') / NULLIF(count(*) FILTER (WHERE result IS NOT NULL), 0), 1) AS pass_rate_percent,
       count(*) FILTER (WHERE marked = 'Not Ok')::int      AS marked_not_ok,
       count(*) FILTER (WHERE result IS NULL)::int         AS no_verdict
  FROM inspection_items
 WHERE area = 'Characteristics'
   AND (marked IS NULL OR marked NOT IN ('Attached', 'Not Attached'))
 GROUP BY report_id, job_id, report_type, site, vendor, inspection_date, section;

CREATE OR REPLACE VIEW lot_quantities WITH (security_invoker = true) AS
SELECT a.report_id, a.job_id, a.report_type, a.site, a.vendor, a.inspection_date,
       a.item, a.value, a.amount, a.unit, a.page,
       r.test_results_result, r.clearance_result, r.declaration_result,
       r.outcome_summary, r.outcome_conflict
  FROM inspection_amounts a
  JOIN inspection_reports r ON r.document_id = a.document_id
 WHERE a.area = 'Basic Details';

CREATE OR REPLACE VIEW dated_items WITH (security_invoker = true) AS
SELECT report_id, job_id, report_type, site, vendor, inspection_date,
       area, section, item, value, page,
       CASE
         WHEN value ~* '\m\d{1,2}[-/ ](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/ ,]+\d{4}\M'
           THEN to_date(regexp_replace(
                  substring(value from '(?i)\m(\d{1,2}[-/ ](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/ ,]+\d{4})\M'),
                  '(?i)^(\d{1,2})[-/ ]([a-z]{3})[a-z]*[-/ ,]+(\d{4})$', '\1 \2 \3'), 'DD Mon YYYY')
         WHEN value ~* '\m(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4}\M'
           THEN to_date(regexp_replace(
                  substring(value from '(?i)\m((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4})\M'),
                  '(?i)^([a-z]{3})[a-z]* (\d{1,2}),? (\d{4})$', '\2 \1 \3'), 'DD Mon YYYY')
       END AS value_date
  FROM inspection_items
 WHERE value ~* '\m\d{1,2}[-/ ](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/ ,]+\d{4}\M'
    OR value ~* '\m(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4}\M';

GRANT SELECT ON lot_quantities, dated_items TO plutoman_analyst;
GRANT SELECT ON lot_quantities, dated_items TO plutoman_app;
-- The three views above were dropped and recreated: grant them again.
GRANT SELECT ON checks, report_summary, section_summary TO plutoman_analyst;
GRANT SELECT ON checks, report_summary, section_summary TO plutoman_app;
