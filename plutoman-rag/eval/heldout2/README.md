# Held-out evaluation set v2

A second independent set of 36 cases, written the same way as
[v1](../heldout/README.md): a separate agent worked from the raw PDF text only,
with no access to code, index or results, and avoided every golden-set and v1
question. It was frozen by sha1 before any run (`FROZEN.txt`); its criteria
were reviewed and none changed.

It was written to check the round-6 changes, which were made while looking at
golden-set cases. **Do not tune the pipeline against it.**

Run and grade exactly as for v1:

```bash
python run_heldout.py runs/my_run.json http://localhost:3000
python grade_heldout.py runs/my_run.json --show
```

## Results, 12 Oct 2026

Local Ollama `mistral` 7B, Ollama restarted before each run.

| Version | Content | Strict (no wrong-report citation) |
|---|---|---|
| Before round 6 (tag `pre-round-6`) | 25 / 36 | 24 / 36 |
| **Round 6 (current)** | **27 / 36** | **26 / 36** |

- **Gained:**
  - **V15**, a dispatch decision contradicted by the report's own failures.
    This is the round-6 conflict rule working on a question it was not
    written for.
  - **V08**, a count.
- **Lost:** none.

Still failing, found by reading the answers:

| Case | What went wrong |
|---|---|
| V14 | "free to leave the factory" is not recognised as a dispatch question, so no decision list ran and the answer was a flat yes. The model also wrote "[Citations: S1, S2 …]", a marker format the renderer does not handle |
| V16 | reports the conflict and the failed tests, but leaves out "Technical Clearance: Yes" and the "Minor observations" wording the case asks for |
