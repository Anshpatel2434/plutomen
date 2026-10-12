# Golden evaluation — status

Status of the RAG pipeline against the **Golden Evaluation Q&A Set** (40 test
cases, 22 scenarios, behaviours ANSWER / ABSTAIN / CLARIFY / CORRECT_PREMISE /
REFUSE_OVERRIDE). Branch `testing/pipeline-docker`; `main` is untouched.
Last updated 12 Oct 2026 (changes 4 and 9, see §2).

How to undo any of this: [ROLLBACK.md](ROLLBACK.md).

---

## 1. Headline numbers

All runs use the same 11 demo reports, the same local models (Ollama
`nomic-embed-text` + `mistral` 7B, partly GPU-offloaded on a 4 GB card) and the
same grader.

### Answers (full golden set through the real API)

| | Content checks passed | ANSWER cases | CLARIFY | CORRECT_PREMISE | ABSTAIN | Refusal | Mean latency |
|---|---|---|---|---|---|---|---|
| Original baseline | 23 / 40 | 15 / 29 | 2 / 2 | 1 / 2 | 5 / 6 | 0 / 1 | 67 s † |
| Before changes 4 + 9 (end of round 4) | 25 / 40 | 16 / 29 | 2 / 2 | 1 / 2 | 5 / 6 | 1 / 1 | 10 s |
| **After changes 4 + 9 (current)** | **39 / 40** | **29 / 29** | **2 / 2** | **2 / 2** | 5 / 6 | **1 / 1** | 16.5 s |

Changes 4 + 9 fixed 14 cases (Q02, Q06, Q07, Q09, Q11, Q13, Q16, Q21, Q22,
Q24, Q32, Q35, Q36, Q38) and broke none. Every ANSWER now cites a source. The
one remaining failure is Q33 (see §3).

† Latency on this machine is dominated by GPU memory pressure (the Ollama
runner degraded once during this round and had to be restarted). The 16.5 s
includes a second LLM call for the 14 of 40 answers the check sent back.

**Read this carefully:**

- **These numbers are optimistic.** Changes 4 and 9 were developed while
  looking at these same 40 questions, and some of the answer checks were added
  for failures seen in these runs. The checks are generic (none mentions a
  vendor, report or question), but the score must be confirmed on questions
  the pipeline was not tuned on (a held-out set) before it is relied on.
- The content grader is **provisional**. Its key strings were derived by hand
  from each case's written pass criteria, because the client's machine-readable
  `must_include` / `must_not_include` sheet has not been supplied. Manual review
  has found grader errors both ways (Q37 passed earlier with a wrong answer, see
  §3).
