# Pending Work & Client Questions — before Phase 4

This tracks everything still owed to **complete Phase A (Legs 1 & 2)** per the Project Nexus proposal, plus inputs/questions we need from Plutomen. **Phase 4 (multimodal, Leg 3) does not start until this list is cleared.**

Context worth remembering: several items below are Phase-A commitments we hadn't built because we went ahead into production-hardening (Phases 2–3) — which the proposal explicitly *deferred*. So this list is the "circle back and finish the core POC" work.

---

## A. Pending build tasks (Phase A completion)

| # | Task | Proposal ref | Status |
|---|------|--------------|--------|
| 1 | **Conversation memory** — multi-turn chat with context retention (sessions, message history, history-aware query rewriting, chat UI) | Phase A scope, p2 | ✅ **Built & verified** — `/chat` + sessions + condense; chat UI; RLS-isolated; 2-turn context retention proven live ("what about the cables?" → answered about cables) |
| 2 | **Verification / anti-hallucination step** — check the generated answer against retrieved chunks; suppress unsupported claims | §5.2 | ⬜ Pending |
| 3 | **Graceful fallback** — when no confident match, return a helpful fallback + proactive suggestions (not empty, not an unverified answer) | §4.3 | ⬜ Pending |
| 4 | **Multi-format ingestion** — PDF, TXT, and text extracted from XLS/CSV (the real free-form Document Library) | Leg 2, §5.1 | ⬜ Pending — **real PDF reports now in `demo_data/POID-*.pdf`** (11, text-extractable, no OCR) → build/test the PDF parser against these, not synthetic |
| 5 | **SOP Section→Step ingestion** — parse SOP documents as trees (we've only done inspection checklists so far) | Leg 1, §5.1 | ⬜ Pending — the new PDFs are *reports, not SOPs*; still need synthetic SOPs (or real ones from client) for the Section→Step tree |
| 6 | **Prose chunking with overlap** — semantically coherent units for prose SOPs/PDFs (current chunker is one-row-atomic) | §5.1 | ⬜ Pending |
| 7 | **Parent-context (tree) retrieval** — return a step *in its parent Section context*, not a floating chunk | Leg 1 | ⬜ Pending |
| 8 | **Reranker** — replace the identity-stub with a real cross-encoder (e.g. `mxbai-rerank`, non-Chinese) | §5.2 | ⬜ Pending (stub exists) |
| 9 | **Citation polish** — clean human-readable doc refs + step-level `[SOP-102, Section 4, Step 2.1]` | Phase A scope | ⬜ Pending |
| 10 | **Evaluation harness** — measure grounding / fallback relevance / latency against a labelled set | §5.5 | ⬜ Pending (needs eval set from client) |

### Already done that was NOT required for Phase A (deferred production items — ahead of schedule)
Multi-tenant isolation + RLS, ACL/tenant defense-in-depth, rate limiting, token/usage metering, PgBouncer pooling, read replica, isolation hardening, the Angular demo UI. *(Explicitly "out of scope for Phase A" per proposal p2 — kept for the production engagement.)*

---

## B. Open questions / inputs needed from Plutomen

| # | Question / input needed | Why it matters | Ref |
|---|-------------------------|----------------|-----|
| 1 | **Real SOP procedure documents** (Section→Step) + broader library docs (TXT, etc.) | We now have inspection reports in XLSX **and PDF**, but still **no SOPs** — Leg 1's SOP-tree side can't be truly tested without them | proposal p2 |
| 1b | **Actual inspection evidence photos / video** | The PDF "images" are just a decorative logo — there's no real visual evidence yet, which Leg 3 (Phase B) needs | Leg 3 |
| 1c | **Preferred format per report** — XLSX vs PDF? | The PDFs duplicate the XLSX (same inspections); the real corpus should ingest one format per report to avoid double-counting | — |
| 2 | **The 8–10 real acceptance questions** | Defines what "working" means; needed to demo + accept Legs 1 & 2 | proposal p2 |
| 3 | **A jointly-defined labelled evaluation set** | To *measure* (not assert) ≥99% grounding, ≥85% fallback relevance, latency | §5.5 |
| 4 | **Expected volume & concurrency** (tenants, docs/tenant, peak q/s) | Sizes Postgres, replicas, and the generation-LLM GPU footprint | §5.5 (assumed for now) |
| 5 | **Does the data adapter emit full CRUD** (create/update/**delete**)? | Deletes must propagate so withdrawn reports never surface (compliance) | — |
| 6 | **Generation model tier** — Mistral (cheaper GPU) vs Llama-3.3-70B (max quality)? | Cost vs answer quality; drives GPU sizing | §5.5 (assumed Mistral) |
| 7 | **Data-residency / region** for the self-hosted models | Confirms open-source self-hosting satisfies their compliance | — |
| 8 | **Latency vs rigour trade-off** — the verification step adds latency vs the ≤3s P95 target | Proposal itself flags this tension; needs joint calibration | §5.5 |

---

## Status note
- **Phases 1–3** (foundation, scale hardening, isolation hardening) — ✅ built & verified.
- **This list** — Phase A completion, in progress (item 1 first).
- **Phase 4** (multimodal / Leg 3) — blocked until this list clears.

---

## C. Answer-quality defects found by evaluation — see `plutoman-rag/OPEN_DEFECTS.md`

Separate axis from the scope table above: these are defects in behaviour we have
*already built*, found by running 153 questions against the system. The register
is **[plutoman-rag/OPEN_DEFECTS.md](plutoman-rag/OPEN_DEFECTS.md)** — start
there rather than here, it carries the diagnosis for each case and what has
already been ruled out.

Current standing after the 27 Nov run (branch `fix/chat-follow-up-narrowing`):
113/152 scorable — golden 30/39, held-out v1 29/36, v2 27/36, v3 27/41. Measured
in `plutoman-rag/EVAL_2026-11-27.md`.

Thirty-nine failures, but they are not thirty-nine defects — five clusters cover
thirty-one of them:

| | Cluster | Cases |
|---|---|---|
| **Blocking** | The prompt-injection refusal leaks `system instructions:` (golden Q40) — a safety case, should block a client hand-off | 1 |
| A | A self-contradicting report is reported one-sidedly; `outcomeConflict` is computed and never used | 9 |
| B | A list is right but its tally or its exclusivity is missing, or the count is too low | 5 |
| C | CLARIFY does not trigger when a vendor has several reports | 5 |
| D | The data engine returns a raw column dump where prose was wanted | 3 |
| E | One detail dropped from an otherwise correct answer (the time, the PO date) | 4 |

One regression is ours and is recorded as such: `b29bc14` fixed observation
notes being dropped entirely, and in doing so gave v2 V31 a lexical distractor.
Right verdict, wrong evidence. Do not fix it by dropping notes again.
