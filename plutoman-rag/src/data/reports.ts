/**
 * Ready-made reports: the questions managers and management ask most (which
 * lots, how many of each, shares of quantity, how a test came out everywhere,
 * what keeps going wrong) answered by queries written HERE, not by the model.
 *
 *   question -> the model PICKS a report and fills in its parameters (JSON)
 *            -> the parameters are checked against what the workspace holds
 *            -> the report's fixed queries run through the same guarded,
 *               read-only, tenant-scoped path as model-written SQL (runSql)
 *            -> the tables go to the answer step
 *
 * Why: choosing from a short list is a far easier job for a small model than
 * composing a query over several views, and every total, share and "x of y"
 * is worked out by the database in one fixed way. When no report fits, or a
 * parameter names something the workspace does not hold, the caller falls
 * back to the model-written query (dataEngine.ts), exactly as before.
 *
 * Nothing here knows a vendor, a test or a report type: names come from the
 * tenant's catalog at run time.
 */
import { chatComplete } from "../llm";
import { config } from "../config";
import { runSql } from "./runSql";
import type { DataCatalog, DataTable, HistoryTurn } from "./dataEngine";

export const REPORT_NAMES = ["lots", "breakdown", "checks", "recurring", "observations", "attachments"] as const;
export type ReportName = (typeof REPORT_NAMES)[number];

/** Things a breakdown can group lots by (besides "detail": a Basic Details item). */
export const BREAKDOWN_BY: Record<string, { expr: string; label: string }> = {
  vendor: { expr: "r.vendor", label: "vendor" },
  report_type: { expr: "r.report_type", label: "report_type" },
  site: { expr: "r.site", label: "site" },
  test_results: { expr: "r.test_results", label: "test_results_as_written" },
  technical_clearance: { expr: "r.technical_clearance", label: "technical_clearance_as_written" },
  declaration: { expr: "r.declaration", label: "declaration_as_written" },
  purchase_order: { expr: "r.po_details", label: "purchase_order" },
  po_month: { expr: "to_char(r.po_date, 'FMMonth YYYY')", label: "po_month" },
  inspection_date: { expr: "to_char(r.inspection_date, 'YYYY-MM-DD')", label: "inspection_date" },
  worst_observation: { expr: "coalesce(r.worst_observation, 'no severity recorded')", label: "worst_observation" },
};

/** One report the model asked for, after its parameters were checked. */
export interface ReportCall {
  name: ReportName;
  vendors: string[];
  reportType: string | null;
  site: string | null;
  jobs: string[];
  person: string | null;
  po: string | null;
  /** How the lot concluded: only lots with this outcome. */
  testResults: "ok" | "not_ok" | null;
  clearance: "yes" | "conditional" | "rejected" | "not_yes" | null;
  declared: "cleared" | "not_cleared" | "rejected" | null;
  conflict: boolean;
  /** breakdown */
  by: string;
  detailItem: string | null;
  /** checks / recurring */
  items: string[];
  section: string | null;
  only: "all" | "problems" | "notes";
}

// ---------------------------------------------------------------------------
// What the workspace holds, as lists the parameters are checked against
// ---------------------------------------------------------------------------

export interface CatalogLists {
  vendors: string[];
  reportTypes: string[];
  sites: string[];
  /** Basic Details items (facts about the lot). */
  details: string[];
  sections: string[];
  /** Check items (Characteristics). */
  checks: string[];
}

export function catalogLists(cat: DataCatalog): CatalogLists {
  const details = new Set<string>();
  const sections = new Set<string>();
  const checks = new Set<string>();
  for (const g of cat.items) {
    const [area, ...rest] = g.group.split(" / ");
    const section = rest.join(" / ");
    if (area === "Basic Details") g.items.forEach((i) => details.add(i));
    else if (area === "Characteristics") {
      if (section) sections.add(section);
      g.items.forEach((i) => checks.add(i));
    }
  }
  return {
    vendors: cat.vendors.map((v) => v.name),
    reportTypes: cat.reportTypes.map((t) => t.name),
    sites: cat.sites,
    details: [...details],
    sections: [...sections],
    checks: [...checks],
  };
}

const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The catalog names a loosely written name stands for: the exact name, else
 * every name that contains it (or that it contains). Empty when none does.
 */
