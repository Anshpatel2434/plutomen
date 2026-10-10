/**
 * Entity resolution for retrieval (golden-eval change 5).
 *
 * Users name the report they mean — "job PH2026100008", "POID-4523310336",
 * "the Kirloskar mini pillar", "the two Polycab inspections". Pure similarity
 * search ignores that: on the golden set, questions that named a job or POID
 * still drew 8–9 of their top-10 chunks from OTHER reports, and four of them
 * retrieved nothing from the right one. Here we turn those mentions into hard
 * SQL filters (see hybrid.ts) so retrieval stays inside the report(s) asked
 * about. This is also what separates near-duplicate reports: "ABB" + "Suresh
 * Iyer" pins one report even though three reports list that engineer.
 *
 * Resolution is DATA-DRIVEN from the tenant's own catalog (vendors, report
 * types, POIDs, Job IDs actually indexed) — nothing is hard-coded per client —
 * and the catalog is read through RLS, so a tenant can only ever resolve its
 * own entities.
 *
 * Precedence: an explicit Job ID / POID wins; vendor and report-type filters
 * apply only when no ID is named (an ID is the user's most precise intent).
 */
import { withTenantRead } from "../db";
import { getTenantDerived } from "../cache";
import { RetrievalFilters } from "./hybrid";

/** What a tenant has indexed, i.e. the vocabulary entities are resolved against. */
export interface EntityCatalog {
  vendors: string[]; // exact vendor strings as stored on chunks
  reportTypes: string[]; // documents.title, e.g. "LT_Mini_Pillar"
  poids: string[]; // "POID-4547081947"
}

/** Entities found in a piece of text (each list de-duplicated). */
export interface EntityMatch {
  jobIds: string[];
  poids: string[];
  vendors: string[];
  reportTypes: string[];
}

export interface ResolvedEntities {
  /** Filters to pass to hybridSearch (only the fields that apply). */
  filters: RetrievalFilters;
  /** The same, as reported back to the caller for transparency/debugging. */
  applied: Partial<EntityMatch>;
}

