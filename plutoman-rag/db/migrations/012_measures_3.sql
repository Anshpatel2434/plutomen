-- 012_measures_3.sql
--
-- Third round of standard measures (manager / management questions, 2026-11-11).
-- Questions that cross two recorded things made the model write nested queries
-- that came back empty: "the two lots against the same PO", "a lot with a
-- Critical observation that was still cleared", "lots with nothing above
-- Minor". Each of those is now one filter on one row:
--
-- 1. report_summary carries the lot's purchase order (po_number, po_date) and
--    its observations by severity (observations, critical_/major_/minor_
--    observations, worst_observation).
-- 2. `observations`: one row per inspection observation with its severity.
-- 3. lot_quantities carries the conclusion as written, so "declared rejected"
--    can be matched on the declaration's own wording.

CREATE OR REPLACE FUNCTION nexus_value_date(v text) RETURNS date
LANGUAGE sql STABLE AS $fn$
  SELECT CASE
    WHEN v ~* '\m\d{1,2}[-/ ](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/ ,]+\d{4}\M'
      THEN to_date(regexp_replace(
             substring(v from '(?i)\m(\d{1,2}[-/ ](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-/ ,]+\d{4})\M'),
             '(?i)^(\d{1,2})[-/ ]([a-z]{3})[a-z]*[-/ ,]+(\d{4})$', '\1 \2 \3'), 'DD Mon YYYY')
    WHEN v ~* '\m(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4}\M'
      THEN to_date(regexp_replace(
             substring(v from '(?i)\m((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2},? \d{4})\M'),
             '(?i)^([a-z]{3})[a-z]* (\d{1,2}),? (\d{4})$', '\2 \1 \3'), 'DD Mon YYYY')
  END
$fn$;

DROP VIEW IF EXISTS report_summary, lot_quantities;

CREATE VIEW report_summary WITH (security_invoker = true) AS
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
       COALESCE(t.no_verdict, 0)  AS no_verdict,
       p.po_number, p.po_date, p.po_details,
       COALESCE(o.observations, 0)          AS observations,
       COALESCE(o.critical_observations, 0) AS critical_observations,
       COALESCE(o.major_observations, 0)    AS major_observations,
       COALESCE(o.minor_observations, 0)    AS minor_observations,
       CASE WHEN o.critical_observations > 0 THEN 'Critical'
            WHEN o.major_observations > 0 THEN 'Major'
            WHEN o.minor_observations > 0 THEN 'Minor' END AS worst_observation
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
  ) t ON true
  LEFT JOIN LATERAL (
    SELECT substring(i.value from '(\d{6,})') AS po_number,
           nexus_value_date(i.value)          AS po_date,
           i.value                            AS po_details
      FROM inspection_items i
     WHERE i.document_id = r.document_id AND i.area = 'Basic Details'
       AND i.item ~* '^(po|p\.o\.|purchase order)'
     ORDER BY i.position
     LIMIT 1
  ) p ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int                                            AS observations,
           count(*) FILTER (WHERE i.value ~* '\mcritical\M')::int   AS critical_observations,
           count(*) FILTER (WHERE i.value ~* '\mmajor\M' AND i.value !~* '\mcritical\M')::int AS major_observations,
           count(*) FILTER (WHERE i.value ~* '\mminor\M' AND i.value !~* '\m(critical|major)\M')::int AS minor_observations
      FROM inspection_items i
     WHERE i.document_id = r.document_id AND i.area = 'Observations'
  ) o ON true;

CREATE OR REPLACE VIEW observations WITH (security_invoker = true) AS
SELECT report_id, job_id, report_type, site, vendor, inspection_date,
       item, value, note, page, position,
       CASE WHEN value ~* '\mcritical\M' THEN 'Critical'
            WHEN value ~* '\mmajor\M' THEN 'Major'
            WHEN value ~* '\mminor\M' THEN 'Minor' END AS severity
  FROM inspection_items
 WHERE area = 'Observations';

-- Photos and files a report must carry: attached or not.
CREATE OR REPLACE VIEW attachments WITH (security_invoker = true) AS
SELECT report_id, job_id, report_type, site, vendor, inspection_date,
       section, item, value, note, page, position,
       (marked = 'Attached') AS attached
  FROM inspection_items
 WHERE marked IN ('Attached', 'Not Attached');

CREATE VIEW lot_quantities WITH (security_invoker = true) AS
SELECT a.report_id, a.job_id, a.report_type, a.site, a.vendor, a.inspection_date,
       a.item, a.value, a.amount, a.unit, a.page,
       r.test_results_result, r.clearance_result, r.declaration_result,
       r.outcome_summary, r.outcome_conflict,
       r.test_results, r.technical_clearance, r.declaration
  FROM inspection_amounts a
  JOIN inspection_reports r ON r.document_id = a.document_id
 WHERE a.area = 'Basic Details';

GRANT SELECT ON report_summary, lot_quantities, observations, attachments TO plutoman_analyst;
GRANT SELECT ON report_summary, lot_quantities, observations, attachments TO plutoman_app;