export function resolveNames(given: unknown, options: string[], max = 6): string[] {
  if (typeof given !== "string") return [];
  const g = squash(given);
  if (g.length < 2) return [];
  const exact = options.filter((o) => squash(o) === g);
  if (exact.length > 0) return exact;
  const part = options.filter((o) => {
    const s = squash(o);
    return s.includes(g) || (s.length >= 4 && g.includes(s));
  });
  return part.slice(0, max);
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : typeof v === "string" && v.trim() ? [v] : [];

/**
 * Check one requested report against the catalog. Null when it names a report
 * that does not exist or a vendor, type, site or item the workspace does not
 * hold: the caller then lets the model-written query (or search) handle it.
 */
export function validateCall(raw: unknown, lists: CatalogLists): ReportCall | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = String(o.name ?? "").toLowerCase().trim() as ReportName;
  if (!REPORT_NAMES.includes(name)) return null;

  const vendors: string[] = [];
  for (const v of strings(o.vendors ?? o.vendor)) {
    const m = resolveNames(v, lists.vendors, 3);
    if (m.length === 0) return null; // a vendor the workspace does not hold
    vendors.push(...m);
  }
  let reportType: string | null = null;
  if (typeof o.report_type === "string" && o.report_type.trim()) {
    const m = resolveNames(o.report_type, lists.reportTypes, 1);
    if (m.length === 0) return null;
    reportType = m[0];
  }
  let site: string | null = null;
  if (typeof o.site === "string" && o.site.trim()) {
    const m = resolveNames(o.site, lists.sites, 1);
    if (m.length === 0) return null;
    site = m[0];
  }
  const jobs = strings(o.jobs ?? o.job).map((j) => j.trim()).filter((j) => /^[A-Za-z0-9_-]{4,40}$/.test(j));
  const person = typeof o.person === "string" && o.person.trim().length >= 3 ? o.person.trim().slice(0, 60) : null;
  const poDigits = typeof o.po === "string" || typeof o.po === "number" ? String(o.po).replace(/\D/g, "") : "";
  const po = poDigits.length >= 6 ? poDigits : null;

  const word = (v: unknown): string => String(v ?? "").toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, "");
  const tr = word(o.test_results);
  const testResults: ReportCall["testResults"] = tr === "ok" || tr === "pass" ? "ok" : tr === "not_ok" || tr === "fail" || tr === "failed" ? "not_ok" : null;
  const tc = word(o.technical_clearance);
  const clearance: ReportCall["clearance"] =
    tc === "yes" ? "yes" : tc === "rejected" ? "rejected" : tc === "conditional" || tc.startsWith("subject") ? "conditional" : tc === "not_yes" || tc === "no" ? "not_yes" : null;
  const de = word(o.declaration);
  const declared: ReportCall["declared"] = de === "cleared" ? "cleared" : de === "rejected" ? "rejected" : de === "not_cleared" || de === "held" ? "not_cleared" : null;
  const conflict = o.conflict === true || o.conflict === "true";

  let by = String(o.by ?? "vendor").toLowerCase().trim();
  let detailItem: string | null = null;
  if (name === "breakdown") {
    if (by === "detail" || o.detail_item) {
      const m = resolveNames(o.detail_item, lists.details, 1);
      if (m.length === 0) return null;
      by = "detail";
      detailItem = m[0];
    } else if (!(by in BREAKDOWN_BY)) {
      // A Basic Details item written straight into "by" ("by": "SAP Code").
      const m = resolveNames(o.by, lists.details, 1);
      if (m.length === 0) return null;
      by = "detail";
      detailItem = m[0];
    }
  }

  const items: string[] = [];
  for (const i of strings(o.items ?? o.item)) items.push(...resolveNames(i, lists.checks));
  let section: string | null = null;
  if (typeof o.section === "string" && o.section.trim()) {
    const m = resolveNames(o.section, lists.sections, 1);
    if (m.length > 0) section = m[0];
  }
  // A checks report needs something to show: named checks, a section, or named lots.
  if (name === "checks") {
    if (strings(o.items ?? o.item).length > 0 && items.length === 0) return null; // none of the named checks exists
    if (items.length === 0 && !section && jobs.length === 0 && vendors.length === 0) return null;
  }
  const onlyRaw = String(o.only ?? "").toLowerCase();
  const only: ReportCall["only"] =
    onlyRaw === "problems" || onlyRaw === "notes" || onlyRaw === "all" ? onlyRaw : items.length > 0 ? "all" : "problems";

  return {
    name, vendors: [...new Set(vendors)], reportType, site, jobs: [...new Set(jobs)], person, po,
    testResults, clearance, declared, conflict, by, detailItem, items: [...new Set(items)], section, only,
  };
}

// ---------------------------------------------------------------------------
// The queries
// ---------------------------------------------------------------------------

/** A SQL string literal. */
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const inList = (xs: string[]): string => xs.map(lit).join(", ");
/** Text safe inside an ILIKE '%...%' pattern. */
const likeText = (s: string): string => s.replace(/[%_\\$]/g, " ").replace(/'/g, "''").trim();

/** An item name as a column name: "AEML Engineer & Designation" -> aeml_engineer_designation. */
export function columnName(item: string): string {
  const n = item.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40).replace(/_+$/, "");
  return /^[a-z]/.test(n) ? n : `detail_${n}`.replace(/_+$/, "");
}

/** A number as text without a trailing ".0": 280, 33.3. */
const num = (x: string): string => `(CASE WHEN ${x} = round(${x}) THEN round(${x})::text ELSE (${x})::text END)`;

