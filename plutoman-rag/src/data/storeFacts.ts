/**
 * Write one report's data-engine rows. Called by the ingest worker INSIDE the
 * transaction that replaces the report's chunks, so the tables the model
 * counts from and the passages it quotes always describe the same revision.
 */
import type { PoolClient } from "pg";
import { ReportFacts } from "./buildFacts";

const ITEM_COLUMNS = [
  "document_id", "tenant_id", "report_id", "job_id", "report_type", "site", "vendor", "inspection_date",
  "area", "section", "item", "value", "measurement", "note", "result", "marked", "page", "position",
] as const;

const AMOUNT_COLUMNS = [
  "document_id", "tenant_id", "report_id", "job_id", "report_type", "site", "vendor", "inspection_date",
  "area", "section", "item", "amount", "unit", "value", "page", "position",
] as const;

/**
 * Replace the rows of `documentId`. `facts` null = the document is not an
 * inspection report (or no longer is): its rows are removed.
 */
export async function replaceFacts(
  client: PoolClient,
  tenantId: string,
  documentId: string,
  facts: ReportFacts | null
): Promise<void> {
  // Items cascade from the report row.
  await client.query(`DELETE FROM inspection_reports WHERE tenant_id = $1 AND document_id = $2`, [tenantId, documentId]);
  if (!facts) return;

  const r = facts.report;
  await client.query(
    `INSERT INTO inspection_reports
       (document_id, tenant_id, report_id, job_id, report_type, category, subcategory, site, vendor,
        inspection_date, prepared_by, status, test_results, test_results_result, technical_clearance,
        clearance_result, declaration, declaration_result, items_checked, items_passed, items_failed,
        items_conditional, outcome_summary, outcome_conflict)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [
      documentId, tenantId, r.reportId, r.jobId, r.reportType, r.category, r.subcategory, r.site, r.vendor,
      r.inspectionDate, r.preparedBy, r.status, r.testResults, r.testResultsResult, r.technicalClearance,
      r.clearanceResult, r.declaration, r.declarationResult, r.itemsChecked, r.itemsPassed, r.itemsFailed,
      r.itemsConditional, r.outcomeSummary, r.outcomeConflict,
    ]
  );

  // Amounts cascade from the report row too (deleted above with it).
  if (facts.amounts.length > 0) {
    const m = AMOUNT_COLUMNS.length;
    const amountValues: unknown[] = [];
    const amountRows = facts.amounts.map((a, i) => {
      amountValues.push(
        documentId, tenantId, r.reportId, r.jobId, r.reportType, r.site, r.vendor, r.inspectionDate,
        a.area, a.section, a.item, a.amount, a.unit, a.value, a.page, a.position
      );
      return `(${AMOUNT_COLUMNS.map((_, c) => `$${i * m + c + 1}`).join(", ")})`;
    });
    await client.query(`INSERT INTO inspection_amounts (${AMOUNT_COLUMNS.join(", ")}) VALUES ${amountRows.join(", ")}`, amountValues);
  }

  if (facts.items.length === 0) return;
  const n = ITEM_COLUMNS.length;
  const values: unknown[] = [];
  const rows = facts.items.map((it, i) => {
    values.push(
      documentId, tenantId, r.reportId, r.jobId, r.reportType, r.site, r.vendor, r.inspectionDate,
      it.area, it.section, it.item, it.value, it.measurement, it.note, it.result, it.marked, it.page, it.position
    );
    return `(${ITEM_COLUMNS.map((_, c) => `$${i * n + c + 1}`).join(", ")})`;
  });
  await client.query(`INSERT INTO inspection_items (${ITEM_COLUMNS.join(", ")}) VALUES ${rows.join(", ")}`, values);
}
