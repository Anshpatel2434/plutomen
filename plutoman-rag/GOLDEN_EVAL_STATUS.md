# Golden evaluation — status

Status of the RAG pipeline against the **Golden Evaluation Q&A Set** (40 test
cases, 22 scenarios, behaviours ANSWER / ABSTAIN / CLARIFY / CORRECT_PREMISE /
REFUSE_OVERRIDE). Branch `testing/pipeline-docker`; `main` is untouched.
Last updated 12 Oct 2026 (round 4: Docker images + fixes, see §2).

How to undo any of this: [ROLLBACK.md](ROLLBACK.md).

---

## 1. Headline numbers

All runs use the same 11 demo reports, the same local models (Ollama
`nomic-embed-text` + `mistral` 7B, partly GPU-offloaded on a 4 GB card) and the
same grader.

### Retrieval (34 questions that have gold source pages, top 10 results)

| | Questions with every gold source retrieved | Gold-source coverage | Results from the wrong document |
|---|---|---|---|
| Before (tag `pre-eval-changes`) | 21 / 34 | 74.6 % | 42.6 % |
| After changes 1–3, 5, 8 | **29 / 34** | **92.3 %** | **6.2 %** |
| + conclusion notes | 29 / 34 | 92.7 % | 6.2 % |
| + change 10, TOC and footer chunks (current) | 28 / 34 | 89.8 % | 5.9 % |

The 34 exclude Q18 and Q20, whose sources were not indexed before change 10;
both now retrieve and answer correctly. Change 10 costs Q28 (an ABSTAIN case):
its gold line was ranked 10th, and the new contents chunk pushes it to 12th.
Q28's answer still abstains correctly, so this is a metric-only loss. #4 and #9
are the real fix.

### Answers (full golden set through the real API)

| | Content checks passed | ANSWER cases | ANSWER cases citing a wrong document | Cited documents that are wrong | Refusal case | Mean latency |
|---|---|---|---|---|---|---|
| Baseline | 23 / 40 | 15 / 29 | 4 / 29 | 22 % | 0 / 1 | 67 s |
| Changes 6 + 7, first prompt | 20 / 40 | 12 / 29 | 1 / 29 | 13 % | 1 / 1 | 9 s |
| Changes 6 + 7, revised prompt (current) | 22 / 38 \* | 13 / 27 | 2 / 27 | 13 % | 1 / 1 | 48 s † |

\* Q38 and Q39 (multi-turn) were not re-run; the run was stopped there.
† Latency on this machine is dominated by GPU memory pressure and is not a
property of the pipeline. Treat it as noise.

**Read this carefully:**

- **Retrieval clearly improved.**
- **Citations clearly improved.** A wrong-document citation fails a golden test
  case, and wrong-document citations fell from 22 % to 13 % of all citations.
- **Prompt injection is now refused.**
- **ANSWER content is not yet better than the baseline** with Mistral 7B. The
  stricter policy fixes some cases (Q19, Q23, Q40) and costs others: the model
  drops part of a value (Q03, Q07, Q36) or abstains when it should answer (Q16,
  Q21). Change 6 is committed as its own commit (`90fa155`) so it can be
  reverted alone. It should be **re-evaluated on Ministral (Bedrock)** before
  it is accepted or dropped.
