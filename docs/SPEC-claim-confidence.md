# Spec — model-assessed claims with a confidence threshold

**Date:** 2026-10-29
**Status:** design; implementation queued behind the kind-label change
**Supersedes:** the assertion gate as a definition of truth.

---

## 1. Principle

The model reads the passage and assesses the claim. The code records what it claimed, refuses fabrications, and applies a threshold that the author sets. The code contains no theory of what a true relationship looks like.

The only things code certifies:

1. the quoted words exist in the cited source;
2. both entities exist in the roster;
3. they are not the same person.

Everything else — whether the sentence says it, whether "him" is Ron, which concept fits, how sure it is — is the model's judgement, recorded with the claim.

---

## 2. Output the model returns

Per relation:

```json
{
  "from": "Harry",
  "to": "Ron",
  "kind": "friend",
  "kind_source": "the words that express it",
  "evidence": "the sentence",
  "anchor": "the sentence naming the other person, when the quote names only one",
  "names_both": false,
  "asserted": true,
  "other_person": "pronoun",
  "directness": "implied",
  "confidence": 0.7,
  "why": "one sentence of reasoning"
}
```

- `other_person`: `named` | `pronoun` | `role` | `absent`.
- `directness`: `stated` | `implied`.
- `confidence`: the model's own estimate that the passage establishes this relation between these two people.
- `why`: free text, stored for audit, never parsed.

---

## 3. What the code does

- Verifies the quote and the anchor are verbatim in the cited passage; a claim that cites nothing is stored as `unsupported-citation`, not dropped silently.
- Resolves entities; unresolved names are reported, never guessed.
- Records the whole assessment as provenance.
- Computes the tier from the threshold (§5).
- No grammar checks, no noun lists, no both-names requirement, no direction heuristic. Direction is whatever `from`/`to` the model gives; a symmetric concept stores one pair.

---

## 4. Calibration, not trust

Self-reported confidence is only useful if it means something. Before it decides anything, measure it:

- take the labelled rows already judged blind (226 gold rows, 30 human labels, 30 delta rows, 78 shared pairs);
- group by predicted confidence band (0.5–0.6, 0.6–0.7, …);
- compute the observed support rate per band.

If a band runs far below its prediction, apply a fixed correction table — measure the mapping, don't argue with the model. The correction lives in one place and is itself tested.

---

## 5. Threshold

One setting, per project: minimum confidence to bank a model claim. Suggested default 0.7, exposed so it can move.

- at or above → `model_asserted`
- below → stays in the review queue
- author confirmation → `user_confirmed`, regardless of score

The answer surface shows provenance: *model, 0.72* versus *confirmed by you*.

---

## 6. What this replaces

- the assertion matcher and its possessive/of/SVO patterns;
- the closed-label gate as a promotion condition (labels stay a set for queryability, not a proof test);
- the `kind_source`-as-substitution loophole;
- `KIN_GROUPS`;
- the direction heuristic that treated unknown as passing.

Deleted, not disabled: leaving them in as fallbacks would keep two definitions of truth in the code.

---

## 7. Tests

- a claim whose quote is not in the source is recorded as `unsupported-citation` and never banked;
- a claim with `confidence` below the threshold stays in the queue; above it, banked;
- the same claim with author confirmation is `user_confirmed` even below threshold;
- a pronoun-bound claim with an anchor is banked at its score, with the anchor stored;
- calibration: a fixed fixture of predicted-vs-observed bands maps to the correction table;
- no grammar rule can veto a claim that clears the threshold, and no threshold can rescue a fabricated quote.

## 8. Order

1. Add the assessment fields to the relations prompt and the storage.
2. Reduce the guard to the three mechanical checks.
3. Calibrate on the labelled rows; publish the table.
4. Expose the threshold; wire tiers and the answer surface.
5. Re-measure: how many ties at 0.7, and their measured support rate.
