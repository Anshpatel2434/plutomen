# Held-out evaluation set

36 test cases over the 11 demo reports, written **independently of the
pipeline's development**, to check whether results on the client's golden set
carry over to questions the pipeline was not tuned on.

**Do not tune the pipeline against this set.** Once a change is made because
of a case here, the set no longer measures anything; write a new one instead.

## How it was made

- A separate agent with no access to the source code, the golden-set runs or
  the pipeline's index wrote the cases from the **raw PDF text** of the reports
  (plain text extraction, page by page, with printed page numbers). Every fact
  was checked against that text. Facts for "not recorded" cases were searched
  for to confirm they are absent.
- Mix, like the golden set:
  - 20 ANSWER, plus 3 multi-turn;
  - 3 CLARIFY;
  - 5 ABSTAIN;
  - 3 CORRECT_PREMISE;
  - 2 REFUSE_OVERRIDE.
- No case asks about the same item in the same report as a golden-set
  question.
- Before any run, the criteria were reviewed and four were loosened or
  tightened (each case's `review_note` says how). Then the file was frozen:
  `FROZEN.txt` holds its sha1, and `run_heldout.py` refuses to run if the set
  has changed.

## Run and grade

The API must run with `CACHE_ENABLED=false` and `DEV_MODE=true` (the runner
mints a demo token).

```bash
python run_heldout.py runs/my_run.json http://localhost:3000
python grade_heldout.py runs/my_run.json --show
```

- **content:** every `must_include` group matches (OR within a group) and no
  `must_not_include` string appears. Matching is case-insensitive, with
  whitespace collapsed and dashes unified.
- **strict:** content, and no citation of a report outside `gold_sources` +
  `allowed_extra_sources`. The golden set scores a wrong-document citation as
  a fail.

## Results, 12 Oct 2026

Local Ollama `mistral` 7B, the same index for all runs, Ollama restarted
before each run (14.6–15.3 tokens/s). Raw answers are in `runs/`.

| Version | Content | Strict | Mean latency |
|---|---|---|---|
| Before changes 4 + 9 (tag `pre-eval-4-9`) | 24 / 36 (67 %) | 24 / 36 | 11.2 s |
| Change 4 only (`VERIFY_ANSWERS=false`) | 25 / 36 | 24 / 36 | 10.4 s |
| **Changes 4 + 9 (current)** | **27 / 36 (75 %)** | **26 / 36** | 13.7 s |

For comparison, the same change on the golden set went from 25/40 to 39/40.
**Most of that gain came from tuning on those 40 questions; on new questions
the gain is about +3 cases.**

What did carry over:
- Counting and listing questions (H11, H12) went from fail to pass. This is
  change 4's complete lists.
- H06 and H31 also improved.
- All ABSTAIN and CLARIFY cases pass in every version.

Changed for the worse: **H07**. Change 9's "related observation" check matched
an unrelated calibration note ("coating thickness gauge") and the retry dropped
"accepted".

Remaining failures (current version), from a manual review of the answers:

| Case | What went wrong | Kind |
|---|---|---|
| H07 | related-observation check over-matched (see above) | change 9 regression |
| H08 | gives "Not Ok" but drops the note "insulator qty short"; the check enforces bare results, not notes | check gap |
| H10 | "25 Nos offered" should pick one of 6 reports; report picking runs only up to 4 reports | change 4 limit |
| H14 | "offered quantity" does not match the item title "Offered Qty", so there is no complete list and the model says it is not recorded | vocabulary (abbreviations) |
| H17 | reports both sides of the conflict but says "cleared to go to site", not "release/acceptable" | borderline grader strictness |
| H18 | correct (dispatchable, subject to rectification), but lacks the word "cleared" | grader false negative |
| H30 | says no rework is recorded, but does not correct the false premise that there was damage | premise correction |
| H31 | content right, but also cites the other Polycab report: "5-drum" does not match "5 Drums" | change 4 limit (strict fail only) |
| H33 | refuses the whole question instead of answering the legitimate part (45.0 mm) | refusal too broad |
| H35 | multi-turn: "that one" resolved to the wrong report | multi-turn |

Counting H18 as a pass, and H17 as half, the current version is at roughly
28/36 (78 %). The frozen score of 27/36 is the official number.
