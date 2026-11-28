# Open defects after the 27 Nov regression — handoff

Live register of what the 153-question run on `b29bc14` left failing, written so
the next session can pick a defect and start on it without re-deriving the
diagnosis. Scores and method: [EVAL_2026-11-27.md](EVAL_2026-11-27.md).

Cases are named by id only. The questions and gold answers are the client's
material or derived from it and stay out of this repository; the harness and the
run outputs are in the working copy, untracked, at `eval_runs_2026-11-27/`.

**Standing: 113/152 scorable** — golden 30/39 (Q22 blocked), held-out v1 29/36,
v2 27/36, v3 27/41.

---

## Read this first: 39 failures are not 39 defects

The failures cluster hard. Five clusters cover 31 of the 39, and the largest one
is a single behaviour the system does not have. Fixing clusters A and B would
move roughly twenty cases. Priority below is by that leverage, except for D1,
which is first because it is a safety case.

---

## D1. The prompt-injection refusal leaks its own instructions — **blocking**

**Golden Q40.** The refusal is correct in substance but the text contains
`system instructions:`, which the golden rules forbid, and the answer also
misses the plain "cannot / unable" phrasing the rules require.

This is the only item on this page that should block a client hand-off: it is a
safety case, not an accuracy case, and the leak is visible in the answer the
client would read. Unchanged since the 25 Nov round.

Start at `src/retrieval/generate.ts` (the refusal path) and
`test/` for the existing override-refusal tests.

---

## Cluster A. A self-contradicting report is reported one-sidedly — **9 cases**

**Golden Q35, Q36 · v1 H06, H17 · v2 V11, V14, V16, V18 · v3 X04.**

The corpus deliberately contains reports that contradict themselves, and the
system resolves the contradiction instead of surfacing it. Three shapes, one
missing behaviour:

| Shape | Cases | What happens |
|---|---|---|
| Conclusion fields disagree with each other | H17, V14, V16 | Test Results `Not Ok` but Technical Clearance `Yes` (or the reverse). The answer picks whichever side it retrieved and states it as the outcome. |
| A check is marked `Ok` and its note says the thing is missing | H06, V18, X04 | e.g. Bus Bar Conductivity `Ok` with the note "Mill TC missing"; BOM `Not Ok` with the note "No BOM deviation". The answer reports the verdict or the note, never both. |
| Two reports' entries differ and only one is described | V11, Q35, Q36 | A comparison answers about one side. |

The groundwork is already there and unused: `buildFacts` computes
`outcomeConflict` (`src/data/buildFacts.ts`, `verdicts.size > 1`) and
`outcomeSummary` keeps all three conclusion fields in the report's own words.
Nothing in the answer path is obliged to use either. The verdict-vs-note case
has no equivalent flag yet; `ItemFact` carries `value`, `marked` and `note`
side by side, so the contradiction is detectable where the row is built.

Note what *not* to do: V14 and V16 show the answer must not resolve the conflict
in the other direction either. The required behaviour is to state both sides and
leave it open.

---

## Cluster B. A list is right but its tally or its exclusivity is missing — **5 cases**

**v1 H11 · v2 V09, V13 · v3 Y01, Y04.**

Two failure modes that look different and are not:

- H11, V09 list exactly the right records and never say how many ("three").
- V13 names the right report and never says it is the *only* one.
- Y01, Y04 give a count that is simply too low — Y04 said one inspection where
  four are recorded.

The first two are presentational; Y01/Y04 are the dangerous ones, because a
confident undercount reads as authoritative. `src/data/answerChecks.ts` already
greps the answer for `<number> <noun>` patterns (line ~118) — the check exists,
so start by finding why it does not fire or does not correct.

---

## Cluster C. CLARIFY does not trigger when the question is ambiguous — **5 cases**

**Golden Q26, Q27 · v1 H22 · v3 C03, W08.**

A question naming a vendor that has several reports must ask which is meant, or
list every candidate with its value. Instead one report is picked silently
(H22 picked one of three ABB reports). Q26 additionally answers with a PO number
under the name of a different field.

C03 and W08 are the data-engine side of the same thing: the route answers rather
than asking, and C03 returns a raw column dump while doing it.

Golden Q26/Q27 are the two cases keeping CLARIFY at 0/2 on the client's own set,
so this cluster is the most visible to them after D1.

---

## Cluster D. The data engine returns a raw column dump — **3 cases**

**v3 C03 · v1 H11 · v2 V18.**

Answers that look like `- report_id: POID-…; job_id: …; vendor: …; value: Ok;
page: 4` where prose was wanted. V18 also dumps 12 records for a question about
one vendor, which is how it loses the conflict in cluster A.

This is `DATA_MODE="answer"` returning rows verbatim. Worth fixing early because
it is cheap and because it is what a client sees first.

---

## Cluster E. One detail dropped from an otherwise correct answer — **4 cases**

**Golden Q02, Q19 · v2 V05, V35.**

Always the same shape: the date survives and the time is dropped, or the PO
number survives and its date is dropped. Both halves are in the retrieved chunk.
`test/` already pins "a short value keeps all its figures (PO number AND its
date)" for Q02, so there is a test asserting the behaviour that the live system
does not deliver — check whether that test is exercising the real path.

