/**
 * Keyword-side helpers for hybrid retrieval (golden-eval change 8).
 *
 * Typo tolerance: workers type fast ("kei cabel drum lenght verfied??"). A
 * misspelled word matches nothing in full-text search, so we correct each
 * unknown query word to the closest word that ACTUALLY OCCURS in this
 * tenant's indexed reports and add it to the keyword query (the original word
 * stays too). Corrections come only from the tenant's own lexicon, read
 * through RLS — a correction can never surface another tenant's vocabulary.
 *
 * Words are compared as Postgres 'english' lexemes (stemmed), the same form
 * the index stores: "cable" is indexed as "cabl", so "cabel" -> "cabl" is one
 * edit; "lenght" -> "length" is one transposition.
 *
 * Scoring: every query word counts (any-word matching, not all-words), weighted
 * by rarity (IDF), and a chunk must carry at least MIN_MATCH_SHARE of the
 * question's weight to count as a keyword hit — see keywordTerms().
 */
import { query, withTenantRead } from "../db";
import { getTenantDerived } from "../cache";
import { config } from "../config";

/** Optimal-string-alignment distance (Levenshtein + adjacent transposition). */
export function osaDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * Edits allowed for a lexeme of this length: none below 4 letters, 1 up to 7,
 * 2 from 8. Two edits on a short word is mostly noise: "prepar" (prepared)
 * would otherwise be "corrected" to "propag" (propagated). Real typos seen in
 * the golden set are one edit: cabel->cabl, lenght->length, verfi->verif.
 */
export function maxEdits(length: number): number {
  if (length < 4) return 0;
  return length <= 7 ? 1 : 2;
}

/**
 * Pure core: for every query lexeme that is NOT in the lexicon, find the
 * closest lexicon word (same first letter, within maxEdits; ties broken by how
 * many chunks contain it). Words with digits (IDs, measurements) and short
 * words are never "corrected".
 */
export function correctLexemes(queryLexemes: string[], lexicon: Map<string, number>): string[] {
  const out = new Set<string>();
  for (const q of queryLexemes) {
    if (lexicon.has(q) || /\d/.test(q)) continue;
    const limit = maxEdits(q.length);
    if (limit === 0) continue;
    let best: string | null = null;
    let bestDist = Infinity;
    let bestDocs = -1;
    for (const [w, ndoc] of lexicon) {
      if (w[0] !== q[0] || Math.abs(w.length - q.length) > limit) continue;
      const dist = osaDistance(q, w);
      if (dist > limit) continue;
      if (dist < bestDist || (dist === bestDist && ndoc > bestDocs)) {
        best = w;
        bestDist = dist;
        bestDocs = ndoc;
      }
    }
    // Only plain word lexemes go into the tsquery (keeps the SQL quoting trivial).
    if (best && /^[\p{L}-]+$/u.test(best)) out.add(best);
  }
  return [...out];
}

/** This tenant's search lexicon: chunk count + [lexeme, chunks containing it]. */
export interface Lexicon {
  total: number;
  words: [string, number][];
}

export async function loadLexicon(tenantId: string): Promise<Lexicon> {
  // "-v2": versioned so a cached value from an older format is never misread.
  return getTenantDerived(tenantId, "search-lexicon-v2", 300, () =>
    withTenantRead(tenantId, async (client) => {
      // ts_stat runs the inner query as the current role inside this
      // transaction, so RLS applies; the explicit tenant predicate (quoted by
      // format %L, never string-concatenated) is defense in depth.
      const res = await client.query<{ word: string; ndoc: number }>(
        `SELECT word, ndoc
           FROM ts_stat(format('SELECT content_tsv FROM chunks WHERE tenant_id = %L', $1::text))`,
        [tenantId]
      );
      const total = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM chunks WHERE tenant_id = $1`,
        [tenantId]
      );
      return {
        total: total.rows[0]?.n ?? 0,
        words: res.rows.map((r): [string, number] => [r.word, Number(r.ndoc)]),
      };
    })
  );
}

/**
 * Share of a question's (IDF-weighted) matchable words a chunk must contain to
 * count as a keyword match. Plain any-word OR matching let ubiquitous words
 * through: every chunk of a report carries its POID / vendor / site in the
 * text, so for "ambient temperature during the KEI cable inspection" all 70
 * KEI chunks matched on "kei" alone and drowned the semantic ranker's answer.
 * Weighting by rarity and requiring a share of the weight (a classic
 * minimum-should-match) keeps keyword hits informative.
 *
 * Configurable as KW_MIN_MATCH_SHARE (default 0.4). Tuned on the 34 scorable
 * golden-set questions, where 0.4 was best both with and without entity
 * filters — by ONE question over 0.5, so re-validate on a larger labelled set.
 */
export const MIN_MATCH_SHARE = config.KW_MIN_MATCH_SHARE;

/** BM25 inverse document frequency: rare words weigh more, ubiquitous ~0. */
export function idf(total: number, ndoc: number): number {
  return Math.log(1 + (total - ndoc + 0.5) / (ndoc + 0.5));
}

export interface KeywordTerms {
  /** Query lexemes (+ typo corrections) that occur in this tenant's index. */
  terms: string[];
  /** IDF weight per term (same order). */
  idfs: number[];
  /** Minimum summed IDF a chunk needs to count as a keyword match. */
  minScore: number;
  /** Corrections that were added (for logging/debugging). */
  corrections: string[];
}

/** Pure core of keywordTerms (unit-testable without a database). */
export function buildKeywordTerms(
  queryLexemes: string[],
  lexicon: Lexicon,
  share: number = MIN_MATCH_SHARE
): KeywordTerms {
  const counts = new Map(lexicon.words);
  const corrections = correctLexemes(queryLexemes, counts);
  const terms: string[] = [];
  const idfs: number[] = [];
  for (const t of new Set([...queryLexemes, ...corrections])) {
    const n = counts.get(t) ?? 0;
    // A word no chunk contains (an uncorrectable typo, or "ambient" when no
    // report records it) can never match — leave it out of the required
    // weight instead of making every chunk fail the threshold.
    if (n === 0 || t.includes("\\")) continue;
    terms.push(t);
    idfs.push(idf(lexicon.total, n));
  }
  const mass = idfs.reduce((a, b) => a + b, 0);
  return { terms, idfs, minScore: share * mass, corrections };
}

/** Keyword terms, weights and match threshold for `queryText` in this tenant. */
export async function keywordTerms(tenantId: string, queryText: string): Promise<KeywordTerms> {
  // Lexemes of the query, produced by the same 'english' config as the index.
  // No tenant data is touched here.
  const lex = await query<{ lex: string }>(
    `SELECT unnest(tsvector_to_array(to_tsvector('english', $1))) AS lex`,
    [queryText]
  );
  const queryLexemes = lex.rows.map((r) => r.lex);
  if (queryLexemes.length === 0) return { terms: [], idfs: [], minScore: 0, corrections: [] };
  return buildKeywordTerms(queryLexemes, await loadLexicon(tenantId));
}