- The content grader is **provisional**. Its key strings were derived by hand
  from each case's written pass criteria, because the client's machine-readable
  `must_include` / `must_not_include` sheet has not been supplied. Manual
  review found some grader false negatives (for example Q35, which reports both
  sides of the conflict correctly but is phrased "not acceptable", not "Not Ok").

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
| 6 | Answer policy in a separate system prompt (answer / abstain / clarify / correct premise / surface conflicts / refuse overrides), sources grouped by report, and a code-level guard against printing the instructions. `src/llm.ts` is the single LLM seam for the Bedrock adapter | `90fa155` | Q26–Q37, Q40 | refusal 0/1 → 1/1; CLARIFY 2/2 held; ANSWER content mixed (see §1) |
| — | Web UI shows `CONDITIONAL` verdicts as neutral, not as a pass | `5c3eb59` | Q22, Q36 | — |
| — | One failed request no longer crashes the API: errors go to a 500 for that request only. Found when the local GPU runner crashed mid-eval | `68e83c5` | robustness | — |
| — | Docker host ports configurable, and the `ingest:demo` hang fixed | `d43a578` | — | testers can run the stack next to other Postgres instances |
| — | **Round 4.** Ingest queue no longer drops document updates: every enqueue is its own job; a per-document sequence + lock means the newest update wins | `21a628b` | robustness | 3 back-to-back re-ingests: 33 jobs done, 7 stale ones skipped, no duplicates |
| — | **Docker images for api, worker and web** (`plutoman-rag:local`, `plutoman-web:local`); one command starts the whole test stack (see README "Run everything in Docker") | `556b2b5` | — | UI, search and cited answers verified through the containers |
| — | Read replica gets its own profile + replication slot (it was looping on "WAL segment already removed") | `a99a033` | — | fresh clone and re-clone both stream |
| — | Citation ranges such as `[S1-S10]` are rendered | `5c4da9e` | Q22 | — |
| — | Inspector's notes on conclusion rows are indexed | `88c648b` | Q11, Q31, Q36 | Q09 coverage 17 % → 33 % |
| 10 | Table of contents and footer chunks, from the PDF twin | `01447a1` | Q18, Q20 | both now answered correctly (see §1 for the Q28 trade-off) |

Tests: 98 offline and DB tests pass (`npm test`). They include tenant-isolation
tests for the entity catalog and the keyword lexicon.

---

## 3. Per-question status

Retrieval coverage = share of the case's gold source pages found in the top 10
results ("n/a" = no page-level gold, e.g. abstain and multi-turn cases).
Content = provisional grader (see §1).