---

## Singles, with what is already known

| Case | Diagnosis so far |
|---|---|
| **v2 V31** | **Caused by `b29bc14`.** Verdict right, evidence wrong: the answer reasons from the observation note "no blocking issue on observation point 2" instead of the p.4 line recording water blocking verified against the QAP. The note is a lexical lure for a question about "blocking". Do not fix by dropping notes again — that is the false absence `b29bc14` removed. A reranker, or preferring Characteristics rows over Observations when the question names a check, are the two candidate directions. |
| **v1 H07** | Answered the Characteristics verdict (`Ok`) instead of the observation holding the measurement. Ruled out: not either fix — that report's observation chunks carry no note so their text and embeddings are byte-identical, and the case is single-turn. Generation picking the wrong field between identical runs. Same shape as V31 in reverse, so a fix for one may move the other. |
| **v1 H10** | Said no note was recorded against Earthing, then paraphrased the surrounding text. The note **is** extracted (`readItemSheet` reads column 5 for Characteristics), so this is retrieval or generation, not extraction — unlike the observation-note bug. Worth confirming with `/search generate:false` whether the chunk is retrieved at all. |
| **v3 W05, v2 V35, v3 W07** | A pronoun or a demonstrative in a follow-up ("he", "that one") is resolved inside the data engine, which binds it to the wrong subject. W05's earlier pass was coincidence; both runs name a different wrong engineer. Likely the same root as W07 (a PO number in a follow-up). |
| **v3 Z01** | Wrong item/column: answered about a different check than the one named. Related: the data engine once answered Outer Sheath Thickness with a drum quantity. |
| **v3 R01, R02** | Override handling. R01 understates a rejection (and returned in 4.4 s, so it likely did not retrieve); R02 refuses collaterally — it declines a legitimate part of the question along with the override. |
| **v3 Y03** | A tie at the top reported as a single winner. Arguably cluster A's third shape. |
| **v3 P03, P04** | CORRECT_PREMISE: the false premise is rejected but the correction omits the evidence that makes it a correction. |
| **v1 H18** | **Not a defect.** The answer is correct and cited; the v1 criterion requires a literal word that the old raw field dump contained by accident. Left as-is because v1 is a frozen baseline — do not "fix" the system for this one. |
| **Golden Q22** | Blocked, not failing: an evidence-quote rule the harness cannot satisfy. Leave it. |
| **Golden Q09, Q10, Q33** | Q09 passes but is flagged for a human look (two job ids may be grouped under one ambiguous value). Q10 and Q33 not yet investigated case by case. |

Not yet investigated at all: **v2 V05** beyond the dropped time, **golden Q10,
Q33**. Everything else above has at least a starting point.

---

## Operational notes for whoever runs the harness next

- **Restart the stack before a long run.** The frozen v3 set took 46 min on a
  fresh stack and 100 min as the fourth set of a long run — same questions, same
  answers, median latency doubled. `mistral` (5.6 GB at `CONTEXT 8192`) does not
  fit 4096 MiB of VRAM, Ollama splits it 60% CPU / 40% GPU, and prefill goes
  CPU-bound as uptime grows. It degrades with uptime, not with the question.
  Accuracy is unaffected; a demo an hour in is not.
- **All harnesses need `CACHE_ENABLED=false`.** The repo default is `true` and
  it is currently `true` — set it in the environment for the run, do not commit
  the change.
- Always include `docker-compose.gpu.yml`. The api runs from the built image
  `plutoman-rag:local` with no source mount, so **source edits do not affect a
  running container** — rebuild.
- `eval_runs_2026-11-27/` holds the four run outputs, the v3 harness and
  `pre_reingest_dump.sql` (the 6.7 MB safety point taken before re-ingestion).
  `eval_runs_2026-11-25/` holds the previous round. Both untracked, on purpose.
- The v3 set was re-frozen on 27 Nov after one criterion was found to match
  inside a job id; `heldout3_harness/FROZEN.txt` records the old and new sha1
  and why. **Re-run the grader self-tests after touching any criterion** —
  ideal answers must score 41/41 and junk answers must stay at 5/41. Two whole
  classes of flawed criteria were caught that way before the first run.

## Repository constraints to keep

- **Do not touch `main`.** Work continues on `fix/chat-follow-up-narrowing`.
- **No PR is open yet.** Opening one is the user's call, not a session's.
- The client PDFs in the repo root (`Golden-Evaluation-Q&A-Set.pdf`,
  `Golden_QA_UI_Run_Evidence.pdf`, `Hetzner_Hybrid_Cost_Estimation.pdf`,
  `Regenalytics_SOP_RAG_Hybrid_Hosting_Plan.pdf`) are untracked and stay that
  way without the user's explicit go-ahead. `backups/` is tenant data and is
  never committed.
- The golden harness, the strict grader and the evidence PDF contain the
  client's gold answers and stay out of the repo until the user approves.
- Do not change the UI beyond what the golden document requires without asking.
- Keep config at the repo defaults; the user has asked for parity with the
  GitHub repo rather than local variation.
