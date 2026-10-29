# Session report — evidence, identity, and the sentence scan

**Date:** 2026-10-28 (second session of the day)
**Tree:** `main` + uncommitted changes (9 modified files, 5 new tests, 1 earlier report)
**Tests:** 497 passing, `tsc` clean
**Books:** 738 chunks / 93 windows (book A), 527 chunks / 66 windows (book B)

---

## 1. What this session was trying to settle

Two questions:

1. **Which reader?** Five models were compared over ten priority windows. One broke the proof ceiling; the rest did not.
2. **Why is the yield so low?** At book scale even the winner produced one or two provable ties out of hundreds of candidates. The session tested whether that is a model problem, a rules problem, or a property of the text.

The short answer: it is a property of how we were looking, and the fix is a different candidate generator, not a different model.

---

## 2. Code changes

### 2.1 Quotes must name both sides at two places

`namesBothDistinctly()` compares token positions. Before, when one row carried another's name as an alias, a single mention satisfied both endpoints and proved a tie between a person and themself.

### 2.2 Same-identity ties are refused

`nestedCharacterNames()` rejects a tie between two character rows whose names nest ("X" inside "Captain X"). Factions are exempt, so a person may still belong to an organisation that shares their name.

An earlier attempt grouped identities by alias chains transitively. It was reverted: model-written aliases are noisy, and one bad alias (a character carrying another character's alias) merged six entities and silently rejected real ties.

### 2.3 Kinds have definitions

`KIND_GLOSSES` gives each of the 36 bankable kinds a one-line meaning and the phrasings that express it. `kindGlossaryBlock()` appends them to the relations prompt. `isUnsupportedKind()` accepts a defining phrase, so "sided with" proves ally of and a bare "Master" as address proves master of.

Effect on ten windows: invented kinds fell from 17 of 23 to 1 of 18.

### 2.4 The reader names the words it read

New column `canon_relation.kind_source` (migration 16, additive). The relations prompt asks for the exact words in the quote that express the relationship; the value is kept only if verbatim in the quote, and the guard accepts it in place of the label's own word. "Threw in with" can prove ally of without the word "ally".

### 2.5 Notes accumulate evidence

A note is now one row per pair and kind holding a list of spans. A later window appends its sentence instead of being ignored. `resolveAccumulatedNotes()` runs once at the end of extraction and promotes a note when every span is verbatim in its page, the spans together name both people, one span states the tie, direction is not reversed, and no human ruling applies.

### 2.6 The sentence scan

`scanSentenceCandidates()` finds, without a model, every sentence that names two known characters and contains a relationship word. Two names only form a candidate when they sit within 25 tokens of each other and a tie phrase lands within 10 tokens of that run. `verifySentenceCandidates()` asks the model one narrow question per candidate, then files the answer through the same acceptance checks. CLI: `lore scan [--max n] [--dry-run]`.

### 2.7 Evidence area is the page

`pageEvidenceText()` returns every chunk on the cited page. The guard now checks quotes against the page rather than one passage. This changed almost nothing on its own (+0 to +1 eligible), but it removed a class of failure where a quote sat one chunk outside the cited passage.

### 2.8 Counters and CLI

`notes promoted` is written into the extraction audit note. `lore scan` is documented in help.

---

## 3. Measurements

### 3.1 Reader comparison, ten priority windows

| model | relations | closed | both named | tie word | guard-eligible | time |
|---|---:|---:|---:|---:|---:|---:|
| qwen2.5:7b Q4 | 28 | 14 | 1 | 16 | 0 | 3m50 |
| qwen2.5:7b Q8 | 15 | 2 | 3 | 12 | 0 | 6m06 |
| qwen3:8b | 15 | 8 | 3 | 9 | 0 | 6m41 |
| llama3.1:8b | 15 | 10 | 1 | 5 | 0 | 8m13 |
| qwen3.5:9b Q4, three runs | 22/26/37 | 11/17/23 | 6/5/10 | 13/13/16 | **1/1/1** | 5m31–5m59 |
| qwen3.5:9b Q3_K_M, two runs | 11/9 | 5/5 | 1/4 | 7/5 | 0/1 | 4m07–4m17 |
| NuExtract3, default | 83 | 11 | 12 | 43 | 0 | 7m12 |
| NuExtract3, strict | 99 | 95 | 10 | 11 | 2 | 5m17 |
| NuExtract 1.5 | 8 | 0 | 1 | 5 | 0 | 6m58 |

The metric in the middle columns is looser than the guard; the guard-eligible column is the real one. Qwen3.5 is the reader.

### 3.2 Full books

| run | relations | closed | both named | eligible | time |
|---|---:|---:|---:|---:|---:|
| A, book A, before fixes | 221 | 101 | 63 | 2 | 47m44 |
| B, book A, before fixes | 759 | 709 | 167 | 7–9 | 42m05 |
| A, book B, before notes | 125 | 124 | 21 | 3 | 34m31 |
| A, book B, with kind_source | 116 | 110 | 3 | 1 | 32m46 |
| B, book B, with kind_source | 344 | 323 | 12 | 8 | 24m05 |
| A, book B, with notes | 113 | 108 | 14 | 2 | 33m52 |

Run-to-run variance is large: the same model found 21 both-named quotes on book B in one pass and 3 in the next. Single runs cannot rank anything.

### 3.3 Candidate generators, book A

| generator | candidates | result |
|---|---:|---|
| windows of 8 passages (extraction) | 93 windows | 1–2 keepers |
| sentence scan | 62 | **15 accepted** |
| name-anchored windows (1–4 sentences) | 1,925 | 0 of 80 sampled |

The sentence scan is the only generator that converts.

### 3.4 Sentence scan detail

- 62 candidates: 15 accepted, 28 already banked or parked, 19 refused.
- Reading all 21 accepted rows in the bank: roughly 6–7 are true.
- Error mix among the rest: 3–4 direction-reversed, 3 alias/wrong-pair, 4–5 incidental quote.
- The dominant new error is direction: "X was Y's mentor" filed as X mentor of Y.

### 3.5 Notes accumulator

125 pending notes on book B: 23 held more than one span, 16 named both people across spans, 12 had a span stating the tie, and **none had both at once**. Zero promoted.

The span carrying the tie word never contains both names; the spans containing both names never carry the word. Linking them needs an inference the text does not supply.

### 3.6 Failed and reverted experiments

- **Page-wide tie word:** eligible rose to 10/25/5 on the larger banks, but about half were false (a teacher of a school, invented spouses, a reversed master). Reverted.
- **Alias-chain identity:** over-merged; reverted (see 2.2).
- **Name-anchored windows:** 0 of 80 sampled. Dropped.

---

## 4. Measurement errors caught this session| error | consequence |
|---|---|
| `provable` metric skipped verbatim and direction | overstated qwen's yield: 2 per run was really 1 |
| persisted park reasons are coarse, not the guard's reason | 10 of 12 and 82 of 99 rows disagreed; the note trail is not an audit trail |
| judge prompt ended with "reply false when it does not" | 0 of 25 and 0 of 80 were prompt bias, not findings |
| alias chains treated as identity | one bad alias rejected real ties |
| model-written aliases trusted for merging | merged six entities into one group including an unrelated character |
| single-run comparisons | same model, same book: 21 vs 3 both-named quotes |

The lesson repeated three times: measure the instrument before trusting the measurement.

---

## 5. What is established

1. **Model choice is not the bottleneck.** The best reader yields one or two keepers per full extraction; the others yield none, but no model yields many.
2. **Vocabulary was a real defect and is fixed.** Invented kinds collapsed once kinds had definitions.
3. **Identity is a real defect and is partially fixed.** Self-ties are refused; duplicated characters still exist and still hide ties.
4. **The one-sentence rule has a measured cost.** 23–30% of candidates have both names on the page but never in one sentence.
5. **Asking about a sentence that already contains both names and a relationship word converts.** One in five sampled, five or six true ties per book in practice.
6. **Asking about a passage does not convert.** 0 of 80.

## 6. What is not established

- Whether the scan's 30% precision is stable across books.
- Whether direction can be fixed by parsing rather than by a model.
- Whether book B's thin yield (5 of 113 notes recoverable, against 108 of 237 on book A) is a property of children's prose or of that book alone.
- Whether any of this generalises beyond two books.

## 7. Recommended next steps

1. **Fix direction first.** It is the top error among accepted rows and it is deterministic: "X was Y's mentor" must file Y as mentor. Until this is fixed, the scan's precision is overstated.
2. **Run the scan on book B** and compare precision. If it holds near 30%, the scan is the pipeline.
3. **Replace extraction with scan + targeted reading**, or keep extraction only for entities and facts.
4. **Then identity**: duplicate characters still cost both recall and precision.
5. **Then a second book pair** to test generalisation before any architectural rewrite.

## 8. Files

Modified: `fanfable/src/lorebook.ts`, `cli.ts`, `migrations.ts`; test version expectations.
Added: `testing/tests/{quote-endpoints,kind-glossary,kind-source,tie-note-spans}.test.ts`.
Trials: `testing/trials/model-ab/{guard-audit,evidence-split,compare-banks}.ts`, `scan-windows.ts`, `judge-windows.ts`.
Databases: `n` (book A), `hp/hp2/hp3/hpnu` (book B), plus earlier ten-window banks.

Nothing is committed.

---

## 9. Addendum — three fixes after the first draft

### 9.1 Direction comes from the judge

The scan had been taking the pair order from how the candidate was listed. Any relation the model recognised was filed in that arbitrary order, which is why mentor rows pointed the wrong way. The judge now returns `from` and `to`, and the row is built from that; a verdict that names neither endpoint is refused.

Three isolated tests in `scan-direction.test.ts`: the mentor is filed as `from` even when listed second; a verdict without endpoints is refused; a denial is refused.

### 9.2 Generic kinship tightened

`relative of` accepted any sentence containing an aunt, uncle or other kin word, so two family members standing in the same room became relatives. It now requires the text to say relative, kin, relation or family. Tested with a kin-word sentence (refused) and an explicit "only living relative" (accepted).

### 9.3 Suspect characters are quarantined

A character admitted from one mention, with no alias, whose name also occurs lowercase in the book is held back: `review_status = 'quarantined'`, with the reason stored in `canon_entity.quarantine_reason` (migration 17). Quarantined characters are excluded from the sentence scan and refused by the guard (`quarantined-entity`). Release requires a second mention or a recognised alias; another occurrence of the ordinary word does not release it.

Six isolated tests in `entity-quarantine.test.ts`: the invoice-name case is quarantined; a unique one-mention name is not; a second mention releases; a second lowercase occurrence does not; a tie with a quarantined character is refused; the scan skips it.

### 9.4 Measured effect

| bank | characters | quarantined | scan candidates before | after |
|---|---:|---:|---:|---:|
| book B | 79 | 3 | 125 | 122 |
| book A | 120 | 0 | 62 | 62 |

The book that produced the false "Bill" entity loses three characters and three candidates. Book A had no such entity, so nothing changed there.

### 9.5 State

507 tests passing, `tsc` clean. No further fixes applied; the open questions in §6 stand.
