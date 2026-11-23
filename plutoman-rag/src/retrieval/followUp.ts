/**
 * Is this turn's message a question in its own right, or does it lean on the
 * turns before it?
 *
 * Everything a chat turn does with history — rewriting the question for search
 * (condense.ts), letting the data engine see the earlier turns (data/), passing
 * them to the answer step — exists to resolve a follow-up like "and what about
 * the cables?". Applied to a question that stands on its own, the same
 * machinery narrows it: "how many different vendors are covered?" asked after a
 * turn about one report was rewritten into "vendors covered in reports other
 * than 4562922674", and the engine scoped its count to that one report. The
 * answer then covered 2 vendors instead of 7 — which is why testers found they
 * had to start a new chat for every question.
 *
 * So: when the message stands on its own, the turn runs as if it were the first
 * one. The test below is deliberately lopsided. Saying "this needs history"
 * when it does not is the status quo and costs nothing new; saying "this stands
 * alone" when it does not would lose the report the user is asking about. Every
 * rule therefore errs towards keeping history.
 */

/** Things a question can be about, for the phrases that point at one. */
const THING = "report|lot|job|one|vendor|supplier|site|inspection|document|file|case|check|item|point|section|test|number|id";

/** Plurals that mean the whole set rather than something named earlier. */
const CORPUS_PLURAL = "reports|lots|jobs|records|documents|files|inspections";

/**
 * Phrases that can only be read against an earlier turn:
 *  - an opening connective ("and for Polycab?", "what about the cables?");
 *  - "also" / "again" / "likewise" anywhere;
 *  - "the same|other|previous|above" and "another";
 *  - a demonstrative pointing at one thing ("this report", "those checks") —
 *    but NOT "these reports", which is how people say "everything you hold";
 *  - "of them / of those".
 */
const REFERRING = new RegExp(
  [
    `^\\s*(and|also|what about|how about|ok|okay|now|then|same)\\b`,
    `\\b(also|again|likewise)\\b`,
    `\\bthe (same|other|previous|above|latter|former)\\b`,
    `\\banother\\b`,
    `\\b(this|that)\\s+(${THING})\\b`,
    `\\b(these|those)\\s+(?!(${CORPUS_PLURAL})\\b)(${THING})s?\\b`,
    `\\bof (them|those|these)\\b`,
  ].join("|"),
  "i"
);

/**
 * Bare pronouns. On their own they usually point backwards ("was it cleared?"),
 * but a question that states its own subject may still use one within the
 * sentence ("how many lots ... and whose are they?"), so they only decide a
 * message that names nothing else.
 */
const PRONOUN = /\b(it|its|they|them|their|theirs|he|him|his|she|her|hers)\b/i;

/**
 * Nouns for the records themselves. A question that names one is asking across
 * the corpus ("how many different vendors are covered?"), not about whichever
 * report happened to come up earlier.
 */
const CORPUS_NOUN =
  /\b(reports?|lots?|jobs?|inspections?|vendors?|suppliers?|sites?|documents?|files?|records?|engineers?|inspectors?|purchase orders?|pos?|checklists?)\b/i;

/** Quantifiers that scope a question to everything held, with no entity named. */
const GLOBAL = /\b(all|every|each|overall|across|in total|altogether|anywhere|anyone|anybody)\b/i;

/**
 * True when `message` can be answered without the earlier turns.
 *
 * @param namesOwnEntity whether the message itself names a report, job, POID,
 *        vendor or report type (resolved against the tenant's catalogue).
 */
export function isSelfContained(message: string, namesOwnEntity: boolean): boolean {
  if (REFERRING.test(message)) return false;
  // Does the question say what it is about at all? If not, it is elliptical
  // ("which points are not compliant?") and only history can say.
  const statesItsSubject = namesOwnEntity || CORPUS_NOUN.test(message) || GLOBAL.test(message);
  if (!statesItsSubject) return false;
  // It does — so a pronoun in it is being used within the sentence, unless the
  // sentence names nothing concrete for the pronoun to pick up.
  if (PRONOUN.test(message) && !namesOwnEntity && !CORPUS_NOUN.test(message)) return false;
  return true;
}
