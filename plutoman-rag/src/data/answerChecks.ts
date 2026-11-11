/**
 * Does an answer say what the computed tables say?
 *
 * The data engine's tables are exact, but the model words the answer, and a
 * small model drops rows of a list ("3 reports" when the table has 4), counts
 * the handful of passages it was shown instead of the table ("4" when the
 * count is 25), or lists every item without ever stating the total it was
 * asked for. These checks are deterministic: they compare the answer text with
 * the rows. A draft with problems gets one retry with the problems spelled out
 * (generate.ts); whatever is still wrong afterwards is repaired in code from
 * the rows themselves, so the figures and lists the user reads always come
 * from the database.
 *
 * Pure: no LLM, no database.
 */
import { SqlTable } from "./runSql";
import { quotesValue } from "../retrieval/verify";

export interface CheckTable extends SqlTable {
  title: string;
}

const text = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).replace(/\s+/g, " ").trim();
};

/** Letters and digits only, lower case: tolerant comparison of names. */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** Is the whole number `n` stated in `answer` (as digits, or as a word up to twelve)? */
export function statesNumber(answer: string, n: number | string): boolean {
  const s = String(n).replace(/\.0+$/, "");
  const plain = answer.replace(/(\d),(?=\d{3}\b)/g, "$1");
  if (new RegExp(`(?<![\\d.])${s.replace(".", "\\.")}(?:\\.0+)?(?![\\d])`).test(plain)) return true;
  const i = Number(s);
  return Number.isInteger(i) && i >= 0 && i < WORDS.length && new RegExp(`\\b${WORDS[i]}\\b`, "i").test(answer);
}

/** Columns that identify the report a row belongs to. */
const ID_COLUMNS = ["job_id", "report_id"] as const;

const isNumeric = (v: unknown): boolean =>
  typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim()));

/** A table whose rows are records (reports or items), as opposed to totals. */
export function isRecordList(t: SqlTable): boolean {
  return ID_COLUMNS.some((c) => t.columns.includes(c));
}

/** Largest list that must appear in full in the answer (longer ones are summarised and shown as a table). */
export const MAX_LISTED = 25;

/** Does the answer mention this row? */
function mentions(answerSquashed: string, answer: string, r: Record<string, unknown>, needId: boolean, needItem: boolean): boolean {
  if (needId) {
    const ids = ID_COLUMNS.map((c) => text(r[c])).filter(Boolean);
    const named = ids.some((id) => answer.includes(id) || answer.includes(id.replace(/^POID-/, "")));
    if (ids.length > 0 && !named) return false;
  }
  if (needItem) {
    const item = squash(text(r["item"]));
    // The first part of a long item name is enough ("Eco-friendly Waste Segregation, Collection and ...").
    if (item && !answerSquashed.includes(item.slice(0, 28))) return false;
  }
  return true;
}

/** Rows of a record list that the answer does not mention. */
export function missingRows(answer: string, t: SqlTable): Record<string, unknown>[] {
  if (!isRecordList(t) || t.rows.length === 0 || t.rows.length > MAX_LISTED) return [];
  const reports = new Set(t.rows.map((r) => ID_COLUMNS.map((c) => text(r[c])).join("|")));
  const items = new Set(t.rows.map((r) => squash(text(r["item"]))));
  // Rows are told apart by report when there are several reports, and by item
  // when there are several items. One report with one item: nothing to tell
  // apart (the answer may name it by vendor), so nothing is checked.
  const needId = reports.size > 1;
  const needItem = t.columns.includes("item") && items.size > 1;
  if (!needId && !needItem) return [];
  const sq = squash(answer);
  return t.rows.filter((r) => !mentions(sq, answer, r, needId, needItem));
}

/** Records whose recorded value or note the answer leaves out (small lists only). */
export function unquotedRows(answer: string, t: SqlTable): Record<string, unknown>[] {
  if (!isRecordList(t) || t.rows.length === 0 || t.rows.length > 10) return [];
  return t.rows.filter((r) =>
    ["value", "note"].some((c) => {
      const v = t.columns.includes(c) ? text(r[c]) : "";
      return v !== "" && v.length <= 90 && !quotesValue(answer, v);
    })
  );
}

/** The question asks for a count or a total. */
export const ASKS_COUNT = /\bhow many\b|\bnumber of\b|\bcount\b|\btotal\b|\badd up\b|\bsum\b|\bhow much\b|\bin all\b|\baltogether\b/i;

