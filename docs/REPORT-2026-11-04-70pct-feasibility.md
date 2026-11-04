# Why 70% keeper precision is not reachable on the current books — measured, 2026-11-04

Counts only. No passage prose. Disposable copies only; live banks untouched.

## Question

Can the pipeline produce keeper-grade ties at >= 70% blind precision on the available books (HP1, Gatsby) with the current proof doctrine (both endpoints named in the cited evidence)?

## Answer

No. Not with any reader, prompt, gate strictness, or judge tested. The limiting factor is the proof unit itself: books rarely name both endpoints in one sentence or one chunk.

## Measurements

| Experiment | n | Result |
|---|---|---|
| Old keepers, sentence-proof (NuExtract, 3-vote) | 20 | 1 supported (0.05; Wilson 0.009-0.236) |
| Old keepers, passage-proof (same) | 20 | 6 supported (0.30; 0.145-0.519) |
| Old keepers re-evidenced mechanically, passage-proof | 20 | 6 supported (same set) |
| Machine-cut both-names sentences (HP1), loose ask | 60 | 32 supported (0.53; 0.409-0.654) |
| Machine-cut both-names sentences (HP1), strict ask | 60 | 3 supported (0.05; 0.017-0.137) |
| Fresh extraction, HP1, qwen3.5:9b, 11 windows | 31 candidates | 0 keepers |
| Fresh extraction, HP1, Spark, 1 window | 2 candidates | 0 keepers |
| Fresh extraction, Gatsby, default prompt, 10 windows | 19 candidates | 0 keepers |
| Fresh extraction, Gatsby, strict prompt, 10 windows | 8 candidates | 0 keepers |
| Fresh extraction, Gatsby, strict + locate-don't-reject, 10 windows | 8 candidates | 0 keepers |

## The mechanism, isolated

For 8 Gatsby candidates the retry asked the reader for a sentence naming both endpoints:

- whole-book both-names sentences found: 3 of 8 pairs had exactly 1; 5 of 8 had 0.
- within-window both-names sentences: 0 of 8.
- in the cited chunk: 0.

Gatsby windows emit 16 notes/window, so the reader is discovering pairs. The evidence does not name both people because the prose uses pronouns and descriptions once a scene establishes names. No mechanical "locate" can recover a sentence that does not exist; no judge can verify a tie the citation does not state.

## What does move the number

- Changing the question: sentence -> passage raised 0.05 -> 0.30 on identical rows; loose "supports-or-suggests" raised 0.05 -> 0.53 on identical rows. Both remain below 0.70, and the loose ask banks implication rather than statement, which the doctrine refuses.
- Gate strictness: two tightening cycles moved judged precision by 0.0.
- Gate ablation (336 frozen rows): baseline admits 5; four of five switches move zero rows; direction moves one row, which a calibrated judge supports. The gate is redundant, not wrong. Threshold is vacuous on that bank (all confidences >= 0.7).
- Reader substitution: two readers, same zero keepers on the same window.

## Consequence

Automatic keeper-grade ties at 70% precision require evidence that names both endpoints. On these books that evidence exists for a small minority of true pairs. The remaining gap is coreference (pronoun/description -> named person), which four prior approaches failed to clear (BookNLP small/big, fastcoref, pairwise model) and which this session did not re-test.

The viable paths, with measured inputs:

1. **Human confirmation as the keeper step** — the only tier that ever held true ties at volume (34 user-confirmed rows in the trial bank). Machine output feeds a ranked, evidence-backed queue; the operator's ruling defines truth. Precision is 100% by construction; cost is operator time.
2. **Loose candidate triage** — 53% of machine-cut both-names sentences are at least "supported or suggested" under a calibrated judge. Useful as a queue ranker; not keeper-grade proof.
3. **Coreference stage** — the only route to automatic recall on these books. Must clear the documented bars (>= 40% of descriptions resolved, >= 85% correct on 40 blind joins) before it touches the bank. Not attempted here.

## Implementation state

- Locate-don't-reject retry added and tested (converts nothing on these books because the target sentence is absent; correct for books that paraphrase-and-state).
- Strict symmetric gate, regather v1/v2, passage judging, calibration controls, ablation switches, machine-cut cutter + judge, all committed and pushed.
- Full suite 1,489/1,489, typecheck 0, diff clean.
