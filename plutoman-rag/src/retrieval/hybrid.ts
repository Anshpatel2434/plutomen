/**
 * Hybrid retrieval: dense (pgvector) + sparse (Postgres full-text), fused with
 * Reciprocal Rank Fusion (RRF) entirely in SQL.
 *
 * RRF score for a doc d: sum over each ranker r of 1 / (K + rank_r(d)), with
 * K = 60 (the standard constant). A doc that appears in only one ranker still
 * scores; a doc high in both dominates. FULL OUTER JOIN unions the two candidate
 * sets on chunk id.
 *
 * Everything runs inside withTenantRead(), so RLS transparently scopes candidates
 * to the caller's tenant. Phase-3 (defense in depth) ALSO binds an explicit
 * `tenant_id = $N` predicate into both candidate CTEs: a SECOND, independent
 * control so a hypothetical RLS misconfiguration still cannot leak across tenants.
 * The bound tenantId is the trusted value passed to hybridSearch (from the JWT).
 *
 * READ/WRITE SPLIT (Phase-2 cont.): retrieval is READ-ONLY, so it goes through
 * withTenantRead() — routed to the read replica (READ_DATABASE_URL) and marked
 * SET TRANSACTION READ ONLY. Writes (ingest, audit) stay on the primary via
 * withTenant().
 */
import { withTenantRead } from "../db";
import { embed, toVectorLiteral } from "../embeddings";
import { keywordTerms } from "./keywords";

/** Optional metadata filters, applied as additional SQL predicates. */
export interface RetrievalFilters {
  site?: string;
  vendor?: string;
  verdict?: string;
  // --- Resolved from the question by entities.ts (eval change 5) ----------
  /** Job IDs named in the question; OR-ed with poids (either identifies a report). */
  jobIds?: string[];
  /** POIDs named in the question. */
  poids?: string[];
  /** Vendors named in the question (exact stored vendor strings). */
  vendors?: string[];
  /** Report types (documents.title, e.g. "LT_Mini_Pillar") named in the question. */
  reportTypes?: string[];
}

export interface RetrievalHit {
  id: string;
  sopId: string;
  sectionPath: string | null;
  question: string | null;
  answer: string | null;
  verdict: string | null;
  site: string | null;
  vendor: string | null;
  content: string;
  score: number;
  /** Report identifiers + printed page from the PDF twin (null if ingested without one). */
  poid: string | null;
  jobId: string | null;
  page: string | null;
  citation: {
    sopId: string;
    sectionPath: string | null;
    poid: string | null;
    jobId: string | null;
    page: string | null;
  };
}

export interface HybridOptions {
  /** Candidate pool size per ranker (dense + sparse). Default 50. */
  k?: number;
  /** Final fused result count. Default 10. */
  topN?: number;
  filters?: RetrievalFilters;
}

/**
 * Run the hybrid RRF query for `queryText` within `tenantId`.
 * Returns fused, ranked chunks with citations.
 */