/** A check row that is not clean: failed, pending, or the inspector wrote Not Ok. */
const PROBLEM = "(result IN ('FAIL', 'CONDITIONAL') OR marked = 'Not Ok')";
/** The quantity a lot was offered with. */
const OFFERED = "item ILIKE '%offered%'";

interface Scope {
  /** Every filter of the call. */
  all: string;
  /** Only the filters that say which KIND of lot (type, site): the comparison group. */
  kind: string;
  /** True when a filter picks out particular lots (a vendor, a person, an outcome), not just a kind. */
  narrowed: boolean;
}

/** WHERE conditions for a call, on columns every table and view carries. `a` is a table alias with its dot. */
export function scopeOf(c: ReportCall, a = ""): Scope {
  const kind: string[] = [];
  if (c.reportType) kind.push(`${a}report_type = ${lit(c.reportType)}`);
  if (c.site) kind.push(`${a}site = ${lit(c.site)}`);
  const rest: string[] = [];
  if (c.vendors.length > 0) rest.push(`${a}vendor IN (${inList(c.vendors)})`);
  if (c.jobs.length > 0) rest.push(`${a}job_id IN (${inList(c.jobs)})`);
  if (c.person) {
    rest.push(`${a}report_id IN (SELECT report_id FROM inspection_items WHERE area = 'Basic Details' AND value ILIKE '%${likeText(c.person)}%')`);
  }
  if (c.po) rest.push(`${a}report_id IN (SELECT report_id FROM report_summary WHERE po_number = ${lit(c.po)})`);
  const outcome: string[] = [];
  if (c.testResults) outcome.push(`test_results_result = '${c.testResults === "ok" ? "PASS" : "FAIL"}'`);
  if (c.clearance === "not_yes") outcome.push("clearance_result <> 'PASS'");
  else if (c.clearance) outcome.push(`clearance_result = '${c.clearance === "yes" ? "PASS" : c.clearance === "rejected" ? "FAIL" : "CONDITIONAL"}'`);
  if (c.declared === "rejected") outcome.push("declaration ILIKE '%reject%'");
  else if (c.declared) outcome.push(`declaration_result = '${c.declared === "cleared" ? "PASS" : "FAIL"}'`);
  if (c.conflict) outcome.push("outcome_conflict");
  if (outcome.length > 0) rest.push(`${a}report_id IN (SELECT report_id FROM report_summary WHERE ${outcome.join(" AND ")})`);
  const join = (xs: string[]): string => (xs.length > 0 ? xs.join(" AND ") : "TRUE");
  return { all: join([...kind, ...rest]), kind: join(kind), narrowed: rest.length > 0 };
}