/** Words that do not identify a vendor on their own. */
const GENERIC_VENDOR_WORDS = new Set([
  "india", "ltd", "limited", "company", "co", "electric", "electrical", "electricals",
  "industries", "cables", "cable", "pvt", "private", "the", "and", "corporation", "corp",
  "inc", "group", "smart", "infrastructure", "automation", "systems", "solutions",
  "products", "engineering", "works", "international", "global",
]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive matcher; "&" tolerates spaces ("l & t"). */
function wordRegex(key: string, optionalPlural = false): RegExp {
  const body = escapeRe(key).replace(/\s*&\s*/g, "\\s*&\\s*").replace(/\s+/g, "[\\s_]+");
  return new RegExp(`(^|[^a-z0-9])${body}${optionalPlural ? "s?" : ""}(?=$|[^a-z0-9])`, "i");
}

/**
 * Identifying keys for a vendor name:
 *   "KEI Industries Ltd."                              -> ["kei"]
 *   "Larsen & Toubro Ltd. (Electrical & Automation)"   -> ["larsen", "l&t"]
 *   "Siemens Ltd. – Smart Infrastructure"              -> ["siemens"]
 * Qualifiers after "(" or a spaced dash are not part of the name.
 */
export function vendorKeys(vendor: string): string[] {
  const base = vendor.split(/\(|\s[–—-]\s/)[0];
  const words = base.toLowerCase().replace(/[.,]/g, " ").split(/\s+/).filter(Boolean);
  const keys = new Set<string>();
  const significant = words.filter((w) => w !== "&" && w.length >= 3 && !GENERIC_VENDOR_WORDS.has(w));
  if (significant[0]) keys.add(significant[0]);
  const amp = /([A-Za-z]+)\s*&\s*([A-Za-z]+)/.exec(base);
  if (amp) keys.add(`${amp[1][0]}&${amp[2][0]}`.toLowerCase());
  return [...keys];
}

/**
 * Keys for a report type (checklist title):
 *   "LT_Mini_Pillar"  -> ["lt_mini_pillar", "lt mini pillar", "mini pillar", "pillar"]
 *   "LT_Power_Cables" -> [..., "power cable", "cable"]   (plural matched optionally)
 */
export function reportTypeKeys(title: string): string[] {
  const words = title.toLowerCase().split(/[_\s]+/).filter(Boolean).map((w) => w.replace(/s$/, ""));
  const keys = new Set<string>([words.join(" ")]);
  // Drop a short category prefix such as "LT" for the natural-language forms.
  const body = words.length > 1 && words[0].length <= 3 ? words.slice(1) : words;
  keys.add(body.join(" "));
  keys.add(body[body.length - 1]);
  return [...keys];
}

/** Pure matcher: find catalog entities mentioned in `text`. */
export function matchEntities(text: string, catalog: EntityCatalog): EntityMatch {
  const t = text.replace(/[‐-―−]/g, "-");

  // Job IDs: two letters + ten digits ("PH2026100008"), any case. Accepted even
  // if unknown — an explicit ID that is not indexed should yield "not found",
  // never another job's data.
  const jobIds = [...t.matchAll(/(?:^|[^a-z0-9])([a-z]{2}\d{10})(?=$|[^a-z0-9])/gi)].map((m) =>
    m[1].toUpperCase()
  );

  // POIDs: "POID-4547081947" / "POID 4547081947", or a bare number that is a
  // known POID of this tenant (other 10-digit numbers, e.g. PO numbers, are not).
  const poids = [...t.matchAll(/\bpoid[-\s]?(\d{10})\b/gi)].map((m) => `POID-${m[1]}`);
  for (const p of catalog.poids) {
    const digits = p.replace(/^POID-/, "");
    if (new RegExp(`(^|[^0-9])${digits}(?=$|[^0-9])`).test(t)) poids.push(p);
  }

  const vendors = catalog.vendors.filter((v) => vendorKeys(v).some((k) => wordRegex(k).test(t)));
  const reportTypes = catalog.reportTypes.filter((rt) =>
    reportTypeKeys(rt).some((k) => wordRegex(k, true).test(t))
  );

  return {
    jobIds: [...new Set(jobIds)],
    poids: [...new Set(poids)],
    vendors: [...new Set(vendors)],
    reportTypes: [...new Set(reportTypes)],
  };
}

/** Turn matched entities into retrieval filters, applying the precedence rules. */
export function toFilters(m: EntityMatch): ResolvedEntities {
  if (m.jobIds.length > 0 || m.poids.length > 0) {
    const applied: Partial<EntityMatch> = {};
    if (m.jobIds.length) applied.jobIds = m.jobIds;
    if (m.poids.length) applied.poids = m.poids;
    return { filters: { ...applied }, applied };
  }
  const applied: Partial<EntityMatch> = {};
  if (m.vendors.length) applied.vendors = m.vendors;
  // Several report types mentioned ("cable entry on the mini pillar") is not a
  // narrowing signal — only filter when exactly one type is named.
  if (m.reportTypes.length === 1) applied.reportTypes = m.reportTypes;
  return { filters: { ...applied }, applied };
}

/** Load (and cache per tenant) what this tenant has indexed. Read path + RLS. */
export async function loadCatalog(tenantId: string): Promise<EntityCatalog> {
  return getTenantDerived(tenantId, "entity-catalog", 300, () =>
    withTenantRead(tenantId, async (client) => {
      // Explicit tenant predicates are redundant with RLS by design (defense in depth).
      const vendors = await client.query<{ vendor: string }>(
        `SELECT DISTINCT vendor FROM chunks WHERE tenant_id = $1 AND vendor IS NOT NULL`,
        [tenantId]
      );
      const docs = await client.query<{ title: string | null; poid: string | null }>(
        `SELECT DISTINCT title, poid FROM documents WHERE tenant_id = $1`,
        [tenantId]
      );
      return {
        vendors: vendors.rows.map((r) => r.vendor),
        reportTypes: [...new Set(docs.rows.map((r) => r.title).filter((x): x is string => !!x))],
        poids: [...new Set(docs.rows.map((r) => r.poid).filter((x): x is string => !!x))],
      };
    })
  );
}

/** Resolve entities in a single query (the /search path). */
export async function resolveEntities(tenantId: string, text: string): Promise<ResolvedEntities> {
  return toFilters(matchEntities(text, await loadCatalog(tenantId)));
}

/**
 * Words that point AWAY from an entity named earlier ("the OTHER Finolex job").
 * When the user's message contains one, entities in the history-aware rewrite
 * may name the report to EXCLUDE, so we must not filter on them.
 */
const CONTRASTIVE = /\b(other|another|else|different|besides|except|excluding|apart from)\b/i;

/**
 * Resolve entities for a chat turn. Entities in the user's own message always
 * count. Entities that only appear in the history-aware rewrite (e.g. "and
 * what drum length was verified in it?" -> "...in POID-4504515691") are added
 * too — unless the message is contrastive, where the rewrite's ID is likely
 * the one to exclude.
 */
export async function resolveChatEntities(
  tenantId: string,
  message: string,
  rewritten: string
): Promise<ResolvedEntities> {
  return toFilters(matchChatEntities(message, rewritten, await loadCatalog(tenantId)));
}

/** Pure core of resolveChatEntities (unit-testable without a database). */
export function matchChatEntities(
  message: string,
  rewritten: string,
  catalog: EntityCatalog
): EntityMatch {
  const own = matchEntities(message, catalog);
  if (CONTRASTIVE.test(message) || rewritten === message) return own;
  const fromRewrite = matchEntities(rewritten, catalog);
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  return {
    jobIds: union(own.jobIds, fromRewrite.jobIds),
    poids: union(own.poids, fromRewrite.poids),
    vendors: union(own.vendors, fromRewrite.vendors),
    reportTypes: union(own.reportTypes, fromRewrite.reportTypes),
  };
}
