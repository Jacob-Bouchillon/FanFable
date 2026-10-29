# FanFable — evidence pipeline, final report for this branch

**Date:** 2026-10-29
**Branch:** `experiment/evidence-scan`
**State:** 554 tests passing, `tsc` clean, no migrations added this session.
**Supersedes:** `REPORT-FULL-2026-10-29.md` for the evidence work. That document remains the system inventory (modules, retrieval, story pipeline); this one records what was changed, what was measured, and what is now decided.

---

## 1. What this branch established

The pipeline can now tell a **relationship** from a **scene**, deterministically, and it no longer banks the latter. On the test book's candidate pool the change is:

| | accepted rows | adjudicated genuine | precision |
|---|---:|---:|---:|
| before the fixes | 30 | 7 | 23% |
| after the fixes (full guard) | 3 | 3 | 3 of 3 |

The accepted rows are now two relationships: Dudley–Piers Polkiss and Ginny–Ron.

That is the headline. It is also the limit of what is proven: three rows, one book, one candidate pool. There is no recall figure yet, because no relationship-level denominator exists for this book. Section 6 states the gap plainly.

---

## 2. Changes to the code

### 2.1 Match-time derived name variants — `fanfable/src/names.ts`

`buildRosterIndex`, `deriveNameVariants`, `occursLowercaseInText`, `lowerOccurrencesInText`.

- Explicit stored names and aliases are used unconditionally.
- Derived forms (full, title-stripped, surname, given name) are filtered by minimum length, a lowercase-occurrence test shared with the suspect-character quarantine, roster collision, and duplication.
- **Nothing is stored.** No migration, no alias written, no entity merged.
- Collision is token-level with a same-person exemption through `nameRelation`, so a shared surname is dropped (`potter`, `weasley`, `dursley`) while duplicate rows for one person keep the given name.
- Derived variants are cached per index, so the matcher does not re-derive per quote.

The lowercase predicate was extracted from `quarantineSuspectCharacters` as a pure refactor; `entity-quarantine.test.ts` passes unmodified.

### 2.2 Structural tie anchors — `fanfable/src/lorebook.ts`

The assertion matcher now admits an anchor only when one of these holds:

- it is the kind's own head word (`married`, `friend`, `partner`), or
- it is a glossary read carrying a linking preposition after its first token (`sided with`, `member of`, `sworn to`, `works for`).

Every other bare reading — `joined`, `backed`, `fought`, `leads`, `taught`, `bore`, `counseled` — is a scene verb and cannot prove a tie. No word list is used; the set is derived from `CLOSED_ROLE_KINDS`.

Three further rules:

- **Coordination is not an assertion.** `and`/`or` anywhere between the subject and the anchor, or between the anchor and the object, breaks the link.
- **An anchor inside an endpoint's name proves nothing.** If the anchor's token span overlaps either endpoint's mention span, that occurrence is skipped — "Dudley asked Aunt Petunia" no longer proves an aunt tie, while "Petunia, Dudley's aunt" still does.
- **Bare `partner` needs a qualifier.** A preceding common noun ("business partner") or a following preposition ("partner in", "partner with"); otherwise the sentence classifies as a scene.

### 2.3 Evidence classifier

`classifyEvidence(quote, fromName, fromAliases, toName, toAliases, kind, kindSource?, index?)` returns `asserted` | `scene` | `none`.

`assertsRelationship` keeps its signature and returns `classifyEvidence(...) === 'asserted'`. Promotion tiers, kinds, and the derived-variant work are unchanged.

The classifier is the hook for the scene layer: `scene` is where the true co-presence sentences belong, and the event table already exists, so routing them needs a rule and a test rather than a migration.

### 2.4 Wiring

The roster index is built once per command and passed through `PromoteContext`, `canPromote`, `provenRelation`, the extraction path, `scanSentenceCandidates`, the promote/verify paths, and the `lore-ask` answer guard. With no index supplied every function takes the exact previous path.

### 2.5 Tests added

| File | Tests | Covers |
|---|---:|---|
| `testing/tests/name-variants.test.ts` | 15 | derivation, title stripping, collision, common-word filter, determinism, no-write hygiene, scan and proof integration, the negative fixture |
| `testing/tests/assertion-anchors.test.ts` | 20 | anchor classes, coordination, anchor-inside-name, partner qualifier, classifier |

All fixtures use generic names; no book terms in `testing/tests`.

---

## 3. Measurements

### 3.1 Name variants, test book

| Metric | Value |
|---|---:|
| entities in roster | 157 |
| entities with no derived variant | 91 |
| derived variants retained | 88 |
| dropped: common word | 164 |
| dropped: roster collision | 51 |
| dropped: too short | 1 |
| scan candidates, before → after | 147 → 855 |

Naming lifts candidate generation 5.8× but reaches only 66 of 157 entities; the roster's full names and duplicate rows absorb most of the gain.