/** What the filters of a call say, for a table title: "ABB India Limited, LT_Mini_Pillar". */
function scopeLabel(c: ReportCall): string {
  const parts = [
    ...c.vendors,
    c.reportType ?? "",
    c.site ?? "",
    c.jobs.length > 0 ? c.jobs.join(", ") : "",
    c.person ? `lots with ${c.person}` : "",
    c.po ? `PO ${c.po}` : "",
    c.testResults ? `test results ${c.testResults === "ok" ? "Ok" : "Not Ok"}` : "",
    c.clearance ? `technical clearance ${c.clearance.replace("_", " ")}` : "",
    c.declared ? `declared ${c.declared.replace("_", " ")}` : "",
    c.conflict ? "conclusions disagree" : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "all lots";
}

export interface ReportQuery {
  title: string;
  sql: string;
  /** Background for the answer; false = a list the answer must give in full. */
  info: boolean;
}

function lotsQueries(c: ReportCall): ReportQuery[] {
  const s = scopeOf(c, "r.");
  const plain = scopeOf(c);
  const where = scopeLabel(c);
  return [
    {
      title: `The lots (${where}): purchase order, quantity offered, the three conclusions as written, checks not clean`,
      // Picked out by a filter: these lots ARE the answer, and the answer must name each.
      info: !s.narrowed,
      sql:
        "SELECT r.job_id, r.report_id, r.vendor, r.po_details AS purchase_order, " +
        `(SELECT string_agg(DISTINCT q.value, '; ') FROM lot_quantities q WHERE q.report_id = r.report_id AND q.${OFFERED}) AS quantity_offered, ` +
        "r.test_results, r.technical_clearance, r.declaration, r.outcome_conflict AS conclusions_disagree, " +
        "r.failed AS checks_failed, r.conditional AS checks_pending, r.marked_not_ok AS checks_marked_not_ok " +
        `FROM report_summary r WHERE ${s.all} ORDER BY r.job_id LIMIT 40`,
    },
    {
      title: `Totals over these lots (${where})`,
      info: true,
      sql:
        "SELECT count(*) AS lots, " +
        "count(*) FILTER (WHERE test_results_result = 'PASS') AS lots_test_results_ok, " +
        "count(*) FILTER (WHERE test_results_result = 'FAIL') AS lots_test_results_not_ok, " +
        "count(*) FILTER (WHERE clearance_result = 'PASS') AS lots_technical_clearance_yes, " +
        "count(*) FILTER (WHERE clearance_result = 'CONDITIONAL') AS lots_technical_clearance_conditional, " +
        "count(*) FILTER (WHERE clearance_result = 'FAIL') AS lots_technical_clearance_rejected, " +
        "count(*) FILTER (WHERE declaration_result = 'PASS') AS lots_declared_cleared_for_dispatch, " +
        "count(*) FILTER (WHERE declaration_result <> 'PASS') AS lots_not_cleared_for_dispatch, " +
        "count(*) FILTER (WHERE declaration ILIKE '%reject%') AS lots_declared_rejected, " +
        "count(*) FILTER (WHERE outcome_conflict) AS lots_whose_conclusions_disagree, " +
        "count(DISTINCT vendor) AS vendors, count(DISTINCT po_number) AS purchase_orders, " +
        "sum(checks) AS checks, sum(passed) AS passed, sum(failed) AS failed, sum(conditional) AS pending_or_conditional, " +
        "sum(marked_not_ok) AS marked_not_ok, round(100.0 * sum(passed) / NULLIF(sum(checks - no_verdict), 0), 1) AS pass_rate_percent, " +
        `(SELECT string_agg(${num("t.total")} || ' ' || t.unit, '; ' ORDER BY t.unit) FROM (SELECT unit, sum(amount) AS total FROM lot_quantities WHERE ${OFFERED} AND ${plain.all} GROUP BY unit) t) AS quantity_offered_in_total ` +
        `FROM report_summary WHERE ${plain.all}`,
    },
  ];
}

function breakdownQueries(c: ReportCall): ReportQuery[] {
  const s = scopeOf(c, "r.");
  const detail = c.by === "detail" && c.detailItem;
  const dim = detail ? { expr: "i.value", label: columnName(c.detailItem ?? "") } : BREAKDOWN_BY[c.by] ?? BREAKDOWN_BY.vendor;
  const join = detail
    ? ` JOIN inspection_items i ON i.report_id = r.report_id AND i.area = 'Basic Details' AND i.item = ${lit(c.detailItem ?? "")}`
    : "";
  const what = detail ? c.detailItem : c.by.replace(/_/g, " ");
  return [
    {
      title: `Lots, quantity offered and check tallies by ${what} (${scopeLabel(c)}); each share is of the total over these rows`,
      info: true,
      sql:
        `WITH s AS (SELECT ${dim.expr} AS grp, r.* FROM report_summary r${join} WHERE ${s.all}), ` +
        "n AS (SELECT count(*) AS lots FROM s), " +
        `q AS (SELECT s.grp, l.unit, sum(l.amount) AS amt FROM lot_quantities l JOIN s ON s.report_id = l.report_id WHERE l.${OFFERED} GROUP BY s.grp, l.unit), ` +
        `qs AS (SELECT q.grp, string_agg(${num("q.amt")} || ' of ' || ${num("t.tot")} || ' ' || q.unit || ' (' || ${num("round(100.0 * q.amt / NULLIF(t.tot, 0), 1)")} || '%)', '; ' ORDER BY q.unit) AS quantity ` +
        "FROM q JOIN (SELECT unit, sum(amt) AS tot FROM q GROUP BY unit) t ON t.unit = q.unit GROUP BY q.grp) " +
        `SELECT s.grp AS ${dim.label}, count(*) AS lots, ` +
        `count(*) || ' of ' || max(n.lots) || ' (' || ${num("round(100.0 * count(*) / max(n.lots), 1)")} || '%)' AS share_of_lots, ` +
        "string_agg(s.job_id, ', ' ORDER BY s.job_id) AS jobs, " +
        "count(DISTINCT s.vendor) AS vendors, string_agg(DISTINCT s.vendor, '; ') AS vendor_names, " +
        "max(qs.quantity) AS quantity_offered_and_share, " +
        "count(*) FILTER (WHERE s.test_results_result = 'PASS') || ' of ' || count(*) AS lots_with_test_results_ok, " +
        "count(*) FILTER (WHERE s.clearance_result = 'PASS') || ' of ' || count(*) AS lots_with_technical_clearance_yes, " +
        "sum(s.checks) AS checks, sum(s.marked_not_ok) AS checks_marked_not_ok, sum(s.failed) AS checks_failed, sum(s.conditional) AS checks_pending, " +
        `${num("round(100.0 * sum(s.marked_not_ok) / NULLIF(sum(s.checks), 0), 1)")} || '%' AS not_ok_share_of_checks, ` +
        `${num("round(100.0 * sum(s.passed) / NULLIF(sum(s.checks - s.no_verdict), 0), 1)")} || '%' AS pass_rate ` +
        "FROM s CROSS JOIN n LEFT JOIN qs ON qs.grp IS NOT DISTINCT FROM s.grp GROUP BY s.grp ORDER BY lots DESC, 1 LIMIT 40",
    },
  ];
}

function checksQueries(c: ReportCall): ReportQuery[] {
  const s = scopeOf(c);
  const pick: string[] = [];
  if (c.items.length > 0) pick.push(`item IN (${inList(c.items)})`);
  if (c.section) pick.push(`section = ${lit(c.section)}`);
  const picked = pick.length > 0 ? pick.join(" AND ") : "TRUE";
  const only = c.only === "problems" ? ` AND ${PROBLEM}` : c.only === "notes" ? " AND note <> ''" : "";
  const what = [c.items.length > 0 ? c.items.join(" / ") : "", c.section ? `section ${c.section}` : ""].filter(Boolean).join(", ") || "checks";
  const kind = c.only === "problems" ? "not clean (failed, pending or marked Not Ok)" : c.only === "notes" ? "with a note" : "as recorded";
  const out: ReportQuery[] = [
    {
      title: `${what}, ${kind} (${scopeLabel(c)})`,
      info: false,
      sql:
        "SELECT job_id, report_id, vendor, section, item, marked, result, value, measurement, note, page " +
        `FROM checks WHERE ${s.all} AND ${picked}${only} ORDER BY job_id, position LIMIT 120`,
    },
  ];
  if (c.items.length > 0) {
    // Over every lot of the kind (not only the vendor or lots asked about), so a
    // wrong assumption in the question ("since Acme failed ...") can be seen.
    out.push({
      title: `${what}: how every lot came out (${c.reportType ?? "all report types"})`,
      info: true,
      sql:
        "SELECT item, count(DISTINCT report_id) AS lots_checked, " +
        "count(DISTINCT report_id) FILTER (WHERE result = 'PASS') AS lots_passed, " +
        "count(DISTINCT report_id) FILTER (WHERE result = 'FAIL' OR marked = 'Not Ok') AS lots_failed_or_not_ok, " +
        "count(DISTINCT report_id) FILTER (WHERE result = 'CONDITIONAL') AS lots_pending_or_conditional, " +
        `string_agg(DISTINCT job_id || ' (' || vendor || ')', '; ') FILTER (WHERE ${PROBLEM}) AS lots_not_clean ` +
        `FROM checks WHERE ${s.kind} AND item IN (${inList(c.items)}) GROUP BY item ORDER BY item`,
    });
    out.push({
      title: `${what}: lots not clean on it, out of the lots checked (${c.reportType ?? "all report types"})`,
      info: true,
      sql:
        `SELECT count(DISTINCT report_id) FILTER (WHERE ${PROBLEM}) || ' of ' || count(DISTINCT report_id) AS lots_not_clean_of_lots_checked, ` +
        `string_agg(DISTINCT job_id, ', ') FILTER (WHERE ${PROBLEM}) AS jobs_not_clean, ` +
        `string_agg(DISTINCT job_id, ', ') FILTER (WHERE NOT ${PROBLEM} OR ${PROBLEM} IS NULL) AS jobs_with_a_clean_row ` +
        `FROM checks WHERE ${s.kind} AND item IN (${inList(c.items)})`,
    });
  }
  return out;
}

function recurringQueries(c: ReportCall): ReportQuery[] {
  const s = scopeOf(c);
  const sec = c.section ? ` AND section = ${lit(c.section)}` : "";
  const where = scopeLabel(c) + (c.section ? `, section ${c.section}` : "");
  return [
    {
      title: `Checks ranked by how many lots are not clean on them (${where})`,
      info: true,
      sql:
        "SELECT item, section, count(DISTINCT report_id) AS lots_not_clean, " +
        `(SELECT count(*) FROM report_summary WHERE ${s.all}) AS lots_considered, ` +
        "count(DISTINCT vendor) AS vendors, string_agg(DISTINCT vendor, '; ') AS vendor_names, string_agg(DISTINCT job_id, ', ') AS jobs, " +
        "count(*) FILTER (WHERE marked = 'Not Ok') AS marked_not_ok, count(*) FILTER (WHERE result = 'FAIL') AS failed, " +
        "count(*) FILTER (WHERE result = 'CONDITIONAL') AS pending_or_conditional " +
        `FROM checks WHERE ${s.all}${sec} AND ${PROBLEM} GROUP BY item, section ORDER BY lots_not_clean DESC, item LIMIT 40`,
    },
    {
      title: `Each section, most Not Ok marks first (${where})`,
      info: true,
      sql:
        "SELECT report_type, section, count(*) FILTER (WHERE marked = 'Not Ok') AS marked_not_ok_in_all, " +
        `count(*) FILTER (WHERE ${PROBLEM}) AS not_clean_in_all, count(*) AS checks_in_all, ` +
        `${num("round(100.0 * count(*) FILTER (WHERE marked = 'Not Ok') / NULLIF(count(*), 0), 1)")} || '%' AS marked_not_ok_share_of_section ` +
        `FROM checks WHERE ${s.all}${sec} GROUP BY report_type, section ORDER BY marked_not_ok_in_all DESC, not_clean_in_all DESC, section LIMIT 40`,
    },
    {
      title: `Each vendor: checks and how many are not clean (${where})`,
      info: true,
      sql:
        "SELECT vendor, count(DISTINCT report_id) AS lots, count(*) AS checks, count(*) FILTER (WHERE marked = 'Not Ok') AS marked_not_ok, " +
        "count(*) FILTER (WHERE result = 'FAIL') AS failed, count(*) FILTER (WHERE result = 'CONDITIONAL') AS pending_or_conditional, " +
        `count(*) FILTER (WHERE ${PROBLEM}) AS not_clean_in_all, ` +
        `round(100.0 * count(*) FILTER (WHERE ${PROBLEM}) / NULLIF(count(*), 0), 1) AS not_clean_percent_of_checks ` +
        `FROM checks WHERE ${s.all}${sec} GROUP BY vendor ORDER BY not_clean_in_all DESC, vendor LIMIT 40`,
    },
  ];
}

function observationQueries(c: ReportCall): ReportQuery[] {
  const s = scopeOf(c);
  const where = scopeLabel(c);
  return [
    {
      title: `Observations by severity (${where})`,
      info: true,
      sql:
        "SELECT coalesce(severity, 'no severity recorded') AS severity, count(*) AS observations, count(DISTINCT report_id) AS lots, " +
        "string_agg(DISTINCT job_id, ', ') AS jobs " +
        `FROM observations WHERE ${s.all} GROUP BY 1 ORDER BY observations DESC`,
    },
    {
      title: `Each lot's observations (${where})`,
      info: true,
      sql:
        "SELECT job_id, report_id, vendor, report_type, observations, critical_observations, major_observations, minor_observations, " +
        "coalesce(worst_observation, 'no severity recorded') AS worst_observation, declaration " +
        `FROM report_summary WHERE ${s.all} ORDER BY job_id LIMIT 40`,
    },
    {
      title: `The observations as written (${where})`,
      info: true,
      sql: `SELECT job_id, report_id, vendor, item, severity, value, note, page FROM observations WHERE ${s.all} ORDER BY job_id, position LIMIT 60`,
    },
  ];
}

function attachmentQueries(c: ReportCall): ReportQuery[] {
  const s = scopeOf(c);
  const where = scopeLabel(c);
  return [
    {
      title: `Each required photo or file: in how many reports it is missing (${where})`,
      info: true,
      sql:
        "SELECT item, count(DISTINCT report_id) FILTER (WHERE NOT attached) || ' of ' || count(DISTINCT report_id) AS reports_missing_it_of_reports_requiring_it, " +
        "count(DISTINCT report_id) FILTER (WHERE NOT attached) AS reports_missing_it, " +
        "string_agg(DISTINCT job_id, ', ') FILTER (WHERE NOT attached) AS jobs_missing_it " +
        `FROM attachments WHERE ${s.all} GROUP BY item ORDER BY reports_missing_it DESC, item`,
    },
    {
      title: `Missing photos and files in total (${where})`,
      info: true,
      sql:
        "SELECT count(*) FILTER (WHERE NOT attached) AS missing_in_total, count(*) AS required_in_total, " +
        "count(DISTINCT report_id) FILTER (WHERE NOT attached) || ' of ' || count(DISTINCT report_id) AS reports_with_something_missing, " +
        "string_agg(DISTINCT job_id, ', ') FILTER (WHERE NOT attached) AS jobs_with_something_missing " +
        `FROM attachments WHERE ${s.all}`,
    },
    {
      title: `The missing photos and files, one row each (${where})`,
      info: true,
      sql: `SELECT job_id, report_id, vendor, section, item, value, note, page FROM attachments WHERE ${s.all} AND NOT attached ORDER BY job_id, position LIMIT 60`,
    },
  ];
}

/** The fixed queries of one checked call. Pure. */
export function queriesFor(c: ReportCall): ReportQuery[] {
  switch (c.name) {
    case "lots":
      return lotsQueries(c);
    case "breakdown":
      return breakdownQueries(c);
    case "checks":
      return checksQueries(c);
    case "recurring":
      return recurringQueries(c);
    case "observations":
      return observationQueries(c);
    case "attachments":
      return attachmentQueries(c);
  }
}

// ---------------------------------------------------------------------------
// The model picks
// ---------------------------------------------------------------------------

export function pickSystemPrompt(catalogText: string): string {
  return [
    "You route questions about equipment inspection reports to ready-made reports. You never answer the question.",
    "Reply with one JSON object and nothing else.",
    "",
    "READY-MADE REPORTS",
    "lots         The lots (inspection reports) that match, one row each: vendor, purchase order, quantity offered, the",
    "             three conclusions as written (test results, technical clearance, declaration), whether they",
    "             disagree. Plus totals over those lots (how many, quantity offered in total).",
    "             Narrow it to the lots asked about with the outcome filters:",
    "             \"test_results\": \"ok\" | \"not_ok\"     \"technical_clearance\": \"yes\" | \"conditional\" | \"rejected\" | \"not_yes\"",
    "             \"declaration\": \"cleared\" | \"not_cleared\" | \"rejected\"     \"conflict\": true (conclusions disagree)",
    "             For: which lots / how many lots are cleared, rejected, held up, clean, in conflict; each lot's quantity",
    "             or purchase order; a scorecard or summary of a vendor; how lots concluded; lots against a purchase",
    "             order; the lots a named person attended; quantity sitting in lots with some outcome.",
    "breakdown    Lots grouped by ONE thing, each group with its lots, share of lots, quantity offered and its share of",
    "             the total, and check tallies and pass rate.",
    "             \"by\": vendor | report_type | site | test_results | technical_clearance | declaration |",
    "             purchase_order | po_month | inspection_date | worst_observation | detail",
    "             With \"by\": \"detail\" give \"detail_item\": a Basic Details item from the lists (an engineer, a code, a size).",
    "             For: split, how many of each, per vendor / type / engineer, share or percentage of lots or of quantity,",
    "             totals of quantity, most, least, pass rate, who covered the most, how many different values.",
    "checks       The rows of named checks or tests in every lot (value, note, result), and for each how many lots passed,",
    "             failed or are pending. \"items\": exact names from the lists (give the same test under EVERY report",
    "             type's name for it), and / or \"section\". \"only\": \"problems\" when the question asks which lots",
    "             failed, are not ok or have it missing; \"notes\" for notes; \"all\" to compare lots or read values.",
    "             For: how a test came out, which lots failed it, comparing lots on it, everything wrong in a lot or a",
    "             section, a statement that a vendor failed a test.",
    "recurring    Checks ranked by how many lots are not clean on them, tallies per section and per vendor.",
    "             Optional \"section\". For: most common, recurring or repeated problems, the worst section, which",
    "             vendor has the most failures or Not Ok marks.",
    "observations The inspection observations with their severity, and the tally of severities.",
    "attachments  Required photos and files: which are missing, in how many reports.",
    "",
    "FILTERS (optional, for any report; leave out what the question does not restrict)",
    "\"vendors\": [names from the list]   \"report_type\": a name from the list   \"site\": a name from the list",
    "\"jobs\": [job ids written in the question]   \"person\": a person's name   \"po\": a purchase order number",
    "",
    "REPLY",
    "{\"reports\": [{\"name\": \"...\", ...}]} with exactly one report: the one whose rows are the answer.",
    "{\"reports\": []} when no report fits: the question asks for one or two values recorded in one report; what a term",
    "means; how a procedure or SOP says to do something; how a report is laid out; something that is not about the",
    "inspection records; or something these reports do not record at all (prices, penalties, complaints, deliveries,",
    "warranties, certificates, sampling, trends over months, who approved something, what happens next).",
    "Use only names from the lists below. If the question names a vendor, product or test that is not in the lists,",
    "reply {\"reports\": []}.",
    "",
    "WHAT THIS WORKSPACE HOLDS",
    catalogText,
    "",
    "EXAMPLES (the pattern matters, not the names)",
    "Q: Give me a quick scorecard for Acme.",
    "{\"reports\": [{\"name\": \"lots\", \"vendors\": [\"Acme\"]}]}",
    "Q: Which lots are held up, not cleared for dispatch or rejected?",
    "{\"reports\": [{\"name\": \"lots\", \"declaration\": \"not_cleared\"}]}",
    "Q: Which reports show test results Not Ok but still got technical clearance Yes?",
    "{\"reports\": [{\"name\": \"lots\", \"test_results\": \"not_ok\", \"technical_clearance\": \"yes\"}]}",
    "Q: Was clearance refused outright on any pump lot?",
    "{\"reports\": [{\"name\": \"lots\", \"report_type\": \"Pumps\", \"technical_clearance\": \"rejected\"}]}",
    "Q: Compare the quantity offered across the Acme lots.",
    "{\"reports\": [{\"name\": \"lots\", \"vendors\": [\"Acme\"]}]}",
    "Q: How many of R. Sharma's inspections ended with test results Ok, and which?",
    "{\"reports\": [{\"name\": \"lots\", \"person\": \"R. Sharma\", \"test_results\": \"ok\"}]}",
    "Q: What share of the pumps offered came from Acme?",
    "{\"reports\": [{\"name\": \"breakdown\", \"by\": \"vendor\", \"report_type\": \"Pumps\"}]}",
    "Q: How many metres sit in lots whose test result is Not Ok?",
    "{\"reports\": [{\"name\": \"lots\", \"test_results\": \"not_ok\"}]}",
    "Q: What percentage of all pump checks came out Not Ok?",
    "{\"reports\": [{\"name\": \"breakdown\", \"by\": \"report_type\"}]}",
    "Q: Does any purchase order appear under two vendors?",
    "{\"reports\": [{\"name\": \"breakdown\", \"by\": \"purchase_order\"}]}",
    "Q: Which engineer from our side covered the most inspections?",
    "{\"reports\": [{\"name\": \"breakdown\", \"by\": \"detail\", \"detail_item\": \"Client Engineer\"}]}",
    "Q: Which purchase orders have more than one lot?",
    "{\"reports\": [{\"name\": \"breakdown\", \"by\": \"purchase_order\"}]}",
    "Q: Which lots failed the pressure test, across both product types?",
    "{\"reports\": [{\"name\": \"checks\", \"items\": [\"Pressure Test\", \"Hydraulic pressure test at 1.5x\"], \"only\": \"problems\"}]}",
    "Q: Compare the two Acme lots on the pressure test.",
    "{\"reports\": [{\"name\": \"checks\", \"items\": [\"Pressure Test\"], \"vendors\": [\"Acme\"], \"only\": \"all\"}]}",
    "Q: How many compliance items are Not Ok in all, and how does that split between pumps and valves?",
    "{\"reports\": [{\"name\": \"recurring\", \"section\": \"Compliances\"}]}",
    "Q: Zenith failed the HV test - what value was recorded?",
    "{\"reports\": [{\"name\": \"checks\", \"items\": [\"HV Test\"], \"vendors\": [\"Zenith\"]}]}",
    "Q: Everything wrong in the packing section of JOB2026000123?",
    "{\"reports\": [{\"name\": \"checks\", \"section\": \"Packing\", \"jobs\": [\"JOB2026000123\"], \"only\": \"problems\"}]}",
    "Q: What are the top recurring problems in the pump reports, and which vendor is worst?",
    "{\"reports\": [{\"name\": \"recurring\", \"report_type\": \"Pumps\"}]}",
    "Q: Tally the observation severities for the valve lots.",
    "{\"reports\": [{\"name\": \"observations\", \"report_type\": \"Valves\"}]}",
    "Q: Which photo is missing most often?",
    "{\"reports\": [{\"name\": \"attachments\"}]}",
    "Q: What is the warranty period on the Acme pumps?",
    "{\"reports\": []}",
    "Q: What torque does the SOP give for the flange bolts?",
    "{\"reports\": []}",
  ].join("\n");
}

/** The report requests in the model's reply (unchecked). Empty when it chose none or wrote no JSON. */
export function parsePick(reply: string): unknown[] {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const o = JSON.parse(reply.slice(start, end + 1)) as { reports?: unknown };
    return Array.isArray(o.reports) ? o.reports.slice(0, 1) : [];
  } catch {
    return [];
  }
}

