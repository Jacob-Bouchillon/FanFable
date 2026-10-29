# FanFable — the evidence-scoring idea

**Date:** 2026-10-29
**Status:** design, detailed. Supersedes the assertion gate as a definition of truth.
**Related:** `SPEC-claim-confidence.md`, `SPEC-kind-labels.md`, `SPEC-evidence-selection.md`.

---

## 1. What went wrong before, in numbers

Three attempts to decide what a relationship is, all in code:

**Closed label list plus synonym lists.** A relationship only banked when its label was on a list of 36, and a noun tie only when the quote contained a word from a hand-written group. Result: 30 accepted rows with 7 adjudicated as real; then, after tightening, 3 accepted with 3 real. The tightening bought precision by throwing away 90% of the rows — and even then, vocabulary the list happened not to include counted for nothing.

**The assertion matcher.** A tie needed both names in one sentence, a tie word, and a possessive, of-phrase, or subject-verb-object pattern. Measured on the test book: of 1,111 rejected candidates, 66% were two names in a list, and only 9.1% of the sweep's quotes named both people. So the matcher rejected scenes correctly, and rejected most real relationships too.

**The vocabulary gate.** A model label outside the list was refused as `open-vocab`. In the live queue that accounted for **5 of 258** notes. It was not the bottleneck; it was just the most visible one.

The common failure: code was being asked to hold a definition of a relationship. Any definition specific enough to reject "Harry and Ron stood in the hall" is also specific enough to reject "he already felt like his best friend".

---

## 2. The idea

**The model judges. The code measures the evidence and applies a threshold the author sets.**

Three roles, cleanly separated:

| Role | Who | What it does |
|---|---|---|
| Judgement | the model | reads the passage, decides whether a relationship is stated or implied, which concept, between which two people, and how strongly each piece of evidence supports it |
| Verification | code | confirms the quote exists in the source, that both entities exist, that they are not the same person, and that no quote is used for everything |
| Decision | the author | one threshold: how sure must the system be before a claim enters the bank |

Nothing in the code knows what "friend" or "loathed" means. Nothing in the model decides what enters the bank by itself.

---

## 3. The claim the model returns

```json
{
  "from": "Harry",
  "to": "Ron",
  "kind": "friend",
  "evidence": "the sentence",
  "anchor": "the sentence naming the other person, when the quote names only one",
  "names_both": false,
  "other_person": "pronoun",
  "directness": "implied",
  "strength": 0.8,
  "why": "one sentence of reasoning"
}
```

- `other_person`: `named` | `pronoun` | `role` | `absent`
- `directness`: `stated` | `implied`
- `strength`: how strongly this quote supports **this concept** for **these two people**. Not a general "closeness" score.
- `why`: stored for audit, never parsed.

The last point matters most: strength is per evidence *and* per concept. A sentence can be near-proof for one concept and weak for another.

| quote | concept | strength |
|---|---|---:|
| "they shared a dormitory" | dormmate | 0.9 |
| "they shared a dormitory" | friend | 0.4 |
| "they were inseparable" | friend | 0.8 |
| "Ron's best friend" | friend | 0.95 |

Sharing a dormitory is a fact about cohabitation. Enemies can be forced to share a dormitory. So it proves `dormmate` almost outright and says only a little about affection.

---

## 4. The scoring algorithm

Deterministic. Operates on the model's structured claims, never on English.

For each pair and concept:

1. **Collect** every quote offered for that pair and concept, each with its strength.
2. **Deduplicate** by sentence. The same line cited twice is one piece of evidence.
3. **Damp catch-alls.** If a single sentence is cited for more than three distinct pairs, halve each of its contributions. This is the measured failure where one broad event or sentence was used to support five unrelated claims; counting finds it, word lists cannot.
4. **Weight independence.** Contributions from different chapters count separately; three lines from one scene are not three independent observations. Implementation: treat distinct chunks as the unit of independence for any weighting that needs it.
5. **Combine** by accumulation, not averaging:

```
score = 1 − Π(1 − sᵢ)
```

Worked examples:

| evidence | strengths | score | at threshold 0.7 |
|---|---|---:|---|
| one thin mention | 0.4 | 0.40 | no |
| two mentions, same scene | 0.4, 0.35 | 0.61 | no |
| two independent | 0.4, 0.8 | 0.88 | yes |
| one explicit statement | 0.95 | 0.95 | yes |
| three weak, damped catch-all | 0.2, 0.2, 0.2 | 0.49 | no |

6. **Calibrate** the score through a table measured on rows already judged blind, then compare to the threshold.

---

## 5. Why calibration is not optional