### 3.2 The differential (same 855 candidates, same database copy)

| | matcher, before | matcher, after all rules | full guard, after |
|---|---:|---:|---:|
| accepts without index | 12 | 3 | 2 |
| accepts with index | 42 | 4 | 3 |
| newly admitted | 30 | 1 | 1 |

The matcher counts a self-pair (`Uncle Vernon` → `Vernon Dursley`) that `canPromote` refuses as `endpoint-unnamed`. The guard column is the product's number.

### 3.3 Blind adjudication of the 30 rows that had been admitted

Sheet: 30 items, 11 distinct excerpts, key held separately, no run labels and no model kinds shown.

| | rows | distinct excerpts |
|---|---:|---:|
| supported | 7 (23.3%) | 3 (27.3%) |
| context only | 23 | 8 |
| identity failure | 0 | 0 |
| second, independent judge | 4 (13.3%) | 2 (18.2%) |
| both judges agree | 4 | 2 |

Mechanism: 24 of 30 rows came from action verbs or coordinated lists (`joined` 9, `backed` 1, coordinated kin 14). The one assertion-grade tie was "Dudley's best friend, Piers Polkiss".

Zero false facts: every pair was canonically real. The failure was evidence, not truth.

### 3.4 Sweep pair stability (two frozen passes, same model and settings)

| | run 1 | run 2 |
|---|---:|---:|
| raw ties | 208 | 179 |
| distinct claims | 160 | 133 |
| distinct person pairs | 111 | 99 |

| Comparison | Count |
|---|---:|
| claims in both runs | 58 |
| claims only in run 1 / run 2 | 102 / 75 |
| shared claims citing the same sentence | 16 |
| shared claims with reversed direction | 9 |
| shared person pairs | 78 of 132 (59%) |

Agreement on *who* is connected is 59%; agreement on *what the connection is* is 25%. The label is the unstable part.

Blind adjudication of the 78 shared pairs: 13 supported (16.7%), 37 context (47.4%), 19 identity (24.4%), 9 unsupported (11.5%). Same-citation and different-citation pairs scored the same (17.1% vs 16.2%), so a shared sentence is no evidence of correctness.

The 19 identity failures decomposed as: 12 alias phrases shown as names (a sheet defect, since fixed), 3 duplicate rows, 2 junk entities, 1 genuine text ambiguity.

### 3.5 The gold set cannot measure this work

All 226 rows locate, 225 were resolvable by explicit names alone, 0 became newly resolvable with variants. The pool was drawn from both-named rows, so it does not exercise the naming gap. It remains valid for measuring the assertion rule, not the naming change.

---

## 4. What is proven, and what is not

**Proven, reproducibly, by re-running:**

- 554 tests pass; typecheck clean.
- The guard admits 3 rows on the 855-candidate pool, and all three are the rows two independent adjudications called genuine.
- The 25 rows removed by the rule changes were all judged scenes; the 6 that a judge had called lasting were banked under the wrong kind (aunt/uncle where the text states cohabitation or guardianship), so correct-kind recall did not fall.

**Not proven:**

- General accuracy. n = 3. "3 of 3" means no counterexample in three rows.
- Recall at bank level. No full extraction has been run with the tightened rule, and no relationship-level denominator exists for this book.
- Transfer to another text. Everything above is one book.
- The harness is a floor: it maps each matched phrase to one closed kind, so a phrase owned by two kinds undercounts.

---

## 5. Research intake — binding, scenes, literary classification

Handoff v4, read directly from repository metadata, model cards and dataset cards. **Every accuracy figure below is author-reported and unreproduced locally.**

### 5.1 What the literature establishes

| Claim | Figure | Caveat |
|---|---|---|
| Book-scale coreference is mature and still wrong about one binding in five | xCoRe 78.3 LitBank book splits; 42.4 ECB+; 31.0 SciCo | Best-in-class; failure mode is a silently wrong antecedent |
| Mention detection is easy, cluster linking is hard | Maverick XL: MUC 94.30, B³ 55.30, CEAFe 33.45, CoNLL-2012 61.02 | The gap is linking, not spotting names |
| Character context drives performance, graph structure does not | GraphLit ablation over 12 tasks | Time-localised scene graphs are the right shape |
| Small task-tuned models beat zero-shot frontier models on literary RE | SmolLM3-3B LitTune 0.833 vs GPT-5.4 0.578 literary; Qwen2.5-0.5B 0.83 vs 0.69 general | Positive-class micro-F1, sentence-level, entity pairs supplied, silver labels |

### 5.2 Artifacts and their role

