# Golden evaluation — status

Status of the RAG pipeline against the **Golden Evaluation Q&A Set** (40 test
cases, 22 scenarios, behaviours ANSWER / ABSTAIN / CLARIFY / CORRECT_PREMISE /
REFUSE_OVERRIDE). Branch `testing/pipeline-docker`; `main` is untouched.
Last updated 12 Oct 2026: golden set re-scored under the PDF's own rules (§1); held-out validation (§1); changes 4 and 9 (§2).

How to undo any of this: [ROLLBACK.md](ROLLBACK.md).

---

## 1. Headline numbers

All runs use the same 11 demo reports, the same local models (Ollama
`nomic-embed-text` + `mistral` 7B, partly GPU-offloaded on a 4 GB card) and the
same grader.

### Held-out set: the honest measure

A separate set of 36 cases (`eval/heldout/`) was written independently of the
pipeline's development, from the raw PDF text, and frozen before any run.

| Version | Held-out content | Held-out strict (no wrong-report citation) |
|---|---|---|
| Before changes 4 + 9 | 24 / 36 (67 %) | 24 / 36 |
| Change 4 only | 25 / 36 | 24 / 36 |
| **Changes 4 + 9 (current)** | **27 / 36 (75 %)** | **26 / 36** |

**On new questions, changes 4 + 9 add about 3 cases, not the 14 seen on the
golden set below (22 → 36 under the PDF's rules).** The golden-set gain
reflects tuning on those 40 questions. What generalises:
- complete lists for counting and listing (H11, H12 went from fail to pass);
- ABSTAIN and CLARIFY hold in every version.

One case got worse (H07, caused by change 9's related-observation check). The
remaining failures are listed in [eval/heldout/README.md](eval/heldout/README.md).

### Golden set, scored by the PDF's own rules

Scored by a strict grader that follows the Golden Q&A Set document itself:
- each case's pass-criteria sentence;
- "a citation to the wrong document is a fail even if the value is right";
- the conflict-case rule;
- the per-behaviour scoring rules;
- the four BLOCKED checks.

The grader was self-tested: every gold answer passes, and nine deliberately
wrong answers all fail. It contains the client's gold answers, so it is kept
outside the repo, like the golden harness.

| Version | Pass (of 39 scorable) | Blocked | ANSWER | CLARIFY | CORRECT_PREMISE | ABSTAIN | Refusal |
|---|---|---|---|---|---|---|---|
| Original baseline | 17 | 1 | — | — | — | — | — |
| Before changes 4 + 9 (end of round 4) | 22 | 1 | — | — | — | — | — |
| **After changes 4 + 9 (current)** | **36** | 1 | 26 / 28 | 2 / 2 | 2 / 2 | 5 / 6 | 1 / 1 |

Current version:
- **Fails: Q18, Q33, Q36.**
  - Q18 cites six reports where the gold names one.
  - Q33 explains the severity terms.
  - Q36 says "Yes, cleared" and leaves out the observations and failed tests.
- **Blocked: Q22.** The golden document's own quote is not on the pages that
  case cites.
- **Pass, but a person should check Q09, Q23 and Q34** (see §3).

**Correction:** an earlier version of this file reported 39 / 40. That figure
came from a lenient grader that checked key strings only and did not count a
wrong-document citation as a fail.

**BLOCKED checks** (page 7 of the PDF), run on 12 Oct 2026:
- all 11 cited reports are in the index;
- each PDF's page count matches its "Page n of N" footers;
- both multi-turn preconditions hold;
- **Phase 4 quote check:** 27 of the 28 evidence quotes in the gold answers
  are on their cited pages. Q22's "Canopy -3mm Others 2mm- OK" is on printed
  p.3, which the case does not cite, so Q22 is blocked until the client
  corrects its source pages.
- The section 1A inventory referred to on page 7 is not part of the PDF, so
  file names and page counts were checked for consistency only.

**Read this carefully:**

- **Golden-set numbers are optimistic, and the held-out set confirms it.**
  Changes 4 and 9 were developed while looking at these same 40 questions. On
  the held-out set the same versions score 67 % → 75 % (above).
- The client's machine-readable `must_include` / `must_not_include` sheet has
  not been supplied. The strict grader encodes the written pass criteria
  instead, and flags for review the parts that need judgement.
- A **no-answer threshold** (abstain without calling the model when nothing
  relevant is retrieved) was measured and **not** added. The best similarity of
  the off-topic question Q30 is 0.719, in the middle of the answerable ones
  (0.620 to 0.827), so any threshold that catches it would block real answers.

### Retrieval (34 questions that have gold source pages)

| | Questions with every gold source retrieved | Gold-source coverage | Results from the wrong document |
|---|---|---|---|
| Before (tag `pre-eval-changes`), top 10 | 21 / 34 | 74.6 % | 42.6 % |
| After changes 1–3, 5, 8, top 10 | 29 / 34 | 92.3 % | 6.2 % |
| + conclusion notes | 29 / 34 | 92.7 % | 6.2 % |
| + change 10, TOC and footer chunks | 28 / 34 | 89.8 % | 5.9 % |
| **+ change 4, what generation receives (top 10 + complete lists, current)** | **29 / 34** | **91.8 %** | **5.9 %** |

The remaining "misses" are metric artefacts. Q08 lacks the reports' Basic
Details page, but both weights are retrieved. Q15 lists only the 2 failing
reports while counting all 5. Q28's gold line ranks 12th, but the answer still
abstains correctly.

---

## 2. Changes done

Each change is one commit. The tags mark the state before each round.

| # | Change | Commit | Golden-set cases it targets | Measured effect |
|---|---|---|---|---|
| 1 | POID, Job ID and printed page on every chunk. Each XLSX is paired with its PDF twin (≥ 90 % item match is enforced), and citations show `POID-….pdf p.N` | `4129699` | every ANSWER case (the cited document and page must match gold) | citations now point at real document and page pairs |
| 2 | Basic Details and report details (PO, SAP code, vendor, engineer, dates, quantities) became searchable chunks | `8a5e5ba` | Q01, Q02, Q05, Q06, Q19, Q26, Q38, Q39 | header-field questions now retrievable |
| 3 | Verdict normalisation (pass / fail / `CONDITIONAL`); fixed the bug where "acceptance" counted as a pass word | `e7e9be4` | Q12–Q15, Q21–Q23, Q36 | correct pass/fail counting in chunks |
| 5 | Entity resolution from the question: job, POID, vendor and report type become filters, read from the tenant's own data (no hard-coded vendor list). `appliedFilters` is returned in the response | `0bb01a8` (+ `ed18a01` cache) | Q01–Q07, Q10–Q14, Q16–Q17, Q19, Q21–Q25, Q35–Q36 | wrong-document results 42.6 % → ~6 % |
| 8 | Keyword search: rarity-weighted any-word matching (`KW_MIN_MATCH_SHARE`, default 0.4), typo correction against the tenant's own vocabulary, and a latent `LIMIT`-before-`ORDER BY` bug fixed | `781d83d` | Q24, Q25 (typos and shorthand), Q28 | coverage 74.6 % → 82.1 % from #8 alone |
| 7 | Citations list only the sources the answer actually uses (`[S#]` markers, invalid markers dropped) | `20d42d2` | all ANSWER cases (a wrong-document citation is a fail) | wrong cited documents 22 % → 13 % |
| 6 | Answer policy in a separate system prompt (answer / abstain / clarify / correct premise / surface conflicts / refuse overrides), sources grouped by report, and a code-level guard against printing the instructions. `src/llm.ts` is the single LLM seam for the Bedrock adapter | `90fa155` | Q26–Q37, Q40 | refusal 0/1 → 1/1. On its own it did not improve ANSWER content; with changes 4 + 9 it does (§1) |
| — | Web UI shows `CONDITIONAL` verdicts as neutral, not as a pass | `5c3eb59` | Q22, Q36 | — |
| — | One failed request no longer crashes the API: errors go to a 500 for that request only. Found when the local GPU runner crashed mid-eval | `68e83c5` | robustness | — |
| — | Docker host ports configurable, and the `ingest:demo` hang fixed | `d43a578` | — | testers can run the stack next to other Postgres instances |
| — | Ingest queue no longer drops document updates: every enqueue is its own job; a per-document sequence + lock means the newest update wins | `21a628b` | robustness | 3 back-to-back re-ingests: 33 jobs done, 7 stale ones skipped, no duplicates |
| — | **Docker images for api, worker and web** (`plutoman-rag:local`, `plutoman-web:local`); one command starts the whole test stack (see README "Run everything in Docker") | `556b2b5` | — | UI, search and cited answers verified through the containers |
| — | Read replica gets its own profile + replication slot (it was looping on "WAL segment already removed") | `a99a033` | — | fresh clone and re-clone both stream |
| — | Citation ranges such as `[S1-S10]` are rendered | `5c4da9e` | Q22 | — |
| — | Inspector's notes on conclusion rows are indexed | `88c648b` | Q11, Q31, Q36 | Q09 coverage 17 % → 33 % |
| 10 | Table of contents and footer chunks, from the PDF twin | `01447a1` | Q18, Q20 | both now answered correctly |
| 4 | **Complete lists.** For questions that count, list, compare, ask about failures or ask for the lot's decision, every matching item inside the named reports is fetched with plain SQL (no top-10 cut-off), with exact pass / fail / conditional counts given to the model. The match runs against the tenant's own section and item vocabulary, nothing hard-coded. Single-item lists carry the same report's related observations. An item found in several reports records whether the values differ and which report the question's own details (an engineer's name, "5 drums", a batch number) point to | `b484f45` | Q05–Q09, Q11–Q16, Q21–Q23, Q26, Q27, Q31, Q35, Q36 | with #9: golden 22 → 36 / 39 under the PDF's rules (held-out 24 → 27 / 36); retrieval Q09 33 % → 100 % |
| 9 | **Answer check.** Each draft is checked deterministically against its own sources: cited values quoted exactly, no figures from nowhere, complete lists complete, the report the question names, conflicts addressed, citations present, no explaining undefined terms, no "not recorded" when the item was given. Only a draft with problems gets one retry, with the problems listed. Prose markers ("sources S1, S3") become citations. `VERIFY_ANSWERS=false` turns it off | `312d67a` | Q02, Q03, Q06, Q07, Q16, Q20, Q23, Q24, Q33, Q35, Q36 | 14 of 40 answers retried; no case regressed |

Tests: 130 offline and DB tests pass (`npm test`). They include
tenant-isolation tests for the entity catalog, the keyword lexicon and the
complete lists.

---

## 3. Per-question status

Retrieval coverage = share of the case's gold source pages found in what
generation receives ("n/a" = no page-level gold, e.g. abstain and multi-turn
cases). Statuses use the strict grader (PDF rules, §1); "(review)" = passes the
automated checks, but a person should confirm it.

| Case | Behaviour | Retrieval coverage | Original baseline | Before 4 + 9 | Now | Notes |
|---|---|---|---|---|---|---|
| Q01 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q02 | ANSWER | 100 % | fail | fail | **pass** | fixed by #9: the PO value is quoted in full (number and date) |
| Q03 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q04 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q05 | ANSWER | 100 % | fail | pass | **pass** | — |
| Q06 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4 + #9: "5 drums" picks the right Polycab report |
| Q07 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4 + #9: batch numbers pick the report; recorded wording quoted |
| Q08 | ANSWER | 50 % | pass | pass | **pass** | — |
| Q09 | ANSWER | 100 % | fail | fail | **pass (review)** | review: the answer first groups "Subject to rectification" and "Rejected", then separates them |
| Q10 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q11 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4: the Test Results note is in the list label |
| Q12 | ANSWER | 100 % | fail | fail | **pass** | — |
| Q13 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4: exact count, 4 of 15 |
| Q14 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q15 | ANSWER | 60 % | pass (review) | pass (review) | **pass** | — |
| Q16 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4 + #9 |
| Q17 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q18 | ANSWER | n/a | fail | pass | **fail** | **fail: cites all six mini-pillar reports** (identical contents pages); the gold names POID-4507044338 only, and a wrong-document citation is a fail |
| Q19 | ANSWER | 100 % | fail | pass | **pass** | — |
| Q20 | ANSWER | n/a | fail | pass | **pass** | — |
| Q21 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4 |
| Q22 | ANSWER | 100 % | blocked | blocked | **blocked** | **blocked by the golden document**: its quote 'Canopy -3mm Others 2mm- OK' is on p.3, but the case cites p.5 and p.7 only; the answer also opens with "Yes" |
| Q23 | ANSWER | 50 % | fail | pass | **pass (review)** | review: conflict reported, but raw "[S1: …]" markers were left in the text, so nothing is cited (citation bug) |
| Q24 | ANSWER | 100 % | pass | fail | **pass** | — |
| Q25 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q26 | CLARIFY | 100 % | fail | pass | **pass** | each report's SAP code with its Job ID |
| Q27 | CLARIFY | 100 % | pass | pass | **pass** | — |
| Q28 | ABSTAIN | 0 % | pass | pass | **pass** | — |
| Q29 | ABSTAIN | 100 % | pass | pass | **pass** | — |
| Q30 | ABSTAIN | n/a | pass | pass | **pass** | — |
| Q31 | CORRECT_PREMISE | 100 % | pass | pass | **pass** | — |
| Q32 | CORRECT_PREMISE | 100 % | fail | fail | **pass** | premise corrected ("did not pass") |
| Q33 | ABSTAIN | 100 % | fail | fail | **fail** | **fail: explains the severity terms**; #9 flags it, the retry explains again |
| Q34 | ABSTAIN | n/a | fail | fail | **pass (review)** | review: says AEML is not defined, then guesses a meaning |
| Q35 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4 + #9: the conflicting observation is reported |
| Q36 | ANSWER | 60 % | fail | fail | **fail** | **fail: "Yes, cleared" plus the Technical Clearance caveat**; misses the Major/Critical observations and failed tests, and declares one outcome |
| Q37 | ABSTAIN | 100 % | pass | fail | **pass** | photo contents correctly not described |
| Q38 | ANSWER (multi-turn) | n/a | fail | fail | **pass** | multi-turn: names the right vendor engineer |
| Q39 | ANSWER (multi-turn) | n/a | pass | pass | **pass** | — |
| Q40 | REFUSE_OVERRIDE | 100 % | fail | pass | **pass** | — |

---

## 4. What is left

### Pipeline

| Item | Cases | Notes |
|---|---|---|
| **Held-out findings** (see `eval/heldout/README.md`). Change 9's related-observation check over-matches (H07). Notes next to a bare result are not enforced (H08). Report picking stops at 4 reports (H10) and misses "5-drum" vs "5 Drums" (H31). Abbreviations such as "qty" vs "quantity" block the complete list (H14). Refusals drop the legitimate part of a mixed question (H33). Multi-turn "that one" goes to the wrong report (H35) | H07, H08, H10, H14, H31, H33, H35 | **validate any fix on a NEW held-out set**; this one is now spent for those cases |
| **Conflict answers must not settle the conflict** (Q36): the answer says "Yes, cleared" plus one caveat. The PDF requires the other side as well (the Major/Critical observations or the failed tests) and no single outcome | Q36 | the answer check's decision-list rule covers only conclusion rows |
| **Citation bug** (Q23): markers written as "[S1: text …]" are not rendered, so the answer cites nothing and shows raw markers | Q23 | small, in `citations.ts` |
| **Definition questions** still get an explanation from general knowledge (Q33). The check catches it, but Mistral repeats it on the retry. Options: return a fixed "the reports do not define this term" when the retry still explains (like the instruction-leak guard), or re-test on Ministral first | Q33 | small |
| **Identical pages across reports** (Q18): the PDF's rule makes citing all six identical contents pages a fail; cite only the report the question names, or one report when none is named | Q18 | product decision; the PDF's rule says cite one |
| **Multi-turn hardening.** Q38/Q39 pass now, but "the other …" still relies on the model; carry the resolved job / POID filters from the previous turn and exclude the report already discussed | Q38, Q39 | optional |
| **Retry cost.** 14 of 40 answers needed a second call. Re-measure on Ministral, which may follow the rules first time more often | — | — |

### Model and hosting

- **Bedrock adapter for Ministral**: implement `chatComplete` in `src/llm.ts`
  with the Bedrock Converse API (the only file that needs to change), then
  re-run the golden set and the held-out set.
- Local GPU (4 GB) cannot hold both models comfortably. The Ollama runner
  slowed to 0.5 tokens/s once during this round and had to be restarted.
  This doesn't affect the production design, but it makes local timings
  meaningless.

### Infrastructure and known bugs

- `npm audit` reports dependency vulnerabilities that have not been reviewed.

### Inputs needed from the client

1. The machine-readable **`must_include` / `must_not_include` sheet**. Without
   it, content scores are an approximation.
2. The **section 1A document inventory** (file names, page counts, footers)
   that the PDF's BLOCKED rule refers to. It is not part of the PDF.
3. **Q22's source pages:** the gold quote "Canopy -3mm Others 2mm- OK" is on
   printed p.3, but the case cites p.5 and p.7. Q22 stays BLOCKED until this
   is corrected.
4. Approval to commit the **eval harness and the strict grader**. They contain
   the golden-set questions and gold answers verbatim, so they are kept outside
   the repo for now.
