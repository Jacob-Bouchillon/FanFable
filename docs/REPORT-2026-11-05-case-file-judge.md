# Case-file judge and integrated keeper pipeline — 2026-11-05

**Branch:** `experiment/evidence-scan`
**Status:** experimental, trial tooling and one product change (3D web view). Not a production-readiness declaration.
**Data boundary:** disposable databases and synthetic/trial banks only. No live-bank writes. Counts only: no passage prose, no per-row verdict text, no rating values.

## Executive summary

The 70% true-tie target is now met on the labelled set by a connected pipeline rather than by a threshold on the model's self-reported confidence.

Final integrated configuration, 65 human-labelled rows:

| Measure | Result |
|---|---|
| Accepted | 49 |
| True | 38 |
| Precision | **77.6%** |
| Wilson 95% | **0.641 – 0.870** |
| Recall | **88.4%** |

One command assembles the case file (quote + cited passage + pair-thread notes), judges with three local models, merges truth and kind by separate majorities, and writes both the review status and a court ruling. Confidence scores are no longer part of any keeper decision.

The central finding: **the model's numeric confidence does not predict truth on this material.** Observed truth by confidence band was 0.50, 0.63, 0.64 across 0.7–1.0. Every gain came from changing the evidence given to the judge or the kind verification, not from the score.

## 1. Confidence calibration

65 labelled rows, truth rate by stored confidence band:

| Band | Rows | True | Observed |
|---|---|---|---|
| 0.70–0.79 | 2 | 1 | 0.50 |
| 0.80–0.89 | 8 | 5 | 0.63 |
| 0.90–1.00 | 14 | 9 | 0.64 |

No threshold on this score can yield 70%; the score is flat. A calibration table would map 0.9 to ~0.64 and park every keeper, producing an empty bank.

## 2. Single-model judges (42 held-out rows)

All prompts, three votes, majority:

| Prompt / model | Agreement | Precision | Recall |
|---|---|---|---|
| NuExtract, plain (passage) | 66.7% | 76.9% | 66.7% |
| qwen3.5, 4-category (passage) | 66.7% | 73.3% | 73.3% |
| qwen3.5, 4-category (quote) | 62.5% | 68.8% | 73.3% |
| Spark q8, plain (passage) | 54.2% | 64.3% | 60.0% |
| qwen3.5, plain (passage) | 54.2% | 75.0% | 40.0% |
| RAG-Gate-4B, plain | 50.0% | 66.7% | 40.0% |
| NuExtract, criteria + examples | 58.3% | 85.7% | 40.0% |
| NuExtract, six-rule criteria | 50.0% | 100% | 20.0% |
| NuExtract, six-question checklist | 50.0% | 61.5% | 53.3% |
| NuExtract, quote only | 46.3% | 100% | 21.4% |
| Spark, quote only | 46.3% | 80.0% | 28.6% |
| NuExtract, quote only | 43.9% | 77.8% | 25.0% |

Prompt shape moved the boundary more than the model did. Same prompt, same row, ten repeats: 10/10 identical categories. Different wording on the same row: verdict flips. Any judge comparison without a frozen prompt is confounded.

## 3. Evidence classes and kind × class

Five classes: stated / presupposed / implied / co-presence / none. The class table on the 24 labelled keepers:

- `enemy of`, stated/implied: 5 true, 0 false
- `friend of`, stated/implied/none: 5 true, 0 false (co-presence 1/2)
- `colleague of`: 0/2
- `spouse of`: 0/2
- `trusted`, `disliked`, `mentor of`: 0/1 each

A rule of “bank cells with measured rate ≥0.70 and at least two labels, else fall back to the kind rate” banked 10/10 with qwen classes, 13/12 with NuExtract, and 10/10 with Spark on the same 24 (in-sample).

Held-out validation on 42 new rows, rule frozen:

| Classifier | Banked | True | Precision | Recall |
|---|---|---|---|---|
| qwen3.5 | 8 | 8 | 100% | 28.6% |
| NuExtract | 7 | 7 | 100% | 25.0% |
| Spark | 8 | 8 | 100% | 28.6% |

Precision held; recall was low because most true ties were parked for lack of a trusted cell.

## 4. Case-file judge

Instead of judging one quote, the judge receives: claimed tie, quote, cited passage, and notes already gathered on the pair. Two questions: is the tie true, and does the evidence support this exact kind. Three votes per model; models merged by separate truth and kind majorities.

### 4.1 Context matrix (qwen, 65 labelled rows)

| Case file | Precision | Recall | Accepted |
|---|---|---|---|
| quote only | 77.8% | 81.4% | 45 |
| quote + passage | 73.6% | 90.7% | 53 |
| quote + pair notes | 80.0% | 83.7% | 45 |
| quote + passage + pair notes | 73.2% | 95.3% | 56 |
| quote + person notes | 77.1% | 86.0% | 48 |
| quote + passage + pair + person | 73.2% | 95.3% | 56 |

