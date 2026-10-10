/**
 * Keyword ranker suite (golden-eval change 8).
 *
 * Pure cases pin the typo-correction rules and the rarity weighting with the
 * demo corpus' real numbers (608 chunks; "kei" is in all 70 KEI chunks). One
 * DB-connected case proves the lexicon is tenant-scoped: a typo can never be
 * "corrected" into another tenant's vocabulary.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  osaDistance,
  maxEdits,
  correctLexemes,
  buildKeywordTerms,
  idf,
  loadLexicon,
  keywordTerms,
  Lexicon,
} from "../src/retrieval/keywords";
import { withTenant, closePool } from "../src/db";
import { invalidateTenant, closeCache } from "../src/cache";

// --- edit distance ----------------------------------------------------------
test("OSA distance counts a transposition as one edit", () => {
  assert.equal(osaDistance("lenght", "length"), 1);
  assert.equal(osaDistance("cabel", "cabl"), 1);
  assert.equal(osaDistance("verfi", "verif"), 1);
  assert.equal(osaDistance("prepar", "propag"), 2);
});

test("edits allowed: none < 4 letters, 1 up to 7, 2 from 8", () => {
  assert.deepEqual([3, 4, 7, 8].map(maxEdits), [0, 1, 1, 2]);
});

// --- typo correction ----------------------------------------------------------
const COUNTS = new Map<string, number>([
  ["cabl", 179], ["length", 10], ["verif", 20], ["propag", 3], ["kei", 70], ["drum", 15],
]);

test("Q24 typos are corrected to real indexed words (golden set)", () => {
  // Lexemes of "kei cabel drum lenght verfied??"
  assert.deepEqual(correctLexemes(["kei", "cabel", "drum", "lenght", "verfi"], COUNTS), [
    "cabl", "length", "verif",
  ]);
});

test("no 'correction' that needs two edits on a short word (prepared -> propagated)", () => {
  assert.deepEqual(correctLexemes(["prepar"], COUNTS), []);
});

test("IDs, numbers and short words are never corrected", () => {
  assert.deepEqual(correctLexemes(["ph2026100001", "4500160123", "ok", "dru"], COUNTS), []);
});

// --- rarity weighting -----------------------------------------------------------
const LEX: Lexicon = {
  total: 608,
  words: [["kei", 70], ["cabl", 179], ["inspect", 76], ["temperatur", 10], ["poid", 608]],
};

test("a word in every chunk carries ~no weight; a rare word carries a lot", () => {
  assert.ok(idf(608, 608) < 0.001, "ubiquitous word ~0");
  assert.ok(idf(608, 10) > idf(608, 179), "rarer word weighs more");
});

test("words no chunk contains are left out of the required weight", () => {
  const kw = buildKeywordTerms(["ambient", "temperatur", "kei"], LEX, 0.4);
  assert.deepEqual(kw.terms, ["temperatur", "kei"], "'ambient' is not in the index");
});

test("Q28: a word on every chunk of the report cannot make a match on its own", () => {
  // "What was the ambient temperature during the KEI cable inspection?"
  const kw = buildKeywordTerms(["ambient", "temperatur", "kei", "cabl", "inspect"], LEX, 0.4);
  const weightOf = (t: string) => kw.idfs[kw.terms.indexOf(t)];
  assert.ok(weightOf("kei") < kw.minScore, "'kei' alone must not qualify a chunk");
  assert.ok(weightOf("temperatur") + weightOf("kei") >= kw.minScore, "a real topical match qualifies");
});

// --- tenant isolation (DB) -----------------------------------------------------
const T_A = "rlstest-keywords-a";
const T_B = "rlstest-keywords-b";

after(async () => {
  await withTenant(T_A, (c) => c.query(`DELETE FROM documents WHERE tenant_id = $1`, [T_A]));
  await invalidateTenant(T_A);
  await invalidateTenant(T_B);
  await closePool();
  await closeCache();
});

test("lexicon is tenant-scoped: B's typos never correct into A's words", async () => {
  await withTenant(T_A, async (c) => {
    const doc = await c.query<{ id: string }>(
      `INSERT INTO documents (tenant_id, mongo_id, title) VALUES ($1, 'kw-doc-1', 'kw probe')
       ON CONFLICT (tenant_id, mongo_id) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
      [T_A]
    );
    await c.query(
      `INSERT INTO chunks (tenant_id, sop_id, document_id, content)
       VALUES ($1, 'kw-doc-1', $2, 'zebrafinch transformer clearance')`,
      [T_A, doc.rows[0].id]
    );
  });
  await invalidateTenant(T_A);
  await invalidateTenant(T_B);

  const a = new Map((await loadLexicon(T_A)).words);
  const b = new Map((await loadLexicon(T_B)).words);
  assert.ok(a.has("zebrafinch"), "A's lexicon has A's word");
  assert.ok(!b.has("zebrafinch"), "B's lexicon must not contain A's word");

  // A one-edit typo of A's word, searched by B, must not surface it.
  const kwB = await keywordTerms(T_B, "zebrafich");
  assert.deepEqual(kwB.corrections, [], "B gets no correction into A's vocabulary");
  const kwA = await keywordTerms(T_A, "zebrafich");
  assert.deepEqual(kwA.corrections, ["zebrafinch"], "A's own typo is corrected");
});
