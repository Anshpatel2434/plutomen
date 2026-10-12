/**
 * The retrieval pipeline shared by /search and /chat:
 *   hybrid search (top N) + complete lists for list / count / compare /
 *   failure / decision questions (aggregate.ts, golden-eval change 4).
 *
 * Complete-list items come first (they are what such questions are about),
 * then the ranked hits, de-duplicated and capped at MAX_SOURCES so the
 * generation prompt stays inside the model's context window.
 */
import { hybridSearch, rerank, RetrievalFilters, RetrievalHit } from "./hybrid";
import { aggregateFor, AggregateFact, AggregationPlan } from "./aggregate";
import { oneCopyOfTemplates } from "./templates";

/** Sources handed to generation, at most (~70 tokens each). */
export const MAX_SOURCES = 24;

export interface Retrieved {
  hits: RetrievalHit[];
  /** Complete lists the hits include (empty for ordinary questions). */
  facts: AggregateFact[];
  plan: AggregationPlan | null;
}

export async function retrieve(
  tenantId: string,
  query: string,
  opts: { topN: number; filters: RetrievalFilters }
): Promise<Retrieved> {
  const [ranked, agg] = await Promise.all([
    hybridSearch(tenantId, query, { topN: opts.topN, filters: opts.filters }).then((h) => rerank(query, h)),
    aggregateFor(tenantId, query, opts.filters),
  ]);
  const hits = [...agg.hits];
  for (const h of ranked) {
    if (hits.length >= Math.max(MAX_SOURCES, agg.hits.length)) break;
    if (!hits.some((x) => x.id === h.id)) hits.push(h);
  }
  return { hits: oneCopyOfTemplates(hits), facts: agg.facts, plan: agg.plan };
}