function trace(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`[data] ${line}`);
}

/** A result with nothing in it: no rows, or one row of zeros and blanks. */
function empty(rows: Record<string, unknown>[]): boolean {
  if (rows.length === 0) return true;
  if (rows.length > 1) return false;
  return Object.values(rows[0]).every((v) => v === null || v === "" || v === 0 || v === "0");
}

/**
 * Ask the model which ready-made report answers `question` and run it. Null
 * when none fits, a parameter names something the workspace does not hold, or
 * the reports came back with nothing: the caller then goes on as before.
 */
export async function runReports(
  tenantId: string,
  question: string,
  cat: DataCatalog,
  catalogText: string,
  history: HistoryTurn[] = [],
  jobIds: string[] = []
): Promise<DataTable[] | null> {
  const ask = [
    ...(history.length > 0
      ? [
          "EARLIER IN THIS CONVERSATION (only to resolve words like \"it\", \"those\", \"the same for\"):",
          ...history.slice(-6).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 500)}`),
          "",
        ]
      : []),
    ...(jobIds.length > 0 && jobIds.length <= 12 ? [`LOTS THE QUESTION REFERS TO (use as "jobs"): ${jobIds.join(", ")}`] : []),
    `Q: ${question}`,
  ].join("\n");
  const reply = await chatComplete({
    system: pickSystemPrompt(catalogText),
    user: ask,
    maxTokens: 300,
    numCtx: 8192,
    model: config.DATA_MODEL || undefined,
  });
  const raw = parsePick(reply);
  if (raw.length === 0) {
    trace(`reports: none for: ${question.slice(0, 120).replace(/\s+/g, " ")}`);
    return null;
  }
  const lists = catalogLists(cat);
  const calls: ReportCall[] = [];
  for (const r of raw) {
    const c = validateCall(r, lists);
    if (!c) {
      trace(`reports: refused ${JSON.stringify(r).slice(0, 200)}`);
      return null;
    }
    calls.push(c);
  }
  const tables: DataTable[] = [];
  for (const c of calls) {
    for (const q of queriesFor(c)) {
      try {
        const t = await runSql(tenantId, q.sql);
        if (!empty(t.rows)) tables.push({ title: q.title, sql: q.sql, info: q.info, ...t });
      } catch (err) {
        trace(`reports: query failed (${err instanceof Error ? err.message.slice(0, 160) : "error"}): ${q.sql.slice(0, 200)}`);
      }
    }
  }
  trace(`reports: ${calls.map((c) => c.name).join(" + ")} -> ${tables.length} tables for: ${question.slice(0, 100).replace(/\s+/g, " ")}`);
  // The first table of a report is the report itself: without it there is nothing to answer from.
  return tables.length > 0 ? tables : null;
}
