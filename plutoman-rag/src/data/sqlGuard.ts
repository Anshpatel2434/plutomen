/**
 * Validation of model-written SQL. Pure: no database.
 *
 * The data engine lets the model write the query, which is what makes it
 * answer questions nobody listed in advance. That only works if a wrong or
 * hostile query can do no harm. Three independent layers:
 *
 *   1. THIS FILE — the text must be ONE read-only SELECT over the two
 *      inspection tables, using only known functions.
 *   2. The transaction is READ ONLY and runs as `plutoman_analyst`, a role
 *      that can SELECT those two tables and nothing else (runSql.ts).
 *   3. Row-level security scopes every row to the caller's tenant.
 *
 * Layer 1 is deliberately strict rather than clever: anything it does not
 * recognise is refused and the model is asked again with the reason.
 */

/** Tables the model may read. */
export const ALLOWED_TABLES = [
  "inspection_reports",
  "inspection_items",
  "inspection_amounts",
  // Standard measures (db/migrations/010_measures.sql).
  "checks",
  "report_summary",
  "section_summary",
] as const;

/** Rows returned to the model and the caller, at most. */
export const MAX_ROWS = 200;

/** Words that can precede "(" — SQL syntax and the functions a report needs. */
const CALLABLE = new Set([
  // syntax
  "select", "from", "where", "and", "or", "not", "in", "on", "as", "by", "over", "filter", "exists", "any",
  "all", "when", "then", "else", "having", "union", "except", "intersect", "values", "using", "between",
  "like", "ilike", "join", "is", "distinct", "case", "end", "with", "limit", "offset", "partition",
  // aggregates and windows
  "count", "sum", "avg", "min", "max", "string_agg", "array_agg", "bool_and", "bool_or", "row_number", "rank",
  "dense_rank", "percentile_cont", "percentile_disc", "lag", "lead", "first_value", "last_value", "ntile",
  // scalars
  "round", "abs", "ceil", "floor", "coalesce", "nullif", "greatest", "least", "lower", "upper", "length",
  "trim", "btrim", "ltrim", "rtrim", "substring", "substr", "position", "strpos", "replace", "concat",
  "concat_ws", "left", "right", "split_part", "initcap", "regexp_replace", "regexp_match", "cast", "to_char",
  "to_date", "date_trunc", "date_part", "extract", "age", "now", "numeric", "decimal", "varchar", "char",
  "array_length", "cardinality", "unnest", "mode", "within", "group", "order",
]);

/** Words that must not appear anywhere outside a string literal. */
const FORBIDDEN =
  /\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy|call|do|execute|prepare|deallocate|set|reset|show|into|lock|listen|notify|vacuum|analyze|explain|begin|commit|rollback|savepoint|refresh|reindex|cluster|comment|security|role|current_setting|set_config|current_user|session_user|current_role|current_database|current_schema|version|dblink|lateral|tablesample|information_schema)\b|\bpg_\w*|\blo_\w*/i;

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

/** Remove string literals so their contents are never read as SQL. */
function withoutStrings(sql: string): string | null {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] !== "'") {
      out += sql[i];
      continue;
    }
    // Skip to the closing quote ('' is an escaped quote).
    let j = i + 1;
    for (; j < sql.length; j++) {
      if (sql[j] === "'") {
        if (sql[j + 1] === "'") j++;
        else break;
      }
    }
    if (j >= sql.length) return null; // unterminated literal
    out += "''";
    i = j;
  }
  return out;
}

/**
 * Check one model-written statement. On success `sql` is the statement to run,
 * wrapped so it can return at most MAX_ROWS rows.
 */
export function guardSql(raw: string): GuardResult {
  const sql = raw.trim().replace(/;\s*$/, "").trim();
  if (!sql) return { ok: false, reason: "The query is empty." };
  if (sql.length > 4000) return { ok: false, reason: "The query is too long." };
  if (/--|\/\*|\*\//.test(sql)) return { ok: false, reason: "Comments are not allowed in the query." };
  if (sql.includes("$")) return { ok: false, reason: "The character $ is not allowed in the query." };
  if (sql.includes("\\")) return { ok: false, reason: "Backslashes are not allowed in the query." };

  const bare = withoutStrings(sql);
  if (bare === null) return { ok: false, reason: "A quoted string is not closed." };
  if (bare.includes(";")) return { ok: false, reason: "Write exactly one statement (no semicolons)." };

  // Double quotes only as a column alias: AS "Pass rate".
  const text = bare.replace(/\bas\s+"[^"]*"/gi, "AS alias_").replace(/\s+/g, " ");
  if (text.includes('"')) {
    return { ok: false, reason: 'Do not put table or column names in double quotes (only AS "an alias").' };
  }
  if (!/^(select|with)\b/i.test(text)) return { ok: false, reason: "The query must start with SELECT or WITH." };

  const bad = FORBIDDEN.exec(text);
  if (bad) return { ok: false, reason: `"${bad[0]}" is not allowed; write a read-only SELECT.` };

  // "FROM" that does not introduce a table: EXTRACT(year FROM d), SUBSTRING(x
  // FROM 2), TRIM(BOTH FROM x), IS DISTINCT FROM.
  const tables = text
    .replace(/\b(extract|substring|trim)\s*\(([^()]*?)\bfrom\b/gi, "$1($2 of")
    .replace(/\bdistinct\s+from\b/gi, "distinct_of");

  // Every table read must be an inspection table or a CTE defined in the query.
  const ctes = new Set([...text.matchAll(/(?:\bwith|,)\s*([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase()));
  for (const m of tables.matchAll(/\b(?:from|join)\s+(\(|[a-z_][a-z0-9_.]*)/gi)) {
    const t = m[1].toLowerCase();
    if (t === "(") continue; // a subquery: its own FROM is checked by this loop
    if (!(ALLOWED_TABLES as readonly string[]).includes(t) && !ctes.has(t)) {
      return { ok: false, reason: `Table "${m[1]}" does not exist. Use only: ${ALLOWED_TABLES.join(", ")}.` };
    }
  }
  // "FROM a, b" would hide b from the check above.
  if (/\bfrom\s+[a-z_][a-z0-9_]*(?:\s+(?:as\s+)?[a-z_][a-z0-9_]*)?\s*,/i.test(tables)) {
    return { ok: false, reason: "Use JOIN ... ON instead of a comma between tables." };
  }
  if (!/\bfrom\b/i.test(text)) return { ok: false, reason: "The query must read from an inspection table." };

  // Only known functions.
  for (const m of text.matchAll(/\b([a-z_][a-z0-9_]*)\s*\(/gi)) {
    const f = m[1].toLowerCase();
    if (!CALLABLE.has(f) && !ctes.has(f)) return { ok: false, reason: `Function "${m[1]}" is not available.` };
  }

  return { ok: true, sql: `SELECT * FROM (${sql}) AS answer LIMIT ${MAX_ROWS}` };
}