| Artifact | Role | Licence |
|---|---|---|
| xCoRe / BookCoref | binding baseline, evaluator, proposal source | NC-SA weights; code unlicensed — research only |
| GraphLit | design evidence for context grounding | CC-BY-4.0 |
| BookNLP | reference for speaker attribution and scene fields | Python MIT; Java unlicensed — borrow fields, not code |
| compact-relex / LitTune adapters | literary pair classifier | MIT adapters; datasets partly unlicensed |
| ARF (project_gutenberg) | fiction relations **with a measured no-relation population (37%)** | MIT |
| PG-Fiction relations | 146,579 train / 48 labels, GPT-4-class silver | unstated |
| Biographical | 238k subsampled literary/biographical rows | MIT |

**Leakage warning:** PG-Fiction and ARF come from the same 96 books. Split by book, never by row.

**Fixed-label warning:** the LitTune adapters emit labels from their training ontology and cannot be handed `CLOSED_ROLE_KINDS` at inference. Label coverage is the first measurement, not accuracy.

### 5.3 Decisions adopted

- **Tier B stands: no automatic `accepted` from a pronoun binding.** A binding is supplied by the matcher, not by the sentence, and at 78.3 even the best binder is wrong about one in five, silently. A confirmed binding becomes `user_confirmed`.
- **Scene → event is schema, not pipeline.** `scene {participants, speaker, location, time, action, quote}`. Co-presence alone is a scene; an event requires a change or action with a quote.
- **Classifier arm C:** LitTune first, Qwen 0.5B as a cheap harness baseline, GLiREL as fallback because it accepts arbitrary labels.
- **Context notes are a separate index field, never evidence.**
- **Not adopted:** xCoRe or BookNLP in the shipped path; GraphLit as an extractor; LitTune as an adjudicator; general RE benchmarks as training data; the full 385k LitTune mixture.

### 5.4 Experiment order agreed

1. **E0 — label mapping and negative baseline** (an afternoon, no GPU): map the 48 ARF relations onto `CLOSED_ROLE_KINDS`, measure coverage and the no-relation rate, run the 0.5B adapter on ARF's 35,230 no-relation chunks for a false-positive rate.
2. **E1 — binding accuracy** (xCoRe vs the unique-antecedent heuristic) on 20 frozen scenes.
3. **E3 — speaker attribution** on one chapter, to size the scene layer.
4. **E2 — literary classifier** on the same 20 windows.
5. **E4 — fine-tune** only if E0/E2 justify it: 5–10k stratified rows, mapped labels, book-level splits.

E0 decides whether any of the rest is worth the compute, because coverage and negative precision bound everything downstream.

---

## 6. The open gap: recall

The pipeline now says "no" reliably and "yes" rarely. Two relationships from a whole book is too few, and there is no denominator yet to say how few.

Three distinct causes, in the order they should be attacked:

1. **Kind selection.** Six genuine relationships were lost because the banked kind was `aunt`/`uncle` while the text stated cohabitation or guardianship. Nothing in the pipeline proposes `married to` or `guardian` for a shared bedroom or an ongoing household. This is a classification problem, and E0/E2 are aimed at it.
2. **Role-named endpoints.** "his father", "my best friend", "his onetime rival" name the second party by role, not by name. A perfect coreference layer does not convert a role into a bank entity. This is separate from binding and unmeasured.
3. **Pronoun-bound assertions.** The tier-B class. Deliberately not admitted; the cost is recall and the decision is recorded above.

---

## 7. Reproduction

```bash
npm run typecheck && npm test

# name variants and the differential
cp testing/trials/model-ab/hp3.db /tmp/opencode/hp3.db
node --experimental-strip-types testing/trials/name-variants/differential.ts /tmp/opencode/hp3.db
node --experimental-strip-types testing/trials/name-variants/differential-guard.ts /tmp/opencode/hp3.db

# the frozen sweep pair
node --experimental-strip-types testing/trials/adjudication/name-sweep.ts testing/trials/model-ab/hp3.db qwen3.5:9b 79 60 "" testing/trials/adjudication/run-1.json
node --experimental-strip-types testing/trials/adjudication/compare-runs.ts testing/trials/model-ab/hp3.db testing/trials/adjudication/run-1.json testing/trials/adjudication/run-2.json
```

Adjudication material: `testing/trials/name-variants/delta-sheet.md`, `delta-verdicts.tsv`, `shared-pairs-sheet.md`, `shared-pairs-verdicts.tsv`. Keys are held separately and are not committed.

---

## 8. Next actions

1. **E0** — label coverage and the no-relation false-positive rate. Decides whether the classifier track is viable.
2. **Full extraction on the test book** with the tightened rule, accepted set adjudicated blind, to replace the candidate-pool number with a bank-level one.
3. **Whole-book relationship read** with the long-context model as a dev oracle (~$0.05, ten minutes) to produce the missing denominator and the list of missed ties.
4. **Scene routing** — apply the classifier so `scene` rows become event candidates rather than being discarded.
5. Then, and only then, E1/E3.