export async function hybridSearch(
  tenantId: string,
  queryText: string,
  opts: HybridOptions = {}
): Promise<RetrievalHit[]> {
  const k = opts.k ?? 50;
  const topN = opts.topN ?? 10;

  // Embed the query with the query task prefix.
  const [queryVec] = await embed([queryText], "query");
  const vecLiteral = toVectorLiteral(queryVec);

  // Keyword side (eval change 8): the question's words that occur in this
  // tenant's index, plus typo corrections from the tenant's own lexicon
  // ("cabel" -> "cabl"), each weighted by rarity (IDF).
  const kw = await keywordTerms(tenantId, queryText);

  // Build optional metadata predicates. These are shared by both CTEs so the
  // filter is applied consistently to dense and sparse candidate pools.
  // Params order (fixed): $1 queryVec, $2 k, $3 queryText, $4 topN, $5 tenantId,
  // then filters.
  const params: unknown[] = [vecLiteral, k, queryText, topN];

  // Redundant with RLS by design — defense in depth. Bind the trusted tenantId
  // (from the JWT) as an explicit predicate applied to BOTH candidate CTEs, so
  // even a hypothetical RLS misconfig cannot leak another tenant's chunks.
  params.push(tenantId);
  const tenantClause = `tenant_id = $${params.length}`;

  const filterClauses: string[] = [];
  const f = opts.filters ?? {};
  if (f.site) {
    params.push(f.site);
    filterClauses.push(`site = $${params.length}`);
  }
  if (f.vendor) {
    params.push(f.vendor);
    filterClauses.push(`vendor = $${params.length}`);
  }
  if (f.verdict) {
    params.push(f.verdict);
    filterClauses.push(`verdict = $${params.length}`);
  }
  // Entity filters (eval change 5). A Job ID or a POID each identifies a
  // report, so they are OR-ed; everything else is AND-ed.
  const idClauses: string[] = [];
  if (f.jobIds && f.jobIds.length > 0) {
    params.push(f.jobIds);
    idClauses.push(`job_id = ANY($${params.length}::text[])`);
  }
  if (f.poids && f.poids.length > 0) {
    params.push(f.poids);
    idClauses.push(`poid = ANY($${params.length}::text[])`);
  }
  if (idClauses.length > 0) filterClauses.push(`(${idClauses.join(" OR ")})`);
  if (f.vendors && f.vendors.length > 0) {
    params.push(f.vendors);
    filterClauses.push(`vendor = ANY($${params.length}::text[])`);
  }
  if (f.reportTypes && f.reportTypes.length > 0) {
    params.push(f.reportTypes);
    // documents is RLS-scoped too; the explicit tenant predicate is defense in depth.
    filterClauses.push(
      `document_id IN (SELECT d.id FROM documents d
                        WHERE d.tenant_id = $5 AND d.title = ANY($${params.length}::text[]))`
    );
  }
  // modality = 'text' keeps Phase-1 to text chunks (multimodal is future work).
  // tenantClause is redundant with RLS by design — defense in depth.
  const baseWhere = ["modality = 'text'", tenantClause, ...filterClauses].join(" AND ");

  params.push(kw.terms);
  const termsParam = `$${params.length}`;
  params.push(kw.idfs);
  const idfsParam = `$${params.length}`;
  params.push(kw.minScore);
  const minScoreParam = `$${params.length}`;

  // KEYWORD RANKER (eval change 8). Was plainto_tsquery = ALL words must
  // appear, so one word a chunk lacks ("pillar", "prepared") zeroed the keyword
  // match. Now each matched word adds its IDF weight, and a chunk needs at
  // least MIN_MATCH_SHARE of the question's total weight (minimum-should-match)
  // so ubiquitous words (every chunk's POID / vendor prefix) cannot make every
  // chunk a "match". Terms are lexemes already produced by Postgres' own
  // 'english' parser; quote_literal makes each a single-lexeme tsquery.
  // Tie-break: chunks containing ALL the words (the old AND query) first.
  const sql = `
    WITH terms AS (
      SELECT quote_literal(t.term)::tsquery AS tq, t.idf
      FROM unnest(${termsParam}::text[], ${idfsParam}::float8[]) AS t(term, idf)
    ),
    kwscore AS (
      SELECT chunks.id,
             sum(terms.idf) AS matched,
             ts_rank(chunks.content_tsv, plainto_tsquery('english', $3)) AS all_words
      FROM chunks
      JOIN terms ON chunks.content_tsv @@ terms.tq
      WHERE ${baseWhere}
      GROUP BY chunks.id
    ),
    vec AS (
      SELECT id,
             ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rnk
      FROM chunks
      WHERE ${baseWhere}
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    ),
    kw AS (
      SELECT id,
             ROW_NUMBER() OVER (ORDER BY matched DESC, all_words DESC, id) AS rnk
      FROM kwscore
      WHERE matched >= ${minScoreParam}::float8
      -- ORDER BY before LIMIT: without it Postgres may keep ANY k matches and
      -- drop the best-ranked ones (harmless under the old AND query's few
      -- matches, a real bug once any-word matching returns many).
      ORDER BY rnk
      LIMIT $2
    ),
    fused AS (
      SELECT COALESCE(vec.id, kw.id) AS id,
             COALESCE(1.0 / (60 + vec.rnk), 0) + COALESCE(1.0 / (60 + kw.rnk), 0) AS score
      FROM vec
      FULL OUTER JOIN kw ON vec.id = kw.id
    )
    SELECT c.id, c.sop_id, c.section_path, c.question, c.answer, c.verdict,
           c.site, c.vendor, c.content, c.poid, c.job_id, c.page, fused.score
    FROM fused
    JOIN chunks c ON c.id = fused.id
    ORDER BY fused.score DESC
    LIMIT $4
  `;

  return withTenantRead(tenantId, async (client) => {
    const res = await client.query(sql, params);
    return res.rows.map(
      (r): RetrievalHit => ({
        id: r.id,
        sopId: r.sop_id,
        sectionPath: r.section_path,
        question: r.question,
        answer: r.answer,
        verdict: r.verdict,
        site: r.site,
        vendor: r.vendor,
        content: r.content,
        score: Number(r.score),
        poid: r.poid,
        jobId: r.job_id,
        page: r.page,
        citation: {
          sopId: r.sop_id,
          sectionPath: r.section_path,
          poid: r.poid,
          jobId: r.job_id,
          page: r.page,
        },
      })
    );
  });
}

/**
 * TODO(reranker): cross-encoder / LLM reranking hook. Given the fused hits and
 * the query, return a re-ordered list. Left as an identity stub for Phase-1 —
 * wire a self-hosted reranker (e.g. bge-reranker via Ollama/text endpoint) here
 * and call it from retrievalService between hybridSearch and generate.
 */
export async function rerank(
  _query: string,
  hits: RetrievalHit[]
): Promise<RetrievalHit[]> {
  return hits; // no-op for now
}
