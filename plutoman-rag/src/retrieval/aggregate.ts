/**
 * Aggregation and complete-section retrieval (golden-eval change 4).
 *
 * Similarity search returns the top 10 chunks. That is the wrong tool when a
 * question needs EVERY item of something: "how many of the 15 Acceptance
 * Tests did not pass" (Q13), "which acceptance tests did not pass" (Q21),
 * "was any item marked Not Ok" (Q22), "compare the Technical Clearance across
 * all six reports" (Q09), "which inspections recorded an Oxygen Index fail"
 * (Q15). A top-10 sample silently drops items, and the model then counts the
 * sample, so the answer is wrong even though every value it quotes is right.
 *
 * Here the question is matched against the tenant's own vocabulary (section
 * names and item titles actually indexed, read through RLS: nothing is
 * hard-coded per client). When it asks for a list, a count, a comparison, the
 * failures, or a lot's dispatch decision, ALL matching items inside the
 * reports it names are fetched with plain SQL (no ranking, no cut-off), and
 * exact counts are computed from the normalised verdicts. Those items become
 * sources (so they are cited like any other), and the counts go to the model
 * as a "complete list" it can rely on instead of counting itself.
 *
 * Scope is always the reports resolved by entities.ts (job / POID / vendor /
 * report type). Without a named report, only an explicit "across all /
 * compare / every" question expands, and only for a specific item title.
 */
import { withTenantRead } from "../db";
import { getTenantDerived } from "../cache";
import { RetrievalFilters, RetrievalHit, filterSql } from "./hybrid";
import { AggregateFact } from "./facts";

export { AggregateFact, renderFacts } from "./facts";

/** The vocabulary questions are matched against. */
export interface AggregateCatalog {
  /** Item titles (chunks.question) of checklist, basic-details and conclusion rows. */
  titles: string[];
  /** Section names: checklist sub-sections ("Acceptance Tests") and top-level ones. */
  sections: string[];
}

/** What to fetch completely for a question. */
export interface AggregationPlan {
  /** Item titles to fetch across the scoped reports (exact catalog strings). */
  titles: string[];
  /** Sections to fetch completely (exact catalog strings). */
  sections: string[];
  /** The question asks about items that did NOT pass (fail / not ok / rejected). */
  nonPass: boolean;
  /** The question asks about items marked "Not Attached". */
  notAttached: boolean;
  /** The question asks for a list / count / comparison. */
  list: boolean;
  /** The question explicitly spans reports ("across all", "compare", "every"). */
  across: boolean;
  /** The question asks for the lot's decision (dispatch / green light / rejected). */
  decision: boolean;
}

export interface AggregationResult {
  hits: RetrievalHit[];
  facts: AggregateFact[];
}

// --- text matching (pure) ---------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "of", "in", "on", "at", "for", "to", "by", "with", "and", "or", "as",
  "is", "are", "was", "were", "be", "been", "what", "which", "who", "how", "many", "much",
  "did", "does", "do", "any", "its", "it", "this", "that", "these", "those", "there", "per",
]);

/** Lower-case word tokens with stop words dropped and a light plural strip. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‐-―−]/g, " ")
    .replace(/[^a-z0-9&]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "&" && !STOPWORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Index of `needle` as a contiguous run inside `hay`, or -1. */
