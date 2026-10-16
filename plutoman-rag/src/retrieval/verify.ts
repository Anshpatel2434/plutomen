/**
 * Answer verification (golden-eval change 9).
 *
 * A small model drops parts of a recorded value ("Pass" instead of "OI 31.5% –
 * Pass"), answers "yes" while a condition sits in the next source ("subject to
 * rectification"), says "not recorded" about an item it was given, or cites
 * nothing. Re-writing every answer with a second "checker" prompt risks
 * damaging the good ones, so instead the draft is checked DETERMINISTICALLY
 * against its own sources here, and only a draft with concrete problems gets
 * one retry, with those problems spelled out (see generate.ts).
 *
 * Pure: no LLM, no database.
 */
import { RetrievalHit } from "./hybrid";
import { AggregateFact, renderFacts } from "./facts";
import { marker } from "./citations";

/** A draft that says the reports do not hold the answer (or refuses). */
const NOT_RECORDED =
  /\b(do(es)?\s+not\s+(record|provide|mention|contain|include|state|define|specify|show|describe|indicate)|not\s+(recorded|provided|mentioned|included|stated|defined|specified|available|described)|no\s+(information|record|mention|details?)|cannot|can't|unable to)\b/i;

/** A draft that asks the user which report is meant (CLARIFY). */
const CLARIFY = /\b(which (report|one|inspection|job|lot)\b[^.]*\?|please (specify|clarify)|could you (clarify|specify))/i;

export function isAbstention(answer: string): boolean {
  return NOT_RECORDED.test(answer);
}

export function isClarification(answer: string): boolean {
  return CLARIFY.test(answer);
}

/** "What does X mean / stand for", "how is X different from Y", "define X". */
const DEFINITION_Q = /\bwhat\s+(does|do|is)\b[^?]*\b(mean|means|stand for|stands for)\b|\bdefin(e|ition)\b|\bhow\s+is\b[^?]*\bdifferent\b/i;
/** An answer explaining a meaning. */
const EXPLAINS = /\b(means|meaning|indicates?|refers? to|signif(y|ies|icant)|denotes?|stands? for|represents?|is used to (denote|indicate))\b/i;
/** A source that itself gives a definition. */
const DEFINES = /\b(means|defined as|stands for|definition)\b/i;

/** A sentence saying the term is NOT defined (kept: that is the right answer). */
const NOT_DEFINED =
  /\b(do(es)?\s+not\s+(define|explain|expand|specify)|not\s+(defined|explained|expanded)|no\s+definition|(is|are)\s+not\s+compared|not\s+possible\s+to\s+determine)\b/i;
/** Guessing at a meaning from general knowledge rather than the sources. */
const SPECULATES =
  /\b(appears?\s+to\s+(be|mean|stand|refer)|likely|probably|usually|typically|generally|commonly|presumably|(may|might|could)\s+(be|mean|stand|refer|indicate))\b/i;

/**
 * Deterministic backstop for rule 4 (golden Q33, Q34). The answer check above
 * catches a draft that explains a term no source defines and asks for one
 * retry, but a small model can repeat the explanation in the retry. Here the
 * explaining sentences are removed from the final answer instead: a sentence
 * that says the term is not defined is kept, as is one that quotes how the
 * term is used; a sentence that explains or guesses a meaning is dropped.
 * Applies only to a definition question whose sources define nothing.
 */
export function dropUndefinedExplanations(query: string, answer: string, sources: RetrievalHit[]): string {
  if (!DEFINITION_Q.test(query) || sources.some((h) => DEFINES.test(h.content))) return answer;
  const sentences = answer.split(/(?<=[.!?])\s+(?=[A-Z("'\[])/);
  const kept = sentences.filter((s) => NOT_DEFINED.test(s) || !(EXPLAINS.test(s) || SPECULATES.test(s)));
  if (kept.length === sentences.length) return answer;
  if (kept.length === 0) return "The reports do not define this term.";
  // Whatever survives (quoted usage) must still say the term is undefined.
  if (!kept.some((s) => NOT_DEFINED.test(s))) kept.unshift("The reports do not define this term.");
  // The first kept sentence may have followed a dropped one ("However, ...").
  kept[0] = kept[0].replace(/^(However|But|Also|Therefore),\s+(\w)/, (_m, _w: string, c: string) => c.toUpperCase());
  return kept.join(" ");
}

/** Words that carry no value of their own in a recorded answer. */
const RESULT_WORDS = new Set([
  "ok", "not", "pass", "passed", "fail", "failed", "yes", "no", "the", "and", "of", "a", "an",
  "as", "per", "is", "in", "on", "at", "to", "for", "with", "attached",
]);

const norm = (s: string) =>
  s.toLowerCase().replace(/[‐-―−]/g, "-").replace(/\s+/g, " ");

/** Numbers as written ("31.5", "500", "0.118"); markers are removed first. */
function numbersIn(text: string): string[] {
  return [...text.replace(/\[[^\]]*\]/g, " ").matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w])/g)].map((m) => m[0]);
}

/** Whole-word phrase test ("not ok" in "was not ok", not in "cannot okay"). */
const containsWords = (hay: string, phrase: string) =>
  new RegExp(`(^|[^a-z])${phrase.replace(/ /g, "\\s+")}(?=$|[^a-z])`).test(hay);

const hasNumber = (hay: string, n: string) => new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?![\\d])`).test(hay);

/** Content words of a recorded value (what "quote it exactly" must keep). */
function valueWords(value: string): string[] {
  return norm(value)
    .replace(/[^a-z0-9 ]/g, " ")
    .split(" ")
    .filter((w) => w.length > 2 && !RESULT_WORDS.has(w));
}

export interface VerifyInput {
  query: string;
  draft: string;
  /** Sources in marker order (S1 = ordered[0]). */
  ordered: RetrievalHit[];
  /** 0-based indices of the sources the draft cites. */
  cited: number[];
  facts: AggregateFact[];
}

/** Values longer than this are descriptions, not values to quote. */
const MAX_QUOTABLE = 90;
/** Problems reported back to the model, at most. */
const MAX_PROBLEMS = 5;

/**
 * Concrete problems with a draft, phrased as instructions the model can act
 * on (each names the source marker). Empty = the draft is accepted as is.
 */
export function findProblems(v: VerifyInput): string[] {
  const problems: string[] = [];
  // Asking which report is meant is a valid outcome (rule 8): nothing to check.
  if (isClarification(v.draft)) return problems;
  // 0) Definition questions (rule 4, Q33/Q34): no explaining a term the
  //    SOURCES do not define — checked first, since such a draft often also
  //    says "not defined" and would otherwise pass as an abstention.
  if (DEFINITION_Q.test(v.query) && EXPLAINS.test(v.draft)) {
    const defined = v.ordered.some((h) => DEFINES.test(h.content));
    if (!defined) {
      problems.push(
        "The SOURCES do not define this term, so do not explain what it means (no general knowledge). " +
          "Say that the reports do not define it; you may quote how it is used, with markers."
      );
    }
  }

  // A draft that cites sources is an answer, even if it adds "the reports do
  // not record X" about something else (Q07) — so it gets every check below.
  const abstains = isAbstention(v.draft) && v.cited.length === 0;
  const markerOf = new Map(v.ordered.map((h, i) => [h.id, marker(i)]));
  const citedIds = new Set(v.cited.map((i) => v.ordered[i]?.id));
  const draft = norm(v.draft);

  // 1) Over-abstaining: the draft says "not recorded" although a complete list
  //    holds exactly the items the question names (Q16, Q21).
  if (abstains) {
    const listed = v.facts.flatMap((f) => f.items).filter((it) => markerOf.has(it.hitId));
    if (listed.length > 0) {
      const sample = listed.slice(0, 3).map((it) => `[${markerOf.get(it.hitId)}] ${it.label}`);
      problems.push(
        `You said the reports do not record this, but the COMPLETE LISTS contain matching items: ${sample.join("; ")}. ` +
          "Answer from them if they answer the question; only if they truly do not, keep saying it is not recorded."
      );
    }
    return problems.slice(0, MAX_PROBLEMS);
  }

  // 2) An answer must cite its sources.
  if (v.cited.length === 0) {
    problems.push("Your answer cites no source. Add the marker of the source for every fact, for example [S1].");
  }

  // 3) Recorded values must be quoted, not summarised to a result word.
  for (const i of v.cited) {
    const h = v.ordered[i];
    const value = (h?.answer ?? "").trim();
    if (!h || !value || value.length > MAX_QUOTABLE) continue;
    const nums = numbersIn(value);
    // Up to 4 figures (a value, a date, a range): all of them; more: at least one.
    const missingNumber =
      nums.length > 0 &&
      (nums.length <= 4 ? !nums.every((n) => hasNumber(draft, n)) : !nums.some((n) => hasNumber(draft, n)));
    const words = valueWords(value);
    const kept = words.filter((w) => draft.includes(w)).length;
    const missingWords = nums.length === 0 && words.length > 0 && kept / words.length < 0.5;
    // A bare result ("Not Ok", "Yes", "Pass") must appear as written, not as
    // "one item did not pass" (Q23).
    const bare = norm(value).replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
    const missingResult =
      nums.length === 0 && words.length === 0 && bare.split(" ").length <= 3 && !containsWords(draft, bare);
    if (missingNumber || missingWords || missingResult) {
      problems.push(`For [${marker(i)}] quote the recorded value exactly as written: "${value}".`);
    }
  }

  // 4) No figure may appear that is in no source, not in the complete lists'
  //    counts and not in the question.
  const sourcesText = norm(
    [...v.ordered.map((h) => h.content), ...renderFacts(v.facts, v.ordered)].join(" \n ")
  );
  const question = norm(v.query);
  const invented = [...new Set(numbersIn(v.draft))].filter(
    (n) => !hasNumber(sourcesText, n) && !hasNumber(question, n)
  );
  if (invented.length > 0) {
    problems.push(`These figures are not in the SOURCES: ${invented.join(", ")}. Remove them or use the recorded values.`);
  }

  // 5) An item recorded in several reports (CLARIFY, golden Q05-Q07, Q26-Q27).
  for (const f of v.facts) {
    if (!f.pick) continue;
    const main = f.items.filter((it) => !it.related && markerOf.has(it.hitId));
    const citedMain = main.filter((it) => citedIds.has(it.hitId));
    const tag = (ids: string[]) => ids.map((id) => `[${markerOf.get(id)}]`).join(", ");
    if (f.pick.singledOut.length > 0) {
      const onTarget = f.pick.singledOut.some((id) => citedIds.has(id));
      const others = citedMain.filter((it) => !f.pick!.singledOut.includes(it.hitId));
      if (!onTarget && citedMain.length > 0) {
        problems.push(
          `The details in the QUESTION match only ${tag(f.pick.singledOut)}; answer for that report, not ${tag(citedMain.map((it) => it.hitId))}.`
        );
      } else if (onTarget && others.length > 0) {
        problems.push(
          `The details in the QUESTION match only ${tag(f.pick.singledOut)}; leave out the other reports' values (${tag(others.map((it) => it.hitId))}).`
        );
      }
    } else if (f.pick.valuesDiffer && citedMain.length > 0 && citedMain.length < main.length) {
      const left = main.filter((it) => !citedIds.has(it.hitId));
      problems.push(
        `"${f.heading}" has different values in other reports (${left.map((it) => `[${markerOf.get(it.hitId)}] ${it.label}`).join("; ")}) ` +
          "and the QUESTION does not say which report: give each report's value with its Job ID, or ask which report is meant."
      );
    }
  }

  // 6) Lists that must be complete: a lot's decision (all conclusion rows) and
  //    "what did not pass" lists. Every listed item has to be in the answer.
  for (const f of v.facts) {
    const mustAll = f.nonPassOnly || /Inspection Conclusion \(the lot's decision\)/.test(f.heading);
    if (!mustAll) continue;
    const left = f.items.filter((it) => markerOf.has(it.hitId) && !citedIds.has(it.hitId));
    if (left.length > 0) {
      problems.push(
        `Your answer leaves out items of the complete list "${f.heading}": ` +
          left.slice(0, 4).map((it) => `[${markerOf.get(it.hitId)}] ${it.label}`).join("; ") +
          ". Include each of them with its marker."
      );
    }
  }

  // 8) A decision that contradicts the report's own records (golden scenario
  //    19): both sides, and no plain yes / no.
  for (const f of v.facts) {
    if (!f.conflict) continue;
    const listed = f.items.filter((it) => markerOf.has(it.hitId));
    if (!listed.some((it) => citedIds.has(it.hitId))) {
      problems.push(
        "The report's decision is contradicted by its own records: " +
          listed.slice(0, 4).map((it) => `[${markerOf.get(it.hitId)}] ${it.label}`).join("; ") +
          ". Report these as well as the decision, with markers, and say the report does not resolve it."
      );
    }
    if (/^\s*(yes|no)\b/i.test(v.draft)) {
      problems.push("The report conflicts, so do not open with a plain yes or no; give both sides.");
    }
  }

  // 7) An observation in the same report about the item asked (rule 7: a
  //    note can point the other way, Q35) must not be ignored.
  for (const f of v.facts) {
    const related = f.items.filter((it) => it.related && markerOf.has(it.hitId) && !citedIds.has(it.hitId));
    if (related.length > 0) {
      problems.push(
        "The same report also has an observation on this item: " +
          related.map((it) => `[${markerOf.get(it.hitId)}] ${it.label}`).join("; ") +
          ". Mention it with its marker; if it points the other way, report both sides and say the report does not resolve it."
      );
    }
  }

  return problems.slice(0, MAX_PROBLEMS);
}