/** The answer without list numbering ("11. Earthing" is the eleventh line, not a count of eleven). */
export function withoutNumbering(answer: string): string {
  return answer.replace(/^[ \t>*-]*\(?\d{1,3}[.)](?=\s)/gm, "");
}

/** Whole numbers in a piece of text. */
const numbersOf = (s: string): number[] => [...s.matchAll(/(?<![\w.])\d{1,6}(?![\w.]*\d)/g)].map((m) => Number(m[0]));

/**
 * Counts the answer claims: "12 checks marked Not Ok", "3 reports", "Total: 4",
 * "4 in total". (Numbers before a unit, a page or a percent are not counts.)
 */
function statedTotals(answer: string): number[] {
  const out: number[] = [];
  for (const m of answer.matchAll(
    /(?<![\w.])(\d{1,4})\**\s+(?:[A-Za-z&/'-]+\s+){0,4}?\**(checks?|items?|reports?|records?|tests?|lots?|entries|failures?|observations?|deviations?|non-conformances?|parameters?)\b/gi
  )) {
    out.push(Number(m[1]));
  }
  for (const m of answer.matchAll(/\btotal\b[^.\n\d]{0,40}?(\d{1,6})(?![\d.]*\s*(?:%|percent|mm|mtr|m\b|kv|nos))|(\d{1,6})\s+in\s+total\b/gi)) {
    out.push(Number(m[1] ?? m[2]));
  }
  return out;
}

/** Numeric cells of a totals table that the answer must state. */
function figures(t: SqlTable): string[] {
  const out: string[] = [];
  for (const r of t.rows) for (const c of t.columns) if (isNumeric(r[c])) out.push(text(r[c]));
  return out;
}

export interface TableProblems {
  /** Instructions for the model's one retry. */
  problems: string[];
  /** True when the answer states a total that contradicts the rows. */
  contradicts: boolean;
}

function rowLine(t: SqlTable, r: Record<string, unknown>): string {
  return t.columns
    .filter((c) => text(r[c]) !== "")
    .map((c) => `${c}: ${text(r[c])}`)
    .join(" | ");
}

/** What is wrong with `answer`, given the tables computed for `question`. */
export function tableProblems(question: string, rawAnswer: string, tables: CheckTable[]): TableProblems {
  const answer = withoutNumbering(rawAnswer);
  const problems: string[] = [];
  let contradicts = false;
  const asksCount = ASKS_COUNT.test(question);

  for (const t of tables) {
    if (isRecordList(t)) {
      const n = t.rows.length;
      if (n === 0 || n > MAX_LISTED) continue;
      const unquoted = unquotedRows(answer, t);
      if (unquoted.length > 0) {
        problems.push(
          `Give what the report recorded for these records of the COMPUTED RESULTS, value and note, exactly as written: ` +
            unquoted.slice(0, 4).map((r) => rowLine(t, r)).join(" ;; ")
        );
      }
      const missing = missingRows(answer, t);
      if (missing.length > 0) {
        problems.push(
          `The COMPUTED RESULTS "${t.title}" hold ${n} record${n === 1 ? "" : "s"} and your answer leaves out ${missing.length}: ` +
            missing.slice(0, 6).map((r) => rowLine(t, r)).join(" ;; ") +
            ". Include every record of the COMPUTED RESULTS."
        );
      }
      // A total of quantities (given by a totals table) is not a count of records.
      const computedFigures = new Set(tables.filter((x) => !isRecordList(x)).flatMap(figures).map((f) => Number(f)));
      // A figure the question itself gives ("of the 15 Acceptance Tests") is not a claim.
      const given = new Set(numbersOf(question));
      const wrong = statedTotals(answer).filter((x) => x !== n && !computedFigures.has(x) && !given.has(x));
      // The row count is the answer to "how many" only when no totals table gives it.
      const onlyLists = tables.every(isRecordList);
      if (asksCount && tables.filter(isRecordList).length === 1 && (onlyLists || computedFigures.has(n))) {
        if (wrong.length > 0) {
          contradicts = true;
          problems.push(
            `Your answer gives a total of ${wrong[0]}, but the COMPUTED RESULTS hold ${n} matching records. ` +
              "The SOURCES are only a sample: take the count and the list from the COMPUTED RESULTS."
          );
        } else if (onlyLists && !statesNumber(answer, n)) {
          problems.push(`The question asks for a count: state the total, ${n}, as given by the COMPUTED RESULTS.`);
        }
      }
    } else if (t.rows.length > 0 && t.rows.length <= 8) {
      const absent = [...new Set(figures(t))].filter((f) => !statesNumber(answer, f));
      if (absent.length > 0) {
        problems.push(
          `Your answer does not give these figures of the COMPUTED RESULTS "${t.title}": ${absent.slice(0, 6).join(", ")}. ` +
            "State them exactly as computed."
        );
      }
    }
  }
  return { problems: problems.slice(0, 4), contradicts };
}

/** "[POID-4593151822.pdf p.5]" for a row, when it names a report. */
function cite(r: Record<string, unknown>): string {
  const id = text(r["report_id"]);
  if (!id) return "";
  const page = text(r["page"]);
  return id.startsWith("POID-") ? ` [${id}.pdf${page ? ` p.${page}` : ""}]` : ` [${id}]`;
}

/** Columns that are identity, position or a classification of the recorded wording: not read out. */
const QUIET = new Set([
  "report_id", "job_id", "vendor", "page", "position", "report_type", "site", "inspection_date", "item", "section",
  "result", "marked", "area",
]);

/** "Job PH2026100002 (Siemens Ltd.)" for a row. */
function reportOf(r: Record<string, unknown>): string {
  const job = text(r["job_id"]);
  const id = text(r["report_id"]);
  const vendor = text(r["vendor"]);
  return [job ? `Job ${job}` : id ? `Report ${id}` : "", vendor ? `(${vendor})` : ""].filter(Boolean).join(" ");
}

/**
 * One record as a line: "Job PH… (ABB India Limited) – Visual & Physical
 * Checks > Earthing: Not Ok – note [POID-….pdf p.3]". The report is left out
 * when `withReport` is false (every line of the list is the same report).
 */
export function recordLine(t: SqlTable, r: Record<string, unknown>, withReport = true): string {
  const item = [text(r["section"]), text(r["item"])].filter(Boolean).join(" > ");
  const rest = t.columns
    .filter((c) => !QUIET.has(c) && text(r[c]) !== "")
    .map((c) => (c === "value" || c === "note" ? text(r[c]) : `${c.replace(/_/g, " ")}: ${text(r[c])}`));
  const body = [item, rest.join(" – ")].filter(Boolean).join(": ");
  return `- ${[withReport ? reportOf(r) : "", body].filter(Boolean).join(" – ")}${cite(r)}`;
}

function renderList(t: CheckTable): string {
  const n = t.rows.length;
  const reports = new Set(t.rows.map(reportOf));
  const one = reports.size === 1 && n > 1 ? [...reports][0] : "";
  const head = `${t.title}: ${n} record${n === 1 ? "" : "s"}${one ? `, all in ${one}` : ""}.`;
  return [head, ...t.rows.map((r) => recordLine(t, r, !one))].join("\n");
}

function renderTotals(t: CheckTable): string {
  return [
    `${t.title}:`,
    ...t.rows.map((r) => `- ${t.columns.filter((c) => text(r[c]) !== "").map((c) => `${c.replace(/_/g, " ")}: ${text(r[c])}`).join("; ")}`),
  ].join("\n");
}

/**
 * Make the final answer agree with the tables. Called after the model's retry.
 *   - a stated total that contradicts the rows: the model's text is dropped and
 *     the records are listed by code;
 *   - rows left out / the count not stated / computed figures not given: the
 *     complete list or the figures are appended.
 * Returns the answer unchanged when nothing is wrong.
 */
export function repairFromTables(question: string, answer: string, tables: CheckTable[]): string {
  const { problems, contradicts } = tableProblems(question, answer, tables);
  if (problems.length === 0) return answer;
  const lists = tables.filter((t) => isRecordList(t) && t.rows.length > 0 && t.rows.length <= MAX_LISTED);
  const totals = tables.filter((t) => !isRecordList(t) && t.rows.length > 0 && t.rows.length <= 8);

  if (contradicts) {
    return [...lists.map(renderList), ...totals.map(renderTotals)].join("\n\n");
  }

  const add: string[] = [];
  const asksCount = ASKS_COUNT.test(question);
  for (const t of lists) {
    const n = t.rows.length;
    if (missingRows(answer, t).length > 0 || unquotedRows(answer, t).length > 0) add.push(`Complete list from the records — ${renderList(t)}`);
    else if (asksCount && lists.length === 1 && totals.length === 0 && tables.every(isRecordList) && !statesNumber(withoutNumbering(answer), n)) add.push(`Total: ${n}.`);
  }
  for (const t of totals) {
    if ([...new Set(figures(t))].some((f) => !statesNumber(answer, f))) add.push(`From the records — ${renderTotals(t)}`);
  }
  return add.length > 0 ? `${answer.trim()}\n\n${add.join("\n\n")}` : answer;
}