function indexOfRun(hay: string[], needle: string[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** A phrase that names more titles than this is too generic to act on ("outer sheath"). */
const MAX_TITLES_PER_PHRASE = 3;

/** Section key: the name before a qualifier ("Acceptance Tests as per QAP/IS" -> "acceptance test"). */
function sectionTokens(section: string): string[] {
  return tokens(section.split(/\s+as per\s+|\s*\(/i)[0]);
}

const RE_NON_PASS =
  /\b(not\s*ok|not\s+pass(ed)?|did\s*n[o']t\s+pass|didnt\s+pass|fail(ed|s|ure|ures)?|rejected|non[-\s]?conform\w*|not\s+meet\w*)\b/i;
const RE_NOT_ATTACHED = /\bnot\s+attached\b/i;
const RE_LIST =
  /\b(how\s+many|which|list|count|number\s+of|compare|comparison|across|every|each|any\s+(item|items|test|tests|check|checks))\b/i;
const RE_ACROSS = /\b(across|compare|comparison|every|each|both|all\s+(the\s+)?(\w+\s+){0,3}(reports|inspections|lots|jobs))\b/i;
const RE_DECISION = /\b(dispatch\w*|ship|shipped|shipping|green\s+light|cleared|rejected|rejection)\b/i;

/**
 * Decide what (if anything) to fetch completely. Pure: matching the question
 * against the catalog only; the database is not touched.
 *
 * Titles and sections are matched as whole phrases. Longer spans win and spans
 * do not overlap, so "Oxygen Index test result" picks the Oxygen Index title
 * and not also the "Test Results" conclusion row.
 */
export function planAggregation(query: string, catalog: AggregateCatalog): AggregationPlan | null {
  const q = tokens(query);
  const used = new Array<boolean>(q.length).fill(false);
  const free = (at: number, len: number) => used.slice(at, at + len).every((u) => !u);
  const take = (at: number, len: number) => used.fill(true, at, at + len);

  // Sections first: "Acceptance Tests" is a section, not an item title.
  const sections: string[] = [];
  const sectionKeys = catalog.sections
    .map((s) => ({ s, t: sectionTokens(s) }))
    .filter((x) => x.t.length > 0)
    .sort((a, b) => b.t.length - a.t.length);
  // One key can name several sections (cables "Acceptance Tests", pillars
  // "Acceptance Tests as per QAP/IS"); the scoped reports decide which applies.
  const claimed: { at: number; key: string }[] = [];
  for (const { s, t } of sectionKeys) {
    const at = indexOfRun(q, t);
    if (at < 0) continue;
    const key = t.join(" ");
    if (free(at, t.length) || claimed.some((c) => c.at === at && c.key === key)) {
      sections.push(s);
      take(at, t.length);
      claimed.push({ at, key });
    }
  }

  // Titles: a full title in the question, or a 2+ word phrase of the question
  // that occurs inside at most MAX_TITLES_PER_PHRASE titles.
  const titleToks = catalog.titles.map((t) => ({ t, k: tokens(t) })).filter((x) => x.k.length > 0);
  const candidates: { at: number; len: number; titles: string[] }[] = [];
  for (let len = Math.min(5, q.length); len >= 1; len--) {
    for (let at = 0; at + len <= q.length; at++) {
      const phrase = q.slice(at, at + len);
      const compact = phrase.join("");
      const full = titleToks.filter((x) => x.k.join(" ") === phrase.join(" ") || x.k.join("") === compact);
      const inside = len >= 2 ? titleToks.filter((x) => indexOfRun(x.k, phrase) >= 0) : [];
      const hit = full.length > 0 ? full : inside;
      if (hit.length > 0 && hit.length <= MAX_TITLES_PER_PHRASE) {
        candidates.push({ at, len, titles: hit.map((x) => x.t) });
      }
    }
  }
  candidates.sort((a, b) => b.len - a.len || a.titles.length - b.titles.length);
  const titles: string[] = [];
  for (const c of candidates) {
    if (!free(c.at, c.len)) continue;
    take(c.at, c.len);
    for (const t of c.titles) if (!titles.includes(t)) titles.push(t);
  }

  const plan: AggregationPlan = {
    titles,
    sections,
    nonPass: RE_NON_PASS.test(query),
    notAttached: RE_NOT_ATTACHED.test(query),
    list: RE_LIST.test(query),
    across: RE_ACROSS.test(query),
    decision: RE_DECISION.test(query),
  };
  const actionable =
    plan.titles.length > 0 ||
    (plan.sections.length > 0 && (plan.list || plan.nonPass)) ||
    plan.nonPass ||
    plan.notAttached ||
    plan.decision;
  return actionable ? plan : null;
}

// --- verdict classes ----------------------------------------------------------

type VerdictClass = "passed" | "failed" | "conditional" | "noResult";

function verdictClass(v: string | null): VerdictClass {
  if (v === "OK") return "passed";
  if (v === "NOT OK") return "failed";
  if (v === "CONDITIONAL") return "conditional";
  return "noResult";
}

const CLASS_WORD: Record<VerdictClass, string> = {
  passed: "passed",
  failed: "failed",
  conditional: "not passed (conditional / pending)",
  noResult: "no result word",
};

function countsOf(rows: { verdict: string | null }[]): AggregateFact["counts"] {
  const c = { total: rows.length, passed: 0, failed: 0, conditional: 0, noResult: 0 };
  for (const r of rows) c[verdictClass(r.verdict)]++;
  return c;
}

const notPassed = (r: { verdict: string | null; answer: string | null }, notAttached: boolean) =>
  r.verdict === "NOT OK" ||
  r.verdict === "CONDITIONAL" ||
  (notAttached && /^\s*not\s+attached/i.test(r.answer ?? ""));

// --- database -------------------------------------------------------------------

/** Load (and cache per tenant) the section/title vocabulary. Read path + RLS. */
export async function loadAggregateCatalog(tenantId: string): Promise<AggregateCatalog> {
  return getTenantDerived(tenantId, "aggregate-catalog", 300, () =>
    withTenantRead(tenantId, async (client) => {
      // Explicit tenant predicates are redundant with RLS by design (defense in depth).
      const t = await client.query<{ question: string }>(
        `SELECT DISTINCT question FROM chunks
          WHERE tenant_id = $1 AND question IS NOT NULL AND question <> ''
            AND (section_path LIKE 'Characteristics > %'
                 OR section_path LIKE 'Basic Details > %'
                 OR section_path LIKE 'Inspection Conclusion > %')`,
        [tenantId]
      );
      const s = await client.query<{ section: string }>(
        `SELECT DISTINCT CASE WHEN section_path LIKE 'Characteristics > %'
                              THEN split_part(section_path, ' > ', 2)
                              ELSE split_part(section_path, ' > ', 1) END AS section
           FROM chunks
          WHERE tenant_id = $1
            AND (section_path LIKE 'Characteristics > %'
                 OR section_path LIKE 'Inspection Conclusion%'
                 OR section_path LIKE 'Inspection Observations%'
                 OR section_path LIKE 'Basic Details%')`,
        [tenantId]
      );
      return {
        titles: t.rows.map((r) => r.question),
        sections: s.rows.map((r) => r.section).filter(Boolean),
      };
    })
  );
}

interface Row {
  id: string;
  sop_id: string;
  section_path: string | null;
  question: string | null;
  answer: string | null;
  verdict: string | null;
  site: string | null;
  vendor: string | null;
  content: string;
  poid: string | null;
  job_id: string | null;
  page: string | null;
  document_id: string;
}

function toHit(r: Row): RetrievalHit {
  return {
    id: r.id,
    sopId: r.sop_id,
    sectionPath: r.section_path,
    question: r.question,
    answer: r.answer,
    verdict: r.verdict,
    site: r.site,
    vendor: r.vendor,
    content: r.content,
    score: 0,
    poid: r.poid,
    jobId: r.job_id,
    page: r.page,
    citation: { sopId: r.sop_id, sectionPath: r.section_path, poid: r.poid, jobId: r.job_id, page: r.page },
  };
}

/**
 * The recorded value as indexed, i.e. with its measurement and note: the
 * chunk text after "<title>: " ("Not Ok - Lot not meeting QAP acceptance
 * criteria."). Falls back to the bare answer.
 */
function valueText(r: Row): string {
  const head = r.question ? `${r.question}: ` : null;
  const at = head ? r.content.indexOf(head) : -1;
  return at >= 0 ? r.content.slice(at + head!.length).trim() : (r.answer ?? "");
}

/**
 * Content words and word pairs of the question, for "which report do its
 * details name". Function words are excluded: "for the" occurs in some
 * reports' free text and would "name" them (seen on Q26).
 */
function questionPhrases(query: string): string[] {
  const words = query.toLowerCase().replace(/[?!,;:()"']/g, " ").split(/\s+/).filter(Boolean);
  const content = (w: string) => !STOPWORDS.has(w) && (w.length >= 3 || /\d/.test(w));
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    if (content(words[i]) && words[i].length >= 4) out.add(words[i]);
    if (i + 1 < words.length && content(words[i]) && content(words[i + 1])) out.add(`${words[i]} ${words[i + 1]}`);
  }
  return [...out];
}

const containsPhrase = (text: string, phrase: string) =>
  new RegExp(`(^|[^a-z0-9])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9])`).test(text);

/**
 * The reports (by document id) the question's own details point to among
 * `docIds`: a phrase of the question that occurs in some of those reports but
 * not all of them ("suresh iyer", "5 drums", "fx/arm/260630/21"). The reports
 * matching the most such phrases win; none if no phrase discriminates.
 */
export function singledOutReports(query: string, docText: Map<string, string>): string[] {
  const docs = [...docText.keys()];
  if (docs.length < 2) return [];
  const score = new Map(docs.map((d) => [d, 0]));
  for (const ph of questionPhrases(query)) {
    const hit = docs.filter((d) => containsPhrase(docText.get(d)!, ph));
    if (hit.length > 0 && hit.length < docs.length) for (const d of hit) score.set(d, score.get(d)! + 1);
  }
  const best = Math.max(...score.values());
  if (best === 0) return [];
  const top = docs.filter((d) => score.get(d) === best);
  return top.length < docs.length ? top : [];
}

const reportName = (r: Row) =>
  `Report ${r.poid ?? r.sop_id}${r.job_id ? ` (Job ${r.job_id}${r.vendor ? `, ${r.vendor}` : ""})` : ""}`;

/** Sources given to the model from one question's complete lists, at most. */
export const MAX_AGGREGATE_HITS = 20;
/** Reports a question may name for report-wide / decision expansion. */
const MAX_NARROW_REPORTS = 2;
/** Up to this many reports, check which one the question's details name. */
const MAX_PICK_REPORTS = 4;

/** True when entities.ts narrowed the question to particular reports. */
function isScoped(f: RetrievalFilters): boolean {
  return !!(f.jobIds?.length || f.poids?.length || f.vendors?.length || f.reportTypes?.length);
}

/**
 * Fetch the complete lists a plan asks for, inside the reports `filters`
 * select. Returns the listed items as hits plus one fact per list.
 */
export async function expandAggregation(
  tenantId: string,
  plan: AggregationPlan,
  filters: RetrievalFilters,
  query = ""
): Promise<AggregationResult> {
  const scoped = isScoped(filters);
  if (!scoped && !(plan.across && plan.titles.length > 0)) return { hits: [], facts: [] };

  return withTenantRead(tenantId, async (client) => {
    /** Chunks of the scoped reports matching `extra` (which binds its own values). */
    const select = async (extra: (bind: (v: unknown) => string) => string): Promise<Row[]> => {
      const params: unknown[] = [tenantId];
      const where = ["tenant_id = $1", "modality = 'text'", ...filterSql(filters, params, "$1")];
      const bind = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const extraSql = extra(bind);
      const sql = `SELECT id, sop_id, section_path, question, answer, verdict, site, vendor,
                          content, poid, job_id, page, document_id
                     FROM chunks
                    WHERE ${where.join(" AND ")} AND ${extraSql}
                    ORDER BY poid NULLS LAST, sop_id, page NULLS LAST, section_path`;
      return (await client.query<Row>(sql, params)).rows;
    };
    const facts: AggregateFact[] = [];
    const hits: RetrievalHit[] = [];
    /** Record a list; its items become sources while the source budget lasts. */
    const add = (fact: AggregateFact, rows: Row[]) => {
      for (const r of rows) {
        if (hits.length >= MAX_AGGREGATE_HITS) break;
        if (!hits.some((h) => h.id === r.id)) hits.push(toHit(r));
      }
      // Never list an item that is not among the sources (it could not be cited).
      const items = fact.items.filter((it) => hits.some((h) => h.id === it.hitId));
      if (items.length > 0) facts.push({ ...fact, items });
    };

    // 1) Item titles: that item in every scoped report ("compare the Weight of
    //    Cable", "Technical Clearance across all six", "Oxygen Index fail").
    if (plan.titles.length > 0) {
      const rows = await select((bind) => `question = ANY(${bind(plan.titles)}::text[])`);
      for (const title of plan.titles) {
        const own = rows.filter((r) => r.question === title);
        if (own.length === 0) continue;
        const listed = plan.nonPass && own.length > 2 ? own.filter((r) => notPassed(r, plan.notAttached)) : own;
        const shown = (listed.length > 0 ? listed : own).slice(0, MAX_AGGREGATE_HITS);
        const docIds = [...new Set(own.map((r) => r.document_id))];
        const reports = docIds.length;

        // Several reports: do their values differ, and do the question's own
        // details name one of them? (CLARIFY vs "answer for that report".)
        let pick: AggregateFact["pick"];
        if (reports >= 2 && reports <= MAX_PICK_REPORTS && !plan.across) {
          const texts = await select(
            (bind) => `document_id = ANY(${bind(docIds)}::uuid[])`
          );
          const docText = new Map(docIds.map((d) => [d, ""]));
          for (const r of texts) docText.set(r.document_id, `${docText.get(r.document_id)} ${r.content.toLowerCase()}`);
          const singled = singledOutReports(query, docText);
          pick = {
            valuesDiffer: new Set(own.map((r) => (r.answer ?? "").trim().toLowerCase())).size > 1,
            singledOut: shown.filter((r) => singled.includes(r.document_id)).map((r) => r.id),
          };
        }

        // One or two reports: observations in them that mention this item, so a
        // contradicting note is not missed (Q35: "Not Ok" vs "bolt hole pitch
        // matches").
        let related: Row[] = [];
        const keyWords = tokens(title).filter((w) => w.length >= 5);
        if (reports <= MAX_NARROW_REPORTS && keyWords.length > 0) {
          related = await select(
            (bind) =>
              `section_path LIKE 'Inspection Observations%' AND document_id = ANY(${bind(docIds)}::uuid[])
               AND lower(content) ~ ${bind(keyWords.map((w) => `\\m${w}`).join("|"))}`
          );
        }

        add(
          {
            heading: `"${title}" in ${reports} report${reports === 1 ? "" : "s"}`,
            counts: countsOf(own),
            nonPassOnly: shown.length < own.length,
            items: [
              ...shown.map((r) => ({
                hitId: r.id,
                label: `${reportName(r)}: ${valueText(r)} (${CLASS_WORD[verdictClass(r.verdict)]})`,
              })),
              ...related.map((r) => ({ hitId: r.id, label: valueText(r) || r.content, related: true })),
            ],
            pick,
          },
          [...shown, ...related]
        );
      }
    }

    // Report-wide expansions below need a question about one or two reports.
    const docs = scoped
      ? new Set((await select(() => "true")).map((r) => r.document_id)).size
      : Infinity;
    const narrow = docs <= MAX_NARROW_REPORTS;

    // 2) Whole sections ("how many of the Acceptance Tests did not pass").
    if (scoped && plan.sections.length > 0 && (plan.list || plan.nonPass)) {
      for (const section of plan.sections) {
        const pattern =
          section === "Inspection Conclusion" || section === "Inspection Observations" || section === "Basic Details"
            ? `${section}%`
            : `Characteristics > ${section} >%`;
        const rows = await select((bind) => `section_path LIKE ${bind(pattern)}`);
        const byDoc = new Map<string, Row[]>();
        for (const r of rows) byDoc.set(r.document_id, [...(byDoc.get(r.document_id) ?? []), r]);
        for (const own of byDoc.values()) {
          const listed = plan.nonPass ? own.filter((r) => notPassed(r, plan.notAttached)) : own;
          const shown = listed.slice(0, MAX_AGGREGATE_HITS);
          add(
            {
              heading: `${section} in ${reportName(own[0])}`,
              counts: countsOf(own),
              nonPassOnly: plan.nonPass,
              items: shown.map((r) => ({
                hitId: r.id,
                label: `${r.question ?? r.section_path}: ${valueText(r)} (${CLASS_WORD[verdictClass(r.verdict)]})`,
              })),
            },
            shown
          );
        }
      }
    }

    // 3) Everything that did not pass in the named report(s) ("was any item
    //    marked Not Ok or Not Attached?"), when no section narrows it. Not for
    //    decision questions ("why was the lot rejected?"): a list of failed
    //    items would lend weight to a premise the conclusion may contradict
    //    (Q31) — those get the conclusion itself (step 4).
    if (
      narrow &&
      !plan.decision &&
      plan.sections.length === 0 &&
      plan.titles.length === 0 &&
      (plan.nonPass || plan.notAttached)
    ) {
      const rows = await select(
        () => `(section_path LIKE 'Characteristics > %' OR section_path LIKE 'Inspection Conclusion%')`
      );
      const byDoc = new Map<string, Row[]>();
      for (const r of rows) byDoc.set(r.document_id, [...(byDoc.get(r.document_id) ?? []), r]);
      for (const own of byDoc.values()) {
        const shown = own.filter((r) => notPassed(r, plan.notAttached)).slice(0, MAX_AGGREGATE_HITS);
        add(
          {
            heading: `every checked item in ${reportName(own[0])}`,
            counts: countsOf(own),
            nonPassOnly: true,
            items: shown.map((r) => ({
              hitId: r.id,
              label: `${r.section_path}: ${valueText(r)} (${CLASS_WORD[verdictClass(r.verdict)]})`,
            })),
          },
          shown
        );
      }
    }

    // 4) The lot's decision ("cleared for dispatch?", "green light to ship?",
    //    "why was it rejected?"): the report's whole Inspection Conclusion.
    if (narrow && plan.decision) {
      const rows = await select(() => `section_path LIKE 'Inspection Conclusion%'`);
      const byDoc = new Map<string, Row[]>();
      for (const r of rows) byDoc.set(r.document_id, [...(byDoc.get(r.document_id) ?? []), r]);
      for (const own of byDoc.values()) {
        add(
          {
            heading: `Inspection Conclusion (the lot's decision) in ${reportName(own[0])}`,
            counts: countsOf(own),
            nonPassOnly: false,
            items: own.map((r) => ({
              hitId: r.id,
              label: `${r.question}: ${valueText(r)} (${CLASS_WORD[verdictClass(r.verdict)]})`,
            })),
          },
          own
        );
      }
    }

    return { hits, facts };
  });
}

/** Plan + expand for one question (the retrieval path). */
export async function aggregateFor(
  tenantId: string,
  query: string,
  filters: RetrievalFilters
): Promise<AggregationResult & { plan: AggregationPlan | null }> {
  const plan = planAggregation(query, await loadAggregateCatalog(tenantId));
  if (!plan) return { plan: null, hits: [], facts: [] };
  return { plan, ...(await expandAggregation(tenantId, plan, filters, query)) };
}
