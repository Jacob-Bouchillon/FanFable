# Session report — assertion guard, anchored evidence, and the name sweep

**Date:** 2026-10-29
**Branch:** `experiment/evidence-scan`
**Tests:** 519 passing, `tsc` clean
**Books:** two novels used for the gold set; three more imported for sampling

---

## 1. What changed in the code

### 1.1 Assertion is now required for every accepted tie

`assertsRelationship()` checks that the sentence links the two named people through the kind's head noun or one of its glossary phrasings — possessive ("Dudley's aunt"), of-phrase ("the aunt of Tor"), subject-verb-object ("Tor mentored Mara"), active voice only.

Before this, a sentence containing both names and a kinship word passsed regardless of whether it said anything about the pair. That was 60% of the false positives in the labelled sample.

### 1.2 Whole-word phrase matching

`isUnsupportedKind()` matched gloss phrases as substrings, so "kin" matched "looking", "asking", "working". It now matches whole words with normal inflections ("mentored" for mentor).

Effect on the gold set: precision 28.6% → 36.4% with recall unchanged.

### 1.3 Anchor evidence

New column `canon_relation.anchor_evidence` (migration 18). The reader may return the sentence that asserts the tie when the quote is context only. The guard runs the assertion test on the anchor, or on the quote — never on the two together, so an anchor that merely names both people cannot manufacture a tie.

### 1.4 Anchored candidate generator

`scanAnchoredCandidates()` finds sentences that name one character, contain a relationship word and a pronoun, and pairs them with the neighbouring sentence that names the other. Books A and B yielded 89 and 67 candidates respectively.

### 1.5 Strict mode on the gold set

Requiring the link unconditionally (no fallback when the kind's own word is absent):

| rule | kept | true kept | precision | recall |
|---|---:|---:|---:|---:|
| before | 15 | 4 | 36% | 50% |
| strict | 1 | 1 | 100% (n=1) | 12.5% |

The bank becomes pure and nearly empty. The seven true ties lost name the anchor coverage still missing: pronoun possessives ("his Master"), wider "with" phrases, and kin-group nouns ("clan father" for parent-of).

---

## 2. Gold set

226 rows judged blind by fresh sessions: 42 rows the system had accepted, 184 candidates it never banked.

| group | n | supported | context-dependent | rate |
|---|---:|---:|---:|---:|
| accepted | 42 | 8 | 2 | 19% |
| candidates | 184 | 18 | 11 | 9.8% |

Three independent readings agree on ~17–23% precision for accepted rows: the human labels (5/30), the blind judge on 42 (7/42), and the gold set (8/42). The guard discriminates, but only about 2×.

---

## 3. Anchored scan

156 anchored candidates across both books; the reader accepted 57 (35–45% of candidates). A blind pass over all 57 found **13 supported (23%)**, 2 context-dependent.

Same band as everything else. The generator was not the bottleneck.

---

## 4. The cloud read (development tool)

A fresh session with a 1M-token context read the whole of one novel in one pass: 56,000 words, about 80k tokens, roughly five cents.

- 34 characters with aliases
- 28 relationships, 26 quotes verbatim in the text
- **1 of 28 named both people in the quote**

The prose names one party and uses a pronoun or title for the other. That is now confirmed by three independent routes: gold set, anchored scan, and a whole-book reader.

### Pair probe

43 pairs that co-occur in the book, one question each: 13 ties, 30 none. Better conversion than any generator, same evidence shape.

---

## 5. The name sweep (local)

The design that fits 8GB: build a deterministic ledger of every sentence mentioning a character; feed it to the model in chapter-sized batches with a carry-forward list; reconcile at the end.

**Ron Weasley:** 525 mentions, 9 batches, **3 ties** — Harry, Hermione, Ginny — all quotes verbatim; **77 notes** produced.

**Ginny Weasley:** 57 mentions, 1 batch, 1 tie (Ron as her younger sister), quote verbatim. She had no entity in the bank; she was created from Ron's note. Her tie came from Ron's notes, not her own mentions.

Findings:

- The notes layer is real and improves recall: adding "list every other named person first" brought Ginny back (2 ties → 3).
- Notes transfer across characters, and the same tie is found from both sides.
- Errors would transfer too; quote verification catches fabrication, not misreading.
- Coverage is the floor: extraction found 79 characters, and missed one the sweep itself discovered.

Bugs found and fixed during the sweep:

- Substring matching: "Ron" matched "environment". Now whole-word, case-sensitive.
- Truncating the ledger to its first 120 sentences kept early chapters, where nothing is stated. Now batched in reading order.
- The bank had no alias for "Ron", so the ledger held 3 sentences instead of 525.

---

## 6. Costs

| operation | cost | time |
|---|---|---|
| whole-book cloud read | ~$0.05 | ~10 min |
| 43-pair probe | ~$0.05 | ~8 min |
| local name sweep, major character | $0 | ~40 s |
| local name sweep, all 79 characters (estimate) | $0 | 15–20 min |

---

## 7. What is established

1. Model choice is not the bottleneck; three generators land in the same 17–23% band.
2. The evidence form is: one name plus a pronoun. Any rule requiring both names in one sentence caps recall at ~12%.
3. Asking about a pair, or walking a name, beats asking about a sentence.
4. A local 9B can produce correct, quote-backed ties when the context is one character's ledger rather than the whole book.
5. Notes are a usable intermediate layer: they improve recall and transfer between characters.

## 8. What is not established

- Whether the sweep's per-character results are stable run to run (we saw one tie appear and disappear).
- Whether the full 79-name sweep reproduces the cloud read's 28 ties.
- Whether notes transfer improves precision or just spreads errors.
- Whether the roster can be completed without a stronger entity pass.

## 9. Next

1. Run the sweep over all 79 names, twice, and compare the two runs.
2. Merge per-name ties into one bank; verify every quote.
3. Compare against the cloud read's 28 on the same book: recall and precision.
4. Use the result to decide whether a trained local verifier is worth building.

## 10. Files

Changed: `fanfable/src/lorebook.ts`, `migrations.ts`, tests for version and assertion behaviour.
Added tests: `anchor-evidence.test.ts`, `assertion-fixtures.test.ts`.
Trials: `testing/trials/adjudication/{name-sweep,judge-anchored,full-sheet,gold-pool}.ts`, `testing/trials/gold-books/`.
