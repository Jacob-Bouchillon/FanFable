# Confidence calibration — the published table

`HOW-IT-WORKS.md` §4 promised a published calibration table and a re-measurement at
threshold. This is that table. It records what was measured, and it says plainly
what the numbers mean, because the result is not what the design hoped for.

**Measured 2026-10-29** from `testing/trials/claim-confidence/claim-confidence-calibration.json`.
Published 2026-11-13; this is a new document, no earlier measurement was rewritten.
Counts only — no pairs, names or passage text.

## What was measured

The model's own confidence for a relation, grouped into bands, against whether the
row's evidence actually supported the claim in the labelled set. "Supported" is the
label, not a re-judgement: gold rows are the blind-labelled ones.

| source | labelled | joined |
|---|---|---|
| gold | 226 | 42 |
| human | 30 | 30 |
| delta | 30 | 14 |

86 rows joined in total; 16 failed to join. 54 carried an assessment; 48 were
legacy rows without one.

## The table

Gold rows, the blind-labelled set the design was tuned against:

| band | n | predicted | observed support | supported |
|---|---|---|---|---|
| < 0.5 | 8 | 0.050 | 0.000 | 0 |
| 0.5–0.6 | 1 | 0.500 | 0.000 | 0 |
| 0.8–0.9 | 1 | 0.850 | 0.000 | 0 |
| 0.9–1.0 | 32 | 0.984 | **0.250** | 8 |

All sources combined:

| band | n | predicted | observed support | supported |
|---|---|---|---|---|
| < 0.5 | 24 | 0.054 | **0.125** | 3 |
| 0.5–0.6 | 2 | 0.500 | 0.000 | 0 |
| 0.8–0.9 | 5 | 0.850 | **0.600** | 3 |
| 0.9–1.0 | 55 | 0.981 | **0.255** | 14 |

Rows with an assessment, excluding legacy:

| band | n | predicted | observed support | supported |
|---|---|---|---|---|
| < 0.5 | 24 | 0.054 | 0.125 | 3 |
| 0.5–0.6 | 2 | 0.500 | 0.000 | 0 |
| 0.8–0.9 | 5 | 0.850 | 0.600 | 3 |
| 0.9–1.0 | 23 | 0.954 | 0.174 | 4 |

## What it means

**The confidence score does not order these rows.** Where the model says 0.95–1.0,
one row in four is supported; where it says below 0.5, one in eight is. The
highest-confidence band is not the most accurate band. A correction table built by
"where a band lies, apply a fixed correction" would therefore be fitting noise:
there is no monotonic relationship to correct.

This matters for a promise the design makes to the author. Answers are labelled
*the model, 0.78* as though the number said something about reliability. On this
evidence it does not. Two honest options follow:

1. **Stop showing the number.** Keep provenance phrasing to the tier and the quote,
   and show a score only where a measured band justifies it.
2. **Keep the number but re-derive it** from evidence shape — how many independent
   passages, whether both endpoints are named, whether the quote states the tie —
   which the combination rule already computes, rather than from the model's own
   estimate.

The combination formula (`1 − Π(1 − sᵢ)`) is a separate question and is not answered
here; it was specified but not compared against raw confidence on these same rows in
this measurement.

## Caveats

- **Small n.** 55 rows in the largest band table, 42 in the gold one. A band with
  n=1 or n=2 cannot support a conclusion; those rows are shown for completeness.
- **Hard cases only.** The 42 gold rows are the deliberately difficult pairs, not a
  random sample of the bank. A random sample is the next measurement, and
  `WHATS-NEXT.md` item 4 describes how to take it.
- **Nothing is applied in code.** `fanfable/src` contains no calibration table and
  no correction step; `claimTier` compares the raw score to `minConfidence`
  directly. The threshold therefore selects on a number whose ordering is, on this
  evidence, uninformative.
- **Labels are a hypothesis.** Past passes found verdicts reasoned from outside
  knowledge against instructions, so the gold labels themselves carry known defects.

## What would change the conclusion

A re-measurement on a random sample of a whole book, with the relation id stored on
every row, and enough rows per band to separate 0.25 from 0.60. Until that exists,
this table is the best evidence available and it argues against displaying the score
as if it were a probability.