A model's confidence is an opinion until it is checked. We have blind-labelled rows to check it against:

- 226 gold rows with verdicts,
- 30 human labels (17% supported),
- 30 adjudicated delta rows,
- 78 shared pairs (16.7% supported).

Procedure:

1. take rows whose confidence the model reported;
2. group by band (0.3–0.4, 0.4–0.5, …);
3. compute the observed support rate in each band;
4. compare. If 0.7 rows run at 0.35, the number is decoration.

Where a band is off, apply a fixed correction table — measured once, tested once, stored in one place. Do not argue with the model; record what its numbers are worth.

The same procedure validates the scoring function itself: score the labelled rows with §4 and check whether the combined score separates supported from unsupported better than the raw model confidence. If it doesn't, the algorithm earns nothing and the raw number stands.

---

## 6. Tiers, and what the product shows

| tier | meaning |
|---|---|
| `user_confirmed` | you checked it. Proof-grade. |
| `model_asserted` | the model says so, the quote is real, the calibrated score cleared your threshold |
| `provisional` | below threshold, kept with its score and evidence |
| `rejected` | fabricated quote, unknown entity, or the same person twice |

Answers show provenance: *confirmed by you*, or *the model, 0.78*, with the quote underneath. A reader can see the difference between "the book says" and "the system thinks".

---

## 7. What gets deleted

Deleted, not flag-guarded — two definitions of truth in one codebase is how the last month happened:

- the possessive/of-phrase/SVO assertion matcher;
- reverse-direction enforcement as a promotion condition;
- the concept set as a promotion gate (it stays for labelling and querying);
- `KIN_GROUPS` and the head-word requirement;
- the `kind_source` substitution loophole;
- the `open-vocab` rejection.

One thing survives from the hedge work: a quote that hides a preceding "perhaps" or "not" in its holding sentence is still refused, because that is misquotation, not grammar.

---

## 8. Risks, honestly

**The model's numbers may be noise.** Mitigated by calibration; if they are noise, the algorithm's independent-evidence weighting carries the score and the model contributes judgement of kind and pair only.

**Volume without value.** Unconstrained output runs at roughly one supported relationship in five on the gold set. At a 0.7 threshold the volume should fall sharply — but the first run will tell us whether it falls to 5% of output or 40%.

**Review burden.** More proposals means more queue. The answer is classification by evidence shape (catch-all, single-mention, pronoun-with-anchor) so junk is filtered by shape rather than read row by row.

**Wrong bindings.** The research on dedicated coreference puts the best systems at roughly four in five correct. Storing the anchor exposes the binding; calibration decides whether pronoun-derived scores are reliable enough to bank.

**Silent label drift.** The model may label aversion as `enemy`. Nothing deterministic can see it. The mitigation is the concept descriptions and the measured concept accuracy on the fixed evaluation set.

---

## 9. How we will know it works

Acceptance for the next stage, in order:

1. **Calibration holds.** Predicted bands track observed support within a stated tolerance on the labelled rows.
2. **The algorithm earns its place.** Combined score separates supported from unsupported better than raw model confidence, measured on the same rows.
3. **The yield is real.** On the test book, at 0.7, the number of banked ties and their supported rate — measured by blind adjudication of a sample — beat the current 24 confirmed / 1 accepted.
4. **Junk is identifiable.** The dominant failure shapes are enumerated with counts, not anecdotes.
5. **Nothing fabricated survives.** No row with a non-existent quote, directly or through a tampered anchor.

If (1) or (2) fails, stop and reconsider before touching the bank.

---

## 10. Implementation order

1. Model assessment fields in the relations prompt and storage (`confidence`, assessment JSON in `supporting_evidence`, `kind_source` kept, no migration).
2. Guard reduced to the four mechanical checks.
3. Scoring function as a pure module, unit-tested on synthetic evidence sets.
4. Calibration script over the labelled rows; publish the table.
5. Threshold as a project setting, default 0.7.
6. Extraction run on a copy of the test book; report banked counts at 0.7.
7. Blind adjudication of a sample of banked rows.

Steps 3 and 4 can be built before any prompt change, and measured on existing rows.

---

## 11. Open questions

- Should association concepts (`dormmate`, `classmate`) share the same threshold as affection and kinship, or have their own? A dormmate claim is cheap to prove and says less.
- Does the model give better strengths when asked per evidence item, or when asked for one overall number and allowed to reason first?
- Should catch-all damping be a fixed multiplier or scale with how many pairs cite the sentence?
- Do repeated mentions across chapters deserve more than the product formula gives them?

Each is answerable with a measurement, not a preference.
