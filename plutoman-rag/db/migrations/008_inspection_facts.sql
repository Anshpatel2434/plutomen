-- ===========================================================================
-- plutoman-rag  |  008_inspection_facts.sql
-- ===========================================================================
-- The DATA ENGINE's tables: every inspection report as one row, and every
-- recorded item of every report as one row.
--
-- WHY. Search answers "what does this passage say". It cannot answer "how
-- many", "which vendors", "what is the pass rate", "what is pending" — those
-- need EVERY matching record, counted exactly. A language model must never
-- produce such numbers; the database does, from these tables, and the model
-- only words the result (src/data/).
--
-- Generic on purpose: nothing here is specific to one report template. Any
-- field a template carries (SAP Code, Cable Size, a new test) is simply a row
-- in inspection_items; only what identifies and concludes a report is a column.
--
-- Filled by the ingest worker in the same transaction as the chunks, so the
-- two can never disagree. Additive and idempotent.
--
-- SECURITY
--   * Row-level security, ENABLED + FORCED, same tenant policy as every table.
--   * plutoman_analyst: a NOLOGIN role that can SELECT these two tables and
--     nothing else. Model-written SQL runs under it (SET LOCAL ROLE), inside a
--     READ ONLY transaction, so even a query that slipped past validation
--     could not read another table or write anything.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS inspection_reports (
  document_id          uuid PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id            text NOT NULL,
  report_id            text NOT NULL,   -- POID when known, else the source id
  job_id               text,
  report_type          text,            -- checklist name, e.g. "LT_Power_Cables"
  category             text,
  subcategory          text,
  site                 text,
  vendor               text,
  inspection_date      date,
  prepared_by          text,
  status               text,            -- checklist status, e.g. "Completed"
  -- The Inspection Conclusion, as recorded and as a normalised result.
  test_results         text,
  test_results_result  text CHECK (test_results_result IN ('PASS', 'FAIL', 'CONDITIONAL')),
  technical_clearance  text,
  clearance_result     text CHECK (clearance_result IN ('PASS', 'FAIL', 'CONDITIONAL')),
  declaration          text,
  declaration_result   text CHECK (declaration_result IN ('PASS', 'FAIL', 'CONDITIONAL')),
  -- Tally of the checked items (those that carry a result).
  items_checked        integer NOT NULL DEFAULT 0,
  items_passed         integer NOT NULL DEFAULT 0,
  items_failed         integer NOT NULL DEFAULT 0,
  items_conditional    integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS inspection_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES inspection_reports(document_id) ON DELETE CASCADE,
  tenant_id     text NOT NULL,
  -- Report identity repeated on every item, so most questions need no join.
  report_id     text NOT NULL,
  job_id        text,
  report_type   text,
  site          text,
  vendor        text,
  inspection_date date,
  -- Where the item sits in the report.
  area          text NOT NULL,   -- 'Basic Details' | 'Characteristics' | 'Observations' | 'Conclusion'
  section       text,            -- e.g. "Acceptance Tests" (null where the area has none)
  item          text NOT NULL,   -- e.g. "IR Test", "SAP Code", "Observation 1"
  -- What was recorded.
  value         text,            -- as written, e.g. "OI 31.5% – Pass"
  measurement   text,
  note          text,            -- the inspector's note
  result        text CHECK (result IN ('PASS', 'FAIL', 'CONDITIONAL')),  -- null = a fact, not a check
  page          text,            -- printed page in the PDF report ("2", "6-7")
  position      integer NOT NULL -- order within the report
);

CREATE INDEX IF NOT EXISTS inspection_reports_tenant_idx ON inspection_reports (tenant_id);
CREATE INDEX IF NOT EXISTS inspection_items_tenant_doc_idx ON inspection_items (tenant_id, document_id);
CREATE INDEX IF NOT EXISTS inspection_items_tenant_item_idx ON inspection_items (tenant_id, item);
CREATE INDEX IF NOT EXISTS inspection_items_tenant_result_idx ON inspection_items (tenant_id, result);

-- --- Row-level security -----------------------------------------------------
ALTER TABLE inspection_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_reports FORCE  ROW LEVEL SECURITY;
ALTER TABLE inspection_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE inspection_items   FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inspection_reports_tenant ON inspection_reports;
CREATE POLICY inspection_reports_tenant ON inspection_reports
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS inspection_items_tenant ON inspection_items;
CREATE POLICY inspection_items_tenant ON inspection_items
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON inspection_reports, inspection_items TO plutoman_app;

-- --- The role model-written SQL runs under ------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'plutoman_analyst') THEN
    CREATE ROLE plutoman_analyst NOLOGIN;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO plutoman_analyst;
GRANT SELECT ON inspection_reports, inspection_items TO plutoman_analyst;
-- The app role may switch to it for one transaction (SET LOCAL ROLE).
GRANT plutoman_analyst TO plutoman_app;
