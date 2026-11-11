/**
 * Recognising a report from its details.
 *
 * entities.ts resolves the report a question names by Job ID, POID, vendor or
 * report type. People also describe a report by what is IN it: "the 10-drum
 * Polycab lot", "the lot where 25 Nos were offered", "PO 4500134567", "the
 * reports Vikram Desai handled". Similarity search does not follow such a
 * description to the right report (the two Polycab reports are near-identical
 * apart from the quantity), so those questions were answered from the wrong
 * report or not at all.
 *
 * Here every report's Basic Details (quantities, PO / SAP / batch numbers,
 * engineers) are matched against the question, and the reports that fit ALL
 * the details it gives become the reports to search and to query.
 *
 * Data-driven and tenant-scoped (read through RLS); nothing is hard-coded per
 * client or per template. A detail that matches no report is ignored, never
 * turned into an empty result.
 */
import { withTenantRead } from "../db";
import { getTenantDerived } from "../cache";

export interface ReportDetail {
  reportId: string;
  jobId: string | null;
  vendor: string | null;
  reportType: string | null;
  /** Quantities of the lot: { amount: 10, unit: "drum" }. */
  amounts: { amount: number; unit: string }[];
  /** Every Basic Details value as written, plus the checklist's inspector. */
  values: { item: string; value: string }[];
}

/** Units as people write them -> the unit stored in inspection_amounts. */
const UNIT_WORDS: Record<string, string> = {
  drum: "drum", drums: "drum",
  nos: "nos", no: "nos", number: "nos", numbers: "nos", pcs: "nos", pieces: "nos", units: "nos", unit: "nos",
  mtr: "mtr", mtrs: "mtr", meter: "mtr", meters: "mtr", metre: "mtr", metres: "mtr", m: "mtr",
};

const QTY = new RegExp(String.raw`(?<![\w.])(\d{1,6})[\s-]*(${Object.keys(UNIT_WORDS).join("|")})\b`, "gi");

/** Items whose value starts with a person's name. */
const PERSON_ITEM = /engineer|inspector|prepared|completed by|checked by|witness/i;

/** "Vikram Desai, Manager (Vendor Quality)" -> "vikram desai". */
function personName(value: string): string | null {
  const name = value.split(/[,(–—/-]/)[0].trim().toLowerCase();
  return name.split(/\s+/).length >= 2 && /^[a-z .']+$/.test(name) ? name : null;
}

/** The reports (by index) that fit every detail the text gives; null when it gives none that match. Pure. */
export function matchDetails(text: string, reports: ReportDetail[]): ReportDetail[] | null {
  const t = text.toLowerCase().replace(/[‐-―−]/g, "-");
  const constraints: Set<number>[] = [];
  const add = (fits: (r: ReportDetail) => boolean): void => {
    const hit = new Set<number>();
    reports.forEach((r, i) => fits(r) && hit.add(i));
    // A detail no report has is ignored (a typo, or not a detail at all).
    if (hit.size > 0 && hit.size < reports.length) constraints.push(hit);
  };

  // 1) Quantities: "10-drum", "25 Nos", "5000 mtr".
  for (const m of t.matchAll(QTY)) {
    const amount = Number(m[1]);
    const unit = UNIT_WORDS[m[2].toLowerCase()];
    add((r) => r.amounts.some((a) => a.amount === amount && a.unit === unit));
  }
  // 2) Long numbers: PO, SAP, batch and serial numbers (Job IDs and POIDs are entities.ts's).
  for (const m of t.matchAll(/(?<![a-z0-9])(\d{7,})(?![0-9])/g)) {
    add((r) => r.values.some((v) => v.value.includes(m[1])));
  }
  // 3) People.
  const names = new Set<string>();
  for (const r of reports) for (const v of r.values) if (PERSON_ITEM.test(v.item)) {
    const n = personName(v.value);
    if (n) names.add(n);
  }
  for (const n of names) {
    if (t.includes(n)) add((r) => r.values.some((v) => PERSON_ITEM.test(v.item) && personName(v.value) === n));
  }

  if (constraints.length === 0) return null;
  let fit = [...constraints[0]];
  for (const c of constraints.slice(1)) fit = fit.filter((i) => c.has(i));
  // Details that contradict each other pin nothing down.
  return fit.length > 0 ? fit.map((i) => reports[i]) : null;
}

/** Load (and cache per tenant) every report's details. Read path + RLS. */
export async function loadReportDetails(tenantId: string): Promise<ReportDetail[]> {
  return getTenantDerived(tenantId, "report-details", 300, () =>
    withTenantRead(tenantId, async (client) => {
      const reports = await client.query<{ document_id: string; report_id: string; job_id: string | null; vendor: string | null; report_type: string | null; prepared_by: string | null }>(
        `SELECT document_id, report_id, job_id, vendor, report_type, prepared_by
           FROM inspection_reports WHERE tenant_id = $1 ORDER BY report_id`,
        [tenantId]
      );
      const values = await client.query<{ document_id: string; item: string; value: string }>(
        `SELECT document_id, item, value FROM inspection_items
          WHERE tenant_id = $1 AND area = 'Basic Details' AND value IS NOT NULL`,
        [tenantId]
      );
      const amounts = await client.query<{ document_id: string; amount: string; unit: string }>(
        `SELECT document_id, amount, unit FROM inspection_amounts
          WHERE tenant_id = $1 AND area = 'Basic Details'`,
        [tenantId]
      );
      const byDoc = new Map<string, ReportDetail>();
      for (const r of reports.rows) {
        byDoc.set(r.document_id, {
          reportId: r.report_id,
          jobId: r.job_id,
          vendor: r.vendor,
          reportType: r.report_type,
          amounts: [],
          values: r.prepared_by ? [{ item: "Prepared by", value: r.prepared_by }] : [],
        });
      }
      for (const v of values.rows) byDoc.get(v.document_id)?.values.push({ item: v.item, value: v.value });
      for (const a of amounts.rows) byDoc.get(a.document_id)?.amounts.push({ amount: Number(a.amount), unit: a.unit });
      return [...byDoc.values()];
    })
  );
}