- **Wrong-document citations: 6 of 51 (12 %).** Five of them are Q18: every
  mini-pillar report has the same table of contents, so the (correct) answer
  cites all six while the golden set names one. The sixth is Q33.
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
| 4 | **Complete lists.** For questions that count, list, compare, ask about failures or ask for the lot's decision, every matching item inside the named reports is fetched with plain SQL (no top-10 cut-off), with exact pass / fail / conditional counts given to the model. The match runs against the tenant's own section and item vocabulary, nothing hard-coded. Single-item lists carry the same report's related observations. An item found in several reports records whether the values differ and which report the question's own details (an engineer's name, "5 drums", a batch number) point to | `b484f45` | Q05–Q09, Q11–Q16, Q21–Q23, Q26, Q27, Q31, Q35, Q36 | with #9: content 25 → 39 / 40; retrieval Q09 33 % → 100 % |
| 9 | **Answer check.** Each draft is checked deterministically against its own sources: cited values quoted exactly, no figures from nowhere, complete lists complete, the report the question names, conflicts addressed, citations present, no explaining undefined terms, no "not recorded" when the item was given. Only a draft with problems gets one retry, with the problems listed. Prose markers ("sources S1, S3") become citations. `VERIFY_ANSWERS=false` turns it off | `312d67a` | Q02, Q03, Q06, Q07, Q16, Q20, Q23, Q24, Q33, Q35, Q36 | 14 of 40 answers retried; no case regressed |

Tests: 130 offline and DB tests pass (`npm test`). They include
tenant-isolation tests for the entity catalog, the keyword lexicon and the
complete lists.

---

## 3. Per-question status

Retrieval coverage = share of the case's gold source pages found in what
generation receives ("n/a" = no page-level gold, e.g. abstain and multi-turn
cases). Content = provisional grader (see §1).

| Case | Behaviour | Retrieval coverage | Original baseline | Before 4 + 9 | Now | Notes |
|---|---|---|---|---|---|---|
| Q01 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q02 | ANSWER | 100 % | fail | fail | **pass** | fixed by #9: the PO value is now quoted in full (number and date) |
| Q03 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q04 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q05 | ANSWER | 100 % | pass (wrong doc cited) | pass | **pass** | — |
| Q06 | ANSWER | 100 % | fail (wrong doc cited) | fail (wrong doc cited) | **pass** | fixed by #4 + #9: "5 drums" in the question picks the right Polycab report |
| Q07 | ANSWER | 100 % | pass (wrong doc cited) | fail | **pass** | fixed by #4 + #9: batch numbers pick the report; recorded wording quoted |
| Q08 | ANSWER | 50 % | pass | pass | **pass** | retrieval metric misses the reports' Basic Details page; both weights come from the complete list |
| Q09 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4: Technical Clearance from all six reports |
| Q10 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q11 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4: the Test Results note is in the list label |
| Q12 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q13 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4: exact count, 4 of 15 (3 failed, 1 pending) |
| Q14 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q15 | ANSWER | 60 % | pass | pass | **pass** | the list shows the 2 failing reports and counts all 5; metric counts the 3 passing ones as missing |
| Q16 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4 + #9: the House Keeping row is listed, no more "not recorded" |
| Q17 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q18 | ANSWER | n/a | fail (wrong doc cited) | pass | **pass (wrong doc cited)** | answer correct; cites all 6 mini-pillar contents pages (identical), the golden set names one |
| Q19 | ANSWER | 100 % | fail | pass | **pass** | — |
| Q20 | ANSWER | n/a | fail | pass | **pass** | — |
| Q21 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4: both failed tests from the complete section |
| Q22 | ANSWER | 100 % | fail | fail | **pass** | fixed by #4: the one "subject to rectification" item is listed |
| Q23 | ANSWER | 50 % | fail | pass | **pass** | conclusion listed; the answer now carries both sides |
| Q24 | ANSWER | 100 % | pass | fail | **pass** | answer now quotes the recorded 250 |
| Q25 | ANSWER | 100 % | pass | pass | **pass** | — |
| Q26 | CLARIFY | 100 % | pass | pass | **pass** | each report's SAP code with its Job ID (values differ, nothing in the question picks one) |
| Q27 | CLARIFY | 100 % | pass | pass | **pass** | — |
| Q28 | ABSTAIN | 0 % | pass | pass | **pass** | retrieval metric 0 % since change 10 (gold line ranked 12th); still abstains correctly |
| Q29 | ABSTAIN | 100 % | pass | pass | **pass** | — |
| Q30 | ABSTAIN | n/a | pass | pass | **pass** | — |
| Q31 | CORRECT_PREMISE | 100 % | pass | pass | **pass** | — |
| Q32 | CORRECT_PREMISE | 100 % | fail | fail | **pass** | premise corrected |
| Q33 | ABSTAIN | 100 % | fail (wrong doc cited) | fail (wrong doc cited) | **fail (wrong doc cited)** | still explains the severity terms; #9 flags it, the retry explains again (model limit) |
| Q34 | ABSTAIN | n/a | pass (wrong doc cited) | pass | **pass** | — |
| Q35 | ANSWER | 100 % | pass | fail | **pass** | fixed by #4 + #9: the conflicting observation is listed and reported |
| Q36 | ANSWER | 60 % | fail | fail | **pass** | fixed by #4 + #9: "cleared" plus "subject to rectification" |
| Q37 | ABSTAIN | 100 % | pass | pass | **pass** | the earlier "pass" described the photos (grader false positive); the answer now says contents are not recorded |
| Q38 | ANSWER (multi-turn) | n/a | fail | fail | **pass** | multi-turn: now names the right vendor engineer |
| Q39 | ANSWER (multi-turn) | n/a | pass | pass | **pass** | — |
| Q40 | REFUSE_OVERRIDE | 100 % | fail | pass | **pass** | — |

---

## 4. What is left

### Pipeline

| Item | Cases | Notes |
|---|---|---|
| **Validate on a held-out set.** Write 20–40 new questions over the same reports, in the golden set's style, that were not used for tuning, and run the same harness. This is the honest measure of changes 4 + 9 | all | most important next step; the client's `must_include` sheet would make it objective |
| **Definition questions** still get an explanation from general knowledge (Q33). The check catches it, but Mistral repeats it on the retry. Options: return a fixed "the reports do not define this term" when the retry still explains (like the instruction-leak guard), or re-test on Ministral first | Q33 | small |
| **Identical pages across reports** (Q18): decide whether citing every report with the same contents page is right, or whether to cite one | Q18 | needs a product decision |
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
2. The **section 1A inventory** (expected section list per report type) for
   Q18 and for the TOC chunks.
3. Confirmation of the **Phase 4 quote**.
4. Approval to commit the **eval harness**. It contains the golden-set
   questions verbatim, so it is kept outside the repo for now.