| Case | Behaviour | Retrieval coverage | Baseline | Current | What is still wrong / needed |
|---|---|---|---|---|---|
| Q01 | ANSWER | 100 % | pass | pass | — |
| Q02 | ANSWER | 100 % | fail | fail | gives the inspection date instead of the PO date |
| Q03 | ANSWER | 100 % | pass | fail | the result word is kept, but the measured value is dropped (prompt / model) |
| Q04 | ANSWER | 100 % | pass | pass | — |
| Q05 | ANSWER | 100 % | pass (wrong doc cited) | pass | — |
| Q06 | ANSWER | 100 % | fail | fail | picks the wrong drum-count report; needs a quantity-aware match (#9) |
| Q07 | ANSWER | 100 % | pass (wrong doc cited) | fail | answers "OK" without the recorded wording |
| Q08 | ANSWER | 50 % | pass | pass | comparison across two reports: needs #4 |
| Q09 | ANSWER | 17 % | fail | fail | comparison across six reports: needs #4 |
| Q10 | ANSWER | 100 % | pass | pass | — |
| Q11 | ANSWER | 100 % | fail | fail | note now indexed (round 4), but the Test Results row is not in the top 10; needs the complete conclusion section (#4) |
| Q12 | ANSWER | 100 % | pass | pass | — |
| Q13 | ANSWER | 100 % | fail | fail | counts 3 of 4 failures; needs the complete section (#4) |
| Q14 | ANSWER | 100 % | pass | pass | — |
| Q15 | ANSWER | 60 % | pass | pass | retrieval across all reports is incomplete (#4) |
| Q16 | ANSWER | 100 % | fail | fail | over-abstains although the note is retrieved |
| Q17 | ANSWER | 100 % | pass | pass | — |
| Q18 | ANSWER | now retrieved | fail | answers correctly (round 4, not graded) | change 10 done; the model writes "sources S1, S3" as prose, not citations, and adds a guess about one report |
| Q19 | ANSWER | 100 % | fail | pass | — |
| Q20 | ANSWER | now retrieved | fail | answers correctly (round 4, not graded) | change 10 done; the answer cites no source |
| Q21 | ANSWER | 100 % | fail | fail | says all tests passed; needs the complete section (#4) |
| Q22 | ANSWER | 100 % | fail | fail | misses the "subject to rectification" item (the raw `[S1-S10]` marker is fixed in round 4) |
| Q23 | ANSWER | 50 % | fail | pass | — |
| Q24 | ANSWER | 100 % | pass | pass | — |
| Q25 | ANSWER | 100 % | pass | pass | — |
| Q26 | CLARIFY | 100 % | pass | pass | — |
| Q27 | CLARIFY | 100 % | pass | pass | — |
| Q28 | ABSTAIN | 100 % → 0 % after change 10 | pass | pass | still abstains correctly; see §1 |
| Q29 | ABSTAIN | 100 % | pass | pass | — |
| Q30 | ABSTAIN | n/a | pass | pass | — |
| Q31 | CORRECT_PREMISE | 100 % | pass | pass | — |
| Q32 | CORRECT_PREMISE | 100 % | fail | fail | gives the value but does not say the premise ("it passed") is false |
| Q33 | ABSTAIN | 100 % | fail (wrong doc cited) | fail | still explains the severity terms from general knowledge |
| Q34 | ABSTAIN | n/a | pass (wrong doc cited) | pass | — |
| Q35 | ANSWER | 100 % | pass | fail † | reports both sides correctly; † likely a grader false negative |
| Q36 | ANSWER | 60 % | fail | fail | the note is now retrieved (3rd), but the model still answers a flat "Yes"; needs #9 |
| Q37 | ABSTAIN | 100 % | pass | pass | — |
| Q38 | ANSWER (multi-turn) | n/a | fail | not re-run (first prompt: fail) | resolves "the other job" to the wrong report; needs multi-turn seeding |
| Q39 | ANSWER (multi-turn) | n/a | pass | not re-run (first prompt: pass) | — |
| Q40 | REFUSE_OVERRIDE | 100 % | fail | pass | — |

---

## 4. What is left

### Pipeline changes still to do (from the golden-set analysis)

| # | Item | Cases | Notes |
|---|---|---|---|
| 4 | **Aggregation and complete-section retrieval**: when a question asks to count, list or compare ("how many…", "which… did not pass", "across all…"), fetch every item of that section, or that field across every matching report, instead of the top 10 | Q08, Q09, Q11, Q13, Q15, Q21, Q22 | largest remaining gap; the remaining retrieval misses are all this kind |
| 9 | **No-answer threshold + verification step**: decide abstain/answer from retrieval scores, and check the draft answer's values against the cited source before returning it | Q03, Q06, Q07, Q16, Q32, Q33, Q36 | addresses most of the change-6 regressions; best tuned on Ministral |
| — | **Multi-turn seeding**: carry the resolved job and POID filters from the previous turn and exclude the already-discussed report for "the other…" | Q38, Q39 | — |
| — | **Uncited or prose-cited answers**: the model sometimes cites nothing (Q20) or writes "sources S1, S3" in prose instead of `[S1]`. Either re-prompt once when an ANSWER has no markers, or render bare markers | Q18, Q20 | belongs with #9 |

### Model and hosting

- **Bedrock adapter for Ministral**: implement `chatComplete` in `src/llm.ts`
  with the Bedrock Converse API (the only file that needs to change). Then
  re-run the golden set and decide on change 6 with the real model.
- Local GPU (4 GB) cannot hold both models comfortably. The Ollama runner
  crashed once mid-eval. This doesn't affect the production design, but it
  makes local timings meaningless.

### Infrastructure and known bugs

- Done in round 4: the queue update-drop bug, Docker images for api / worker /
  web, and the replica WAL loop.
- `npm audit` reports dependency vulnerabilities that have not been reviewed.

### Inputs needed from the client

1. The machine-readable **`must_include` / `must_not_include` sheet**. Without
   it, content scores are an approximation.
2. The **section 1A inventory** (expected section list per report type) for
   Q18 and for the TOC chunks.
3. Confirmation of the **Phase 4 quote**.
4. Approval to commit the **eval harness**. It contains the golden-set
   questions verbatim, so it is kept outside the repo for now.