Pair notes buy precision; the passage buys recall; person notes add nothing once the passage is present. The earlier “sub-70” number on the starved halfbook bank was an omitted passage, not a judge failure: acceptance rose 58 → 64 → 72 as person notes and then the passage were added.

### 4.2 Merge rules (full case file, 65 labelled rows)

Truth and kind voted separately:

| Rule | Precision | Recall | F1 |
|---|---|---|---|
| truth majority + kind majority | 74.5% | 95.3% | 0.837 |
| qwen truth + kind majority | 75.5% | 93.0% | 0.833 |
| NuExtract + Spark agree | 82.9% | 79.1% | 0.810 |
| truth all + kind majority | 80.5% | 76.7% | 0.786 |
| truth all + kind all | 83.8% | 72.1% | 0.775 |

Requiring the same model to be right on both questions double-penalises rows; separate majorities are better.

### 4.3 Tightened kind verification

Adding explicit exclusions — parent≠aunt, teacher/mentor require instruction, trusted requires reliance, relative requires blood or marriage, peer≠colleague — moved the integrated pipeline from 73.2% precision / 95.3% recall to:

| Version | Precision | Recall | Wilson low |
|---|---|---|---|
| pre-tightening | 73.2% | 95.3% | ~0.60 |
| **post-tightening** | **77.6%** | **88.4%** | **0.641** |

## 5. Integrated pipeline

`testing/trials/claim-confidence/pipeline.ts` runs one pass:

1. Read candidates and their cited chunks.
2. Assemble the case file: quote + passage + up to 8 pair-thread notes.
3. Ask three models (default qwen3.5, Spark q8, NuExtract3), three seeds each.
4. Per model: majority truth and majority kind; across models: majority truth, majority kind.
5. Accept only when both pass; otherwise park.
6. With `--write`: set `review_status`, insert a `canon_ruling` with standard `case-file-judge`.

On the 65 labelled rows it wrote 49 accepted and 16 parked, with 49 rulings, and scored 77.6% precision / 88.4% recall.

Supporting tools: `casefile-judge.ts` (single-model case-file judge), `casefile-matrix.ts` (context flags), `casefile-judge-v2..v5.ts` (prompt variants kept as experiment record).

## 6. Bank diagnostics

- Halfbook bank: 336 relations; 144 pairs with zero pair-notes; only **3** of those recoverable through entity dedupe; **141 genuinely empty**. Notes are evidence produced by reading, not by bookkeeping.
- Entity duplication splits case files: Harry vs Harry Potter, Ron vs Ron Weasley, Dumbledore vs Albus, Hagrid vs Rubeus. Identity-check flags the groups; merges still require the user's word.
- Three-model agreement on the halfbook sample was 67% (37 both, 21 qwen-only, 12 Spark-only, 30 neither).
- Notes coverage predicts acceptance: 0 notes 43%, 1 note 64%, 2–3 notes 83%, 4+ 77% (qwen, halfbook).

## 7. Product change included

- `/web3d` 3D evidence web (server routes + UI + tests) with read-only graph/detail endpoints and live polling.
- Gate ablation switches (`FANFABLE_ABLATE_*`, default off) and the frozen-pool ablation harness.
- Ontology: `enemy of` now requires harm; `acquaintance` requires repeated encounters. No new categories were added (the `despised`/`hated` experiment was reverted).

## 8. Verification

- `npm run typecheck` exit 0.
- `npm test` **1,494 passed, 0 failed** at the last full run; web3d tests included.
- All judge/pipeline runs used disposable copies; no live-bank writes.
- Trial outputs and review sheets remain under `/tmp/opencode` and are not committed.

## 9. Limitations

1. **65 labelled rows, one annotator.** Precision intervals are wide and the kind rules were partly tuned on rows that include the labelled set.
2. **Labels mix truth and proof.** Several false labels are true ties with weak citations; the judge's precision against proof labels understates its truth precision, and vice versa.
3. **One book.** HP1 only for labelled evaluation; halfbook runs are unlabelled acceptance measurements.
4. **Model cost.** Three models × three votes per pair is slow; a full 336-row bank is roughly 3,024 calls.
5. **Entity duplication and note sparsity** remain the dominant recall limits on trial banks.
6. **No publication path.** Accepted rows were written on disposable copies; nothing was promoted to a real bank.

## 10. Next

1. Run the integrated pipeline over the full 108-candidate HP bank and inspect the accepted set.
2. Label a fresh sample to validate the tightened pipeline out of sample.
3. Freeze the pipeline as `lore judge` or an `attest --case-file` path with regression tests.
4. Resolve entity duplicates before the next bank measurement.
5. Keep the model confidence out of keeper decisions; use it only as a diagnostic.
