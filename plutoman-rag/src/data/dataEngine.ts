/**
 * The data engine: questions that need EVERY matching record — how many,
 * which, compare, rank, pass rates, what is pending, give me an overview —
 * answered by a database query instead of a search.
 *
 *   question -> the model writes 1-3 SQL queries (or says LOOKUP)
 *            -> each is validated and run read-only, tenant-scoped (runSql.ts)
 *            -> the model words the result tables; a deterministic check
 *               rejects any figure that is not in them
 *            -> answer + the tables themselves + citations from the rows
 *
 * Why this generalises: nothing here knows any particular question. A new
 * question is a new query over the same two tables, written at run time from
 * the schema and the values actually present in the tenant's data. The
 * database does all counting; the model never produces a number.
 *
 * Returns null when the question is a lookup (one recorded value, a
 * procedure's wording, a definition) or the engine could not produce a
 * trustworthy result — the caller then falls back to search, as before.
 */
import { chatComplete } from "../llm";
import { config } from "../config";
import { withTenantRead } from "../db";
import { getTenantDerived } from "../cache";
import { Citation } from "../retrieval/citations";
import { runSql, SqlError, SqlTable } from "./runSql";

export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface DataTable extends SqlTable {
  title: string;
  sql: string;
  /** Background for the answer (not something the answer must reproduce row by row). */
  info?: boolean;
}

export interface DataAnswer {
  answer: string;
  tables: DataTable[];
  citations: Citation[];
  /** Reports in the workspace, and how many of them the result rows name (null = an aggregate). */
  coverage: { reportsTotal: number; reportsInResult: number | null };
}

// ---------------------------------------------------------------------------
// What is in this tenant's data (so the model uses real names, not guesses)
// ---------------------------------------------------------------------------

export interface DataCatalog {
  reports: number;
  firstDate: string | null;
  lastDate: string | null;
  vendors: { name: string; reports: number }[];
  sites: string[];
  reportTypes: { name: string; reports: number }[];
  /** report type -> area / section -> item names. */
  items: { reportType: string; group: string; items: string[] }[];
  /** Items of the lot that carry quantities, with the units they are recorded in. */
  quantities: { item: string; units: string[] }[];
}

/** Item names listed in the prompt, at most (the rest are still queryable). */
const MAX_CATALOG_ITEMS = 260;

export async function loadDataCatalog(tenantId: string): Promise<DataCatalog> {
  return getTenantDerived(tenantId, "data-catalog", 600, () =>
    withTenantRead(tenantId, async (c) => {
      const totals = await c.query<{ n: string; first: string | null; last: string | null }>(
        `SELECT count(*) AS n, min(inspection_date)::text AS first, max(inspection_date)::text AS last
           FROM inspection_reports WHERE tenant_id = $1`,
        [tenantId]
      );
      const by = async (col: string) =>
        (
          await c.query<{ name: string; n: string }>(
            `SELECT ${col} AS name, count(*) AS n FROM inspection_reports
              WHERE tenant_id = $1 AND ${col} IS NOT NULL GROUP BY 1 ORDER BY 1`,
            [tenantId]
          )
        ).rows.map((r) => ({ name: r.name, reports: Number(r.n) }));
      const items = await c.query<{ report_type: string | null; area: string; section: string | null; items: string[] }>(
        `SELECT report_type, area, section, array_agg(DISTINCT item ORDER BY item) AS items
           FROM inspection_items
          WHERE tenant_id = $1 AND area <> 'Observations'
          GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
        [tenantId]
      );
      const quantities = await c.query<{ item: string; units: string[] }>(
        `SELECT item, array_agg(DISTINCT unit ORDER BY unit) AS units
           FROM inspection_amounts
          WHERE tenant_id = $1 AND area = 'Basic Details'
          GROUP BY 1 ORDER BY 1 LIMIT 40`,
        [tenantId]
      );
      let budget = MAX_CATALOG_ITEMS;
      const groups = items.rows.map((r) => {
        const take = r.items.slice(0, Math.max(0, budget));
        budget -= take.length;
        return { reportType: r.report_type ?? "(no type)", group: [r.area, r.section].filter(Boolean).join(" / "), items: take };
      });
      return {
        reports: Number(totals.rows[0].n),
        firstDate: totals.rows[0].first,
        lastDate: totals.rows[0].last,
        vendors: await by("vendor"),
        sites: (await by("site")).map((s) => s.name),
        reportTypes: await by("report_type"),
        items: groups.filter((g) => g.items.length > 0),
        quantities: quantities.rows,
      };
    })
  );
}

// ---------------------------------------------------------------------------
// Step 1 — the model writes the queries
// ---------------------------------------------------------------------------

export const SCHEMA = `TABLE inspection_reports  (one row per inspection report)
  report_id            text  report number, e.g. 'POID-4547081947'
  job_id               text  job number, e.g. 'PH2026100008'
  report_type          text  kind of equipment inspected
  category, subcategory text
  site                 text
  vendor               text
  inspection_date      date
  prepared_by          text  the inspector
  status               text  status of the checklist itself (e.g. 'Completed'), NOT the outcome
  test_results         text  conclusion as written;  test_results_result  'PASS' | 'FAIL' | 'CONDITIONAL'
  technical_clearance  text  conclusion as written;  clearance_result     'PASS' | 'FAIL' | 'CONDITIONAL'
  declaration          text  the dispatch decision as written;  declaration_result 'PASS' | 'FAIL' | 'CONDITIONAL'
  outcome_summary      text  the whole conclusion in the report's own words (all three fields with their notes)
  outcome_conflict     boolean  true when the three conclusion fields do not agree with each other
  items_checked, items_passed, items_failed, items_conditional  integer  tally of the report's checked items

TABLE inspection_items  (one row per item recorded in a report)
  report_id, job_id, report_type, site, vendor, inspection_date   same values as the report's row
  area         text  'Basic Details' (facts about the lot) | 'Characteristics' (the checks) | 'Observations' | 'Conclusion'
  section      text  group inside the area, e.g. 'Acceptance Tests' (may be NULL)
  item         text  what was recorded, e.g. 'IR Test', 'SAP Code'
  value        text  as written in the report
  measurement  text
  note         text  the inspector's note
  result       text  'PASS' | 'FAIL' | 'CONDITIONAL'; NULL when the item is a fact, not a check
  marked       text  the result word exactly as written: 'Ok' | 'Not Ok' | 'Attached' | 'Not Attached'; NULL when none
  page         text  printed page of the PDF report
  position     integer  order inside the report

STANDARD MEASURES (ready-made and already correct: use them instead of working a figure out yourself)

VIEW report_summary  (one row per report: anything counted, ranked or compared per report, vendor, site or type)
  every column of inspection_reports except the items_* tallies, plus
  checks             integer  how many items were checked in the report
  passed, failed, conditional   integer
  pass_rate_percent  numeric  100 * passed / checks
  marked_not_ok      integer  checks the inspector wrote 'Not Ok' against

VIEW section_summary  (one row per report and section)
  report_id, job_id, report_type, site, vendor, inspection_date, section,
  checks, passed, failed, conditional, pass_rate_percent, marked_not_ok

VIEW checks  (one row per checked item; the same columns as inspection_items without area)
  report_id, job_id, report_type, site, vendor, inspection_date, section, item, value, measurement, note, result, marked, page, position

TABLE inspection_amounts  (one row per quantity or reading, as a NUMBER that can be summed and compared)
  report_id, job_id, report_type, site, vendor, inspection_date, area, section, item, value, page, position
  amount       numeric  e.g. 5000
  unit         text     lower case, singular: 'nos', 'drum', 'mtr', 'mm', 'percent', ...`;

function renderCatalog(cat: DataCatalog): string {
  const lines = [
    `Reports: ${cat.reports}` + (cat.firstDate ? `, inspected ${cat.firstDate} to ${cat.lastDate}` : ""),
    `Vendors: ${cat.vendors.map((v) => `'${v.name}' (${v.reports})`).join(", ") || "none"}`,
    `Sites: ${cat.sites.map((s) => `'${s}'`).join(", ") || "none"}`,
    `Report types: ${cat.reportTypes.map((t) => `'${t.name}' (${t.reports})`).join(", ") || "none"}`,
    `Quantities in inspection_amounts (item: units): ${(cat.quantities ?? []).map((q) => `'${q.item}': ${q.units.join(", ")}`).join("; ") || "none"}`,
    "Items, by report type and area / section:",
  ];
  let current = "";
  for (const g of cat.items) {
    if (g.reportType !== current) {
      current = g.reportType;
      lines.push(` ${current}`);
    }
    lines.push(`  ${g.group}: ${g.items.join(" | ")}`);
  }
  return lines.join("\n");
}

export function planSystemPrompt(cat: DataCatalog, today: string): string {
  return [
    "You answer questions about equipment inspection reports by writing PostgreSQL queries.",
    "The database computes the answer. You never compute or guess a number yourself.",
    "",
    SCHEMA,
    "",
    "WHAT THIS DATABASE HOLDS (use these exact spellings in your queries)",
    renderCatalog(cat),
    "",
    "DECIDE FIRST",
    "Reply with the single word LOOKUP only when the question:",
    "- is about ONE report and asks for one or two values or notes recorded in it, or",
    "- asks what a term means, or how a procedure / SOP / other document says to do something, or",
    "- asks how a report is laid out: which sections or parts it contains, in what order, what its contents page lists, or",
    "- is not about the inspection records at all.",
    "Every other question is answered with SQL: anything about several reports, a whole section, a vendor, a site or",
    "a person across reports; anything asking which, how many, list, all, any, compare, most, least, rate, share,",
    "summary or overview.",
    "",
    "HOW TO REPLY WITH SQL",
    "One to three queries. Before each, a line `TITLE: <what the rows show>`, then the query in a ```sql block.",
    "Use more than one query only for an overview (for example: the totals, the breakdown, the exceptions).",
    "",
    "RULES",
    "1. Each query is one SELECT (WITH is allowed) over the tables and views above only. No comments, no semicolons.",
    "2. Match names loosely and case-insensitively: vendor ILIKE '%polycab%'. Only use names from the lists above.",
    "3. When rows are items, select report_id, job_id, vendor, item, value, note, result, page so each row can be cited.",
    "   When rows are reports, select report_id, job_id, vendor and the columns asked about.",
    "4. Three different things, never mixed:",
    "   - \"marked Not Ok\", \"Not Ok\", \"not okay\": the word the inspector wrote. marked = 'Not Ok' (in checks), or marked_not_ok (in the summaries).",
    "   - \"failed\", \"rejected\": result = 'FAIL'.",
    "   - \"did not pass\", \"problems\", \"issues\", \"deviations\", \"below spec\", \"not clear\": result IN ('FAIL', 'CONDITIONAL').",
    "   Count checks in the view checks (it leaves out items that were not checks).",
    "5. Never JOIN. Every table and view already carries report_id, job_id, vendor, site, report_type and inspection_date;",
    "   to restrict one by another use report_id IN (SELECT report_id FROM ...). Tallies and rates come from report_summary or",
    "   section_summary. Over several reports, add the columns up: ROUND(100.0 * SUM(passed) / NULLIF(SUM(checks), 0), 1).",
    "6. Whenever the question is about a lot's outcome (cleared, rejected, dispatch, accepted, passed overall), select",
    "   report_id, job_id, vendor, outcome_summary, outcome_conflict and items_failed. Never judge an outcome from one",
    "   conclusion field alone: the three can disagree. Filter or count with the *_result columns, show outcome_summary.",
    "7. Give columns plain names with AS. ORDER BY what matters most. LIMIT lists to 50 rows.",
    "8. Everything recorded about a lot that is not a column of inspection_reports is a row of inspection_items:",
    "   people (engineers), codes, PO details, quantities, batch and serial numbers and sizes have area = 'Basic Details'.",
    "   prepared_by is only the person who filled in the checklist. Find rows by a distinctive word of the item name",
    "   from the lists above: item ILIKE '%engineer%', item ILIKE '%ovality%'.",
    "9. result holds only PASS / FAIL / CONDITIONAL. Any other wording (for example 'Not Attached', 'Major', a name,",
    "   a measured figure) is in value or note: filter it with value ILIKE '%...%'.",
    "10. Prefer selecting the matching rows to count(*) alone: you are told how many rows there are, and each row can be",
    "    cited. Use count or sum when grouping (per vendor, per report, per section) or when the rows would exceed 50.",
    "11. Totals of quantities (how much, how many units, add up, in total): SUM(amount) FROM inspection_amounts, with",
    "    GROUP BY unit, filtered by a word of the item name (item ILIKE '%offered%'). Never add up text values yourself.",
    "    Always add a second query that lists each lot's own recorded value (the rows of inspection_items), so every",
    "    lot's quantity is shown next to the total.",
    "12. \"How many of them / of each\" needs the whole as well as the part: select both (COUNT(*) AS reports and",
    "    COUNT(*) FILTER (WHERE ...) AS matching), so the answer can say \"2 of 5\".",
    "13. \"Shared by / under two different ...\": GROUP BY the shared value HAVING COUNT(DISTINCT the other column) > 1.",
    "14. When the user message lists REPORTS MATCHING THE DETAILS IN THE QUESTION, those are the reports meant:",
    "    filter with job_id IN (...) exactly as listed.",
    `15. Today is ${today}.`,
    "",
    "EXAMPLES (the pattern matters, not the names)",
    "Q: How many checks are marked Not Ok in the Acme report?",
    "TITLE: Checks marked Not Ok in the Acme report",
    "```sql",
    "SELECT report_id, job_id, vendor, section, item, value, note, result, page FROM checks WHERE vendor ILIKE '%acme%' AND marked = 'Not Ok' ORDER BY report_id, position",
    "```",
    "Q: What is the pass rate on Acme's checks?",
    "TITLE: Pass rate of Acme's checks",
    "```sql",
    "SELECT vendor, COUNT(*) AS reports, SUM(checks) AS checks, SUM(passed) AS passed, ROUND(100.0 * SUM(passed) / NULLIF(SUM(checks), 0), 1) AS pass_rate_percent FROM report_summary WHERE vendor ILIKE '%acme%' GROUP BY vendor",
    "```",
    "Q: Which Acme lot is the worst?",
    "TITLE: Acme lots, worst first",
    "```sql",
    "SELECT report_id, job_id, vendor, checks, passed, failed, conditional, marked_not_ok, pass_rate_percent, outcome_summary, outcome_conflict FROM report_summary WHERE vendor ILIKE '%acme%' ORDER BY failed + conditional DESC, pass_rate_percent LIMIT 10",
    "```",
    "Q: Total quantity Acme offered across its lots?",
    "TITLE: Total offered by Acme, per unit",
    "```sql",
    "SELECT unit, SUM(amount) AS total, COUNT(DISTINCT report_id) AS reports FROM inspection_amounts WHERE vendor ILIKE '%acme%' AND item ILIKE '%offered%' GROUP BY unit ORDER BY unit",
    "```",
    "TITLE: What each Acme lot offered",
    "```sql",
    "SELECT report_id, job_id, vendor, item, value, page FROM inspection_items WHERE vendor ILIKE '%acme%' AND item ILIKE '%offered%' ORDER BY report_id",
    "```",
    "Q: For each report type, how many reports concluded with test results Ok?",
    "TITLE: Reports with test results Ok, per report type",
    "```sql",
    "SELECT report_type, COUNT(*) AS reports, COUNT(*) FILTER (WHERE test_results_result = 'PASS') AS test_results_ok FROM report_summary GROUP BY report_type ORDER BY report_type",
    "```",
    "Q: Does any batch number appear under two different vendors?",
    "TITLE: Batch numbers recorded under more than one vendor",
    "```sql",
    "SELECT value AS batch, COUNT(DISTINCT vendor) AS vendors, STRING_AGG(DISTINCT vendor, '; ') AS vendor_names, STRING_AGG(DISTINCT job_id, ', ') AS jobs FROM inspection_items WHERE item ILIKE '%batch%' GROUP BY value HAVING COUNT(DISTINCT vendor) > 1",
    "```",
    "Q: Which reports did R. Sharma handle, and how did they conclude?",
    "TITLE: Reports handled by R. Sharma and their outcome",
    "```sql",
    "SELECT report_id, job_id, vendor, inspection_date, outcome_summary, outcome_conflict, failed FROM report_summary WHERE report_id IN (SELECT report_id FROM inspection_items WHERE area = 'Basic Details' AND value ILIKE '%sharma%') ORDER BY inspection_date",
    "```",
  ].join("\n");
}

export type Plan = { route: "lookup" } | { route: "data"; queries: { title: string; sql: string }[] };

/** Read the model's reply: LOOKUP, or up to three titled ```sql blocks. */
export function parsePlan(reply: string): Plan {
  const queries: { title: string; sql: string }[] = [];
  const block = /(?:TITLE:\s*([^\n]*)\n\s*)?```(?:sql)?\s*\n?([\s\S]*?)```/gi;
  for (const m of reply.matchAll(block)) {
    const sql = m[2].trim();
    if (sql) queries.push({ title: (m[1] ?? "").trim() || `Result ${queries.length + 1}`, sql });
  }
  if (queries.length === 0) {
    // A bare statement with no fence.
    const bare = /^\s*(?:TITLE:\s*([^\n]*)\n)?\s*((?:select|with)\b[\s\S]+)$/i.exec(reply);
    if (bare && !/\bLOOKUP\b/.test(reply)) queries.push({ title: (bare[1] ?? "").trim() || "Result 1", sql: bare[2].trim() });
  }
  return queries.length > 0 ? { route: "data", queries: queries.slice(0, 3) } : { route: "lookup" };
}

// ---------------------------------------------------------------------------
// Step 2 — wording the result
// ---------------------------------------------------------------------------

/** Rows shown to the model per table (the caller still gets every row). */
const MAX_ROWS_IN_PROMPT = 60;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    // A `date` column arrives as local midnight: print the calendar day.
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).replace(/\s+/g, " ").trim();
}

/** A table's rows as plain values for the API / UI (dates as calendar days, no Date objects). */
export function displayRows(t: SqlTable): Record<string, string | number | null>[] {
  return t.rows.map((r) => {
    const o: Record<string, string | number | null> = {};
    for (const c of t.columns) {
      const v = r[c];
      o[c] = v === null || v === undefined ? null : typeof v === "number" ? v : cell(v);
    }
    return o;
  });
}

export function renderTable(t: DataTable, maxRows = MAX_ROWS_IN_PROMPT): string {
  const head = `${t.title} (${t.rows.length} row${t.rows.length === 1 ? "" : "s"})`;
  if (t.rows.length === 0) return `${head}\n(no rows)`;
  const lines = t.rows.slice(0, maxRows).map((r) => t.columns.map((c) => `${c}: ${cell(r[c])}`).join(" | "));
  if (t.rows.length > maxRows) lines.push(`... and ${t.rows.length - maxRows} more rows`);
  return `${head}\n${lines.join("\n")}`;
}

export const ANSWER_SYSTEM_PROMPT = [
  "You write the answer to a question about equipment inspection reports.",
  "You are given RESULT tables that the database computed from every matching record.",
  "",
  "Rules:",
  "1. Use only the RESULT tables. Copy every number, name and recorded value from them exactly. Never calculate, round, estimate or add a figure of your own.",
  "2. Start with the direct answer in one or two sentences. Then, if it helps, the details as a short list.",
  "3. Name each report by its report_id and job_id when they are in the table.",
  "4. If a table has no rows, say that no matching records were found. Do not guess why.",
  "5. If results in one report disagree with each other, say so and give both. Do not pick one.",
  "6. Do not explain causes, give advice or judge a vendor beyond what the tables state.",
  "7. Never mention SQL, queries, tables, columns or the database.",
  "8. Quote what the report recorded, in its own words, whenever the table has it (value, note, outcome_summary).",
  "   PASS, FAIL and CONDITIONAL are only classifications: write them as passed, failed, and pending or conditional,",
  "   next to the recorded wording, never in place of it.",
  "9. When outcome_conflict is true, say that the report's conclusions disagree and give each one. Do not answer",
  "   with a plain yes or no.",
  "10. Plain text only: no markdown, no asterisks, no headings.",
].join("\n");

/** Numbers as written, ignoring thousands separators ("1,250" = "1250"). */
function numbersIn(text: string): string[] {
  return [...text.replace(/(\d),(?=\d{3}\b)/g, "$1").matchAll(/(?<![\w.])\d+(?:\.\d+)?/g)].map((m) => m[0]);
}

/**
 * Figures in the answer that the database did not produce: not in any result
 * cell, not a table's row count, and not in the question. Pure.
 */
export function inventedNumbers(answer: string, tables: DataTable[], question: string): string[] {
  const known = new Set<string>(numbersIn(question));
  for (const t of tables) {
    known.add(String(t.rows.length));
    for (const r of t.rows) for (const c of t.columns) numbersIn(cell(r[c])).forEach((n) => known.add(n));
  }
  const norm = (n: string) => String(Number(n));
  const knownNorm = new Set([...known].map(norm));
  return [...new Set(numbersIn(answer))].filter((n) => !knownNorm.has(norm(n)));
}

/**
 * True when a table found nothing: no rows, or one row of only zeros / blanks
 * (a count(*) that matched nothing). Such a result is far more often a filter
 * that does not match how the data is written than a true "none".
 */
export function foundNothing(t: SqlTable): boolean {
  if (t.rows.length === 0) return true;
  if (t.rows.length > 1) return false;
  return t.columns.every((c) => {
    const v = cell(t.rows[0][c]);
    return v === "" || /^0+(\.0+)?$/.test(v);
  });
}

/** An answer claiming nothing was found. */
const SAYS_NOTHING_FOUND = /\bno (matching |relevant )?(records?|results?|data|entries|items|reports?) (were|was|are|is)? ?found\b|\bno matching\b|\bnot found\b/i;

/**
 * The answer says nothing was found although every table has rows — the
 * wording contradicts the result, so it cannot be shown. Pure.
 */
export function deniesResult(answer: string, tables: SqlTable[]): boolean {
  return SAYS_NOTHING_FOUND.test(answer) && tables.every((t) => !foundNothing(t));
}

/** The result itself as the answer, when the model's wording cannot be trusted. */
function plainAnswer(tables: DataTable[]): string {
  return tables
    .map((t) => {
      if (t.rows.length === 0) return `${t.title}: no matching records were found.`;
      const n = t.rows.length;
      const lines = t.rows.slice(0, 15).map((r) => `- ${t.columns.map((c) => `${c}: ${cell(r[c])}`).join("; ")}`);
      if (n > 15) lines.push(`- and ${n - 15} more (see the table).`);
      return `${t.title} (${n} record${n === 1 ? "" : "s"}):\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/** One citation per report page the result rows name. */
export function citationsFrom(tables: DataTable[]): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const t of tables) {
    if (!t.columns.includes("report_id")) continue;
    for (const r of t.rows) {
      const reportId = cell(r["report_id"]);
      if (!reportId) continue;
      const page = cell(r["page"]) || null;
      const key = `${reportId}|${page ?? ""}`;
      if (seen.has(key) || out.length >= 40) continue;
      seen.add(key);
      out.push({
        sopId: reportId,
        sectionPath: cell(r["item"]) || null,
        poid: reportId.startsWith("POID-") ? reportId : null,
        jobId: cell(r["job_id"]) || null,
        page,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const model = (): string | undefined => config.DATA_MODEL || undefined;

/** Token budget per engine call. Generous: a model that reasons first spends part of it thinking. */
const DATA_MAX_TOKENS = 2500;

function historyBlock(history: HistoryTurn[]): string[] {
  if (history.length === 0) return [];
  return [
    "EARLIER IN THIS CONVERSATION (only to resolve words like \"it\", \"those\", \"the other one\"):",
    ...history.slice(-6).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content.slice(0, 500)}`),
    "",
  ];
}

/**
 * Answer `question` from the inspection tables, or return null when it is a
 * lookup / the engine has no trustworthy result (the caller falls back to search).
 */
export async function answerWithData(
  tenantId: string,
  question: string,
  history: HistoryTurn[] = []
): Promise<DataAnswer | null> {
  const computed = await computeTables(tenantId, question, history);
  if (!computed || computed.tables.length === 0) return null;
  const { tables, reportsTotal } = computed;

  const results = tables.map((t) => renderTable(t)).join("\n\n");
  const user = [...historyBlock(history), "RESULT", results, "", `QUESTION: ${question}`].join("\n");
  let answer = await chatComplete({ system: ANSWER_SYSTEM_PROMPT, user, maxTokens: DATA_MAX_TOKENS, numCtx: 8192, model: model() });
  let invented = inventedNumbers(answer, tables, question);
  if (invented.length > 0) {
    answer = await chatComplete({
      system: ANSWER_SYSTEM_PROMPT,
      user: [
        user,
        "",
        "YOUR DRAFT ANSWER:",
        answer,
        "",
        `These figures are not in the RESULT: ${invented.join(", ")}. Rewrite the answer using only figures that appear in the RESULT.`,
      ].join("\n"),
      maxTokens: DATA_MAX_TOKENS,
      numCtx: 8192,
      model: model(),
    });
    invented = inventedNumbers(answer, tables, question);
  }
  // Still a figure the database did not produce, or wording that says nothing
  // was found although rows were: show the result itself.
  if (invented.length > 0 || deniesResult(answer, tables)) answer = plainAnswer(tables);

  return {
    answer: answer.trim(),
    tables,
    citations: citationsFrom(tables),
    coverage: coverageOf(tables, reportsTotal),
  };
}

/**
 * Assumptions in the question that the workspace contradicts ("of our 20
 * reports" when there are 11; "since Siemens has the most reports" when it has
 * one). Checked in code, because a model answering the question it was asked
 * tends to accept what the question takes for granted. Pure.
 */
export function premiseNotes(question: string, cat: DataCatalog): string[] {
  const notes: string[] = [];
  const q = question.toLowerCase();
  const total = /\b(?:our|the|all|these|those|of)\s+(\d{1,5})\s+(?:inspection\s+)?(?:reports|inspections|lots)\b/.exec(q);
  if (total && Number(total[1]) !== cat.reports) {
    notes.push(`The question assumes ${total[1]} reports; the records hold ${cat.reports}. Say so before answering.`);
  }
  const top = [...cat.vendors].sort((a, b) => b.reports - a.reports);
  if (top.length > 1 && /\b(most|highest number of|largest number of|maximum)\b[^.?]{0,25}\b(reports|inspections|lots)\b/.test(q)) {
    const named = cat.vendors.find((v) => {
      const key = v.name.toLowerCase().split(/[^a-z0-9&]+/).find((w) => w.length >= 3);
      return key !== undefined && q.split(/[^a-z0-9&]+/).includes(key);
    });
    if (named && named.reports < top[0].reports) {
      notes.push(
        `The question assumes ${named.name} has the most reports; it has ${named.reports}, and ${top[0].name} has the most (${top[0].reports}). Say so before answering.`
      );
    }
  }
  return notes;
}

/** The workspace at a glance, so the answer can check what the question takes for granted. */
function workspaceFacts(cat: DataCatalog): string {
  return [
    `WORKSPACE FACTS: ${cat.reports} reports in all.`,
    `Reports per vendor: ${cat.vendors.map((v) => `${v.name} ${v.reports}`).join("; ")}.`,
    `Reports per type: ${cat.reportTypes.map((t) => `${t.name} ${t.reports}`).join("; ")}.`,
  ].join(" ");
}

/** What the engine worked out for a question. */
export interface Computed {
  tables: DataTable[];
  /** Corrections to what the question takes for granted. */
  notes: string[];
  reportsTotal: number;
  catalog: DataCatalog;
}

/** True when there is something to show the answer step. */
export function hasComputed(c: Computed | null): c is Computed {
  return c !== null && (c.tables.length > 0 || c.notes.length > 0);
}

/** The block the search path's answer prompt shows the model (see generate.ts COMPUTED_RULE). */
export function computedBlock(c: Computed): string {
  const lines: string[] = [];
  if (c.notes.length > 0) lines.push("CHECK THE QUESTION'S ASSUMPTIONS:", ...c.notes.map((n) => `- ${n}`), "");
  lines.push(workspaceFacts(c.catalog), "");
  if (c.tables.length > 0) {
    lines.push(
      "COMPUTED RESULTS (calculated by the database from every matching record; exact and complete):",
      ...c.tables.map((t) => renderTable(t))
    );
  }
  return lines.join("\n");
}

/** A bare count over records: the rows behind it are fetched too, so the answer can list what it counts. */
const BARE_COUNT = /^select\s+count\(\s*\*\s*\)(?:\s+as\s+\w+)?\s+from\s+(checks|inspection_items)\s+(where\b[\s\S]+)$/i;

export function rowsBehindCount(sql: string): string | null {
  const m = BARE_COUNT.exec(sql.trim().replace(/;\s*$/, ""));
  if (!m || /\bgroup\s+by\b|\bhaving\b|\blimit\b|\border\s+by\b/i.test(m[2])) return null;
  return `SELECT report_id, job_id, vendor, section, item, value, note, result, page FROM ${m[1]} ${m[2]} ORDER BY report_id, position`;
}

/** Words that ask for something counted, ranked or compared. */
const AGGREGATE_WORDS =
  /\b(how many|how much|number of|count|total|sum|add up|average|mean|rate|percent|percentage|share|ratio|most|least|worst|best|highest|lowest|compare|comparison|versus|vs|across|each|every|all|any|which|list|overall|overview|summary|summari[sz]e|trend|rank|top)\b|%/i;

/** A question about how a lot came out: cleared, rejected, free to dispatch. */
const OUTCOME_WORDS =
  /\b(clear(ed|ance)?|dispatch(ed)?|reject(ed|ion)?|accept(ed|able|ance)?|approv(ed|al)|releas(e|ed)|free to|leave the|ship(ped|ment)?|outcome|conclusion|concluded?|decision|verdict|go ahead|on hold|pass(ed)? overall|overall result)\b/i;

/**
 * The summary row of the one report an outcome question is about. A lot's
 * three conclusions can disagree; the row carries all of them and says so
 * (outcome_conflict), which a search for "cleared" alone does not.
 */
async function outcomeOf(tenantId: string, jobId: string): Promise<DataTable | null> {
  const sql =
    "SELECT report_id, job_id, vendor, outcome_summary, outcome_conflict, checks, passed, failed, conditional " +
    `FROM report_summary WHERE job_id = '${jobId.replace(/[^A-Za-z0-9_-]/g, "")}'`;
  try {
    const t = await runSql(tenantId, sql);
    return t.rows.length === 1 ? { title: "The report's own conclusion (all three fields) and tally", sql, info: true, ...t } : null;
  } catch {
    return null;
  }
}

/** A question about one named report that asks for nothing counted or compared: search answers it. */
export function isPlainLookup(question: string, jobIds: string[]): boolean {
  return jobIds.length === 1 && !AGGREGATE_WORDS.test(question);
}

/** How many reports the result rows name (null = an aggregate with no report ids). */
export function coverageOf(tables: DataTable[], reportsTotal: number): DataAnswer["coverage"] {
  const named = new Set<string>();
  let hasReportId = false;
  for (const t of tables) {
    if (!t.columns.includes("report_id")) continue;
    hasReportId = true;
    for (const r of t.rows) named.add(cell(r["report_id"]));
  }
  return { reportsTotal, reportsInResult: hasReportId ? named.size : null };
}

/**
 * Steps 1 and 2 of the engine: have the model write the queries and run them.
 * `tables` is empty when the question is a lookup or nothing trustworthy was
 * found; `notes` may still correct what the question takes for granted. Null
 * when there are no inspection records at all.
 *
 * @param jobIds reports the question was resolved to (entities.ts /
 *               details.ts); the queries are told to use them.
 */
export async function computeTables(
  tenantId: string,
  question: string,
  history: HistoryTurn[] = [],
  jobIds: string[] = []
): Promise<Computed | null> {
  const catalog = await loadDataCatalog(tenantId);
  if (catalog.reports === 0) return null; // nothing to count
  const notes = premiseNotes(question, catalog);
  const none: Computed = { tables: [], notes, reportsTotal: catalog.reports, catalog };
  // One named report, nothing counted or compared: no query to write. An
  // outcome question still gets that report's whole conclusion.
  if (isPlainLookup(question, jobIds)) {
    const outcome = OUTCOME_WORDS.test(question) ? await outcomeOf(tenantId, jobIds[0]) : null;
    return outcome ? { ...none, tables: [outcome] } : none;
  }

  const system = planSystemPrompt(catalog, new Date().toISOString().slice(0, 10));
  const ask = [
    ...historyBlock(history),
    ...(jobIds.length > 0 && jobIds.length <= 12
      ? [`REPORTS MATCHING THE DETAILS IN THE QUESTION: job_id IN (${jobIds.map((j) => `'${j.replace(/'/g, "")}'`).join(", ")})`]
      : []),
    `QUESTION: ${question}`,
  ].join("\n");
  const plan = parsePlan(await chatComplete({ system, user: ask, maxTokens: DATA_MAX_TOKENS, numCtx: 8192, model: model() }));
  if (plan.route === "lookup") return none;

  // Run each query; a refused or failing one gets ONE correction with the reason.
  const tables: DataTable[] = [];
  for (const q of plan.queries) {
    let sql = q.sql;
    let table: SqlTable | null = null;
    for (let attempt = 0; attempt < 2 && !table; attempt++) {
      try {
        table = await runSql(tenantId, sql);
      } catch (err) {
        if (!(err instanceof SqlError) || attempt === 1) break;
        const fixed = parsePlan(
          await chatComplete({
            system,
            user: [ask, "", "YOUR QUERY:", "```sql", sql, "```", "", `IT FAILED: ${err.message}`, "", "Reply with the corrected query only, in a ```sql block."].join("\n"),
            maxTokens: DATA_MAX_TOKENS,
            numCtx: 8192,
            model: model(),
          })
        );
        if (fixed.route !== "data") break;
        sql = fixed.queries[0].sql;
      }
    }
    // Found nothing: ask ONCE whether the filter matches how the data is written.
    if (table && foundNothing(table)) {
      const again = parsePlan(
        await chatComplete({
          system,
          user: [
            ask, "", "YOUR QUERY:", "```sql", sql, "```", "",
            "IT FOUND NOTHING. That usually means a filter does not match how the data is written: the wrong area or",
            "column, an item name that is not in the lists, or a spelling. Check the lists and the rules again.",
            "Reply with a corrected query in a ```sql block, or with the same query if you are sure nothing matches.",
          ].join("\n"),
          maxTokens: DATA_MAX_TOKENS,
          numCtx: 8192,
          model: model(),
        })
      );
      if (again.route === "data" && again.queries[0].sql.trim() !== sql.trim()) {
        try {
          const second = await runSql(tenantId, again.queries[0].sql);
          if (!foundNothing(second)) {
            table = second;
            sql = again.queries[0].sql;
          }
        } catch {
          // keep the first (empty) result
        }
      }
    }
    if (table) tables.push({ title: q.title, sql, ...table });
    // A bare count: fetch the records it counted, so the answer lists exactly those.
    const behind = table && !foundNothing(table) && plan.queries.length === 1 ? rowsBehindCount(sql) : null;
    if (behind) {
      try {
        const rows = await runSql(tenantId, behind);
        if (rows.rows.length > 0 && rows.rows.length <= MAX_ROWS_IN_PROMPT) {
          tables.push({ title: `${q.title} - the matching records`, sql: behind, ...rows });
        }
      } catch {
        // the count stands on its own
      }
    }
  }
  // Nothing ran, or nothing was found at all: let search try. "None" from a
  // query is not trusted on its own (it may be a lookup after all, be about an
  // uploaded document, or the filter may simply not match the data).
  if (tables.length === 0 || tables.every((t) => foundNothing(t))) return none;
  return { tables, notes, reportsTotal: catalog.reports, catalog };
}
