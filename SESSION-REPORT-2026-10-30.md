# FanFable — evidence web: combined session report (2026-10-30)

Compiled from three sessions that ran in parallel: the planner (design, measurement, model
selection), the coder (implementation, milestones 1–16), and a read-only audit (six defects,
file and line evidence). Numbers below are counts measured on disposable database copies;
no book prose is reproduced here.

**One-line state.** The evidence web is built, wired into planning, and precision-safe, but its
overall accuracy number is judge-dependent and its recall is still about one tie in ten. The
next gains are in extraction and in the grading rubric, not in more web machinery.

---

## 1. Scope and method

| Session | Role | Output |
|---|---|---|
| Planner | design, measurement, model selection, verification | milestones scoped, independent checks, model study, this report |
| Coder | implementation | migrations 19–26, six web modules, court record, harness, CLI, tests |
| Audit | read-only defect hunt | six defects with file:line evidence and measured impact |

Rules followed throughout: every measurement on a temp copy of the half-book bank; no writes
to a live bank; notes immutable; the bank stays the only thing that certifies a claim; no model
calls inside the web layer.

---

## 2. Data and environment

Half-book bank (`halfbook` project, `plagueis-half` copy):

| Item | Count |
|---|---|
| Chunks | 1,448 (avg 254 words) |
| Entities | 360, of which 182 live characters |
| Relation rows | 336 across 235 distinct pairs |
| Threads | 6,646 (6,286 pair, 360 person) |
| Notes | 373 (270 observation, 103 context) |
| Open ends | 6,404, resolved 0 |
| Meetings / births | 183 / 2 (before later milestones) |
| Tie notes / conflicts | 98 / 0 |

Live bank is a separate 7-relation test project (`nemotron-bigtest`), migrated to v26 and
backfilled, but it does not contain the half-book web. Promoting that is a product decision.

Hardware: RTX 3060 Laptop, 6,144 MiB VRAM, driver 596.49, 15.3 GiB system RAM. Ollama 0.40.13.

---

## 3. What was built

### 3.1 Schema (migrations 19–26, additive)

| Version | Adds |
|---|---|
| 19 | `canon_pair_thread` — code-only coverage scaffold per co-occurring pair |
| 20 | `canon_thread`, `canon_thread_passage`, `canon_thread_note`, `canon_open_end` |
| 21 | `canon_meeting*`, `canon_birth`, `canon_thread_note_ref`, `carried_from_open_end_id` |
| 22 | `canon_thread_note.dedupe_key` (partial unique) |
| 23 | `period_label`, `period_from_seq/to_seq`, `temporal_status`; period-aware root identity |
| 24 | `strength_source` on notes |
| 25 | `canon_thread_note.claim_kind`, `canon_thread_conflict` |
| 26 | `canon_ruling` — the court record of every status decision |

### 3.2 Modules

- `pair-threads.ts` — identity-aware co-occurrence, no model, idempotent.
- `threads.ts` — thread records, insert-only notes, open ends, period derivation.
- `meetings.ts` — deterministic matching, admission rule, four birth triggers, bounded enumeration.
- `note-ingest.ts` — backfill and per-window ingestion, verbatim gate, dedupe, routing, strength.
- `identity.ts` / `identity-check.ts` — resolution and collision flagging, never merges.
- `brief.ts` — the five-section web brief consumed by the planner.
- `ruling.ts` — one row per status decision, actor/role/standard/basis.
- `names.ts` — apostrophe folding (U+2018/U+2019).

### 3.3 Product wiring

`controller.draftPlan` now builds the web brief and passes it to `planner.draftOutline`
(`controller.ts:1069–1105`). Prompt sections: `PROVEN TIES`, `ATTESTED TIES`,
`PROVISIONAL — DO NOT ASSERT`, `OPEN QUESTIONS`, `VISIBLE CONTRADICTIONS`. Rules: a canon claim
needs a locator; `uncited` is never canon; provisional is possibility only; questions stay
unanswered; contradictions are shown, not resolved. Empty sections are omitted. A failed brief
logs one line and planning continues.

### 3.4 Court, attestation, grading

- `lore attest` wires `assignAttestedTiers`, dry run by default, temp-path guard.
- `lore docket`, `lore anchors`, `lore ties --brief/--assessment`.
- External grading harness: `export-packets.ts`, `score-verdicts.ts`, `import-verdicts.ts`,
  `relabel.ts` under `testing/trials/grade-claims/`.
- Blind packets carry pair, claimed kind, quote, passage; never status, confidence or assessment.

---

## 4. Measurements

### 4.1 Coverage and evidence

| Measure | Value |
|---|---|
| Co-occurring pairs | 3,307 (6,267 pair threads after periods) |
| Pairs with a relation row | 235 |
| Unproposed co-occurring pairs | ~3,100 |
| Sampled unproposed (D3) | 80, weighted to 3,137 population |
| D3 weighted A+B | 20.3% (95% CI 12.9–30.4) |
| Estimate recoverable | ~636 pairs |
| Notes written | 373, all byte-verbatim in their chunk |
| Quote fragments (not a full sentence) | 209/373 (56%) |

### 4.2 Meetings and births

| Stage | Meetings | Exchanges | Births |
|---|---|---|---|
| Naive (before admission rule) | 27,858 | 44,021 | 35 (33 duplicate subjects) |
| Admission + periods | 2,389 | 6,687 | 2 |
| After assessment rebuild | 1,302 | 3,805 | 15 |
| Note-bearing filter | 1,039 | — | 13 |
| Admission floor 0.45 | 424 | 1,462 | 9 |

Admission-floor sweep (criteria identical at all points): 0.35 → 443 meetings; 0.45 → 424;
0.60 → 405; 0.70 → 353. Default chosen 0.45.

Enumeration: 1,168,644 candidates before the note-bearing filter, 56,978 after (4.9%),
with the admitted set unchanged (0 of 183 meetings had no note on either side).

### 4.3 Identity

| Measure | Value |
|---|---|
| Apostrophe duplicates | 4 merged (Shi'ido / Shi’ido class) |
| Collision groups | 36 (9 same-form, 52 containment edges) |
| Entities flagged | 82 → later 102 |
| Ambiguous cases refused | 100 |
| `anchor_evidence` populated | 0/336 → 112/336 after `lore anchors` |

### 4.4 Assessment and attestation

- `lore assess --write`: 314 of 336 rows scored in 630 s (~2 s/row on GPU).
- Bands: 195 below 0.5; 4 in 0.5–0.6; 17 in 0.6–0.7; 30 in 0.8–0.9; 68 in 0.9–1.0.
- 98 rows at or above 0.7.
- User-confirmed rows average **0.635** — below the 0.7 bar.
- `lore attest`: 26 rows to `attested`; second run 0. 222 `needs_review` rows would pass the
  quote guard but were not promoted.

### 4.5 Blind grading of 82 citable pairs

Citable pairs went **31 → 82** after attestation and quote repair. One judge (Gemini) graded:
A 35, B 18, C 29 → **A+B 53/82 = 64.6%** (Wilson 95% 53.8–74.1).

Split by the hidden signal the judge never saw:

| Signal | n | A/B | Precision |
|---|---|---|---|
| Both names in quote | 7 | 7 | **100%** |
| Positive model assessment | 13 | 11 | 84.6% |
| Human-confirmed | 32 | 19 | **59.4%** |
| No signal | 30 | 16 | 53.3% |

### 4.6 Two-judge agreement (new, this session)

Same 82 blind packets, same rubric, second judge run locally (Spark 4B Q4).

| | Gemini | Spark 4B |
|---|---|---|
| A+B | 53/82 (64.6%) | 39/82 (47.6%) |
| Overall agreement | — | **48/82 (59%)** |

Agreement by signal:

| Signal | n | Both A/B | Gemini A/B | Spark A/B | Agree |
|---|---|---|---|---|---|
| Sentence-proof | 7 | 6 | 7 | 6 | 86% |
| Human-confirmed | 32 | 12 | 19 | 21 | 50% |
| Assessment | 13 | 5 | 11 | 6 | 46% |
| No signal | 30 | 6 | 16 | 6 | 67% |

Interpretation: sentence-proof is the only tier both judges trust. Human-confirmed holds at
roughly 37–66% depending on judge. Assessment and no-signal rows are unstable between judges
(11 vs 6; 16 vs 6). A 17-point spread on identical evidence is the measurement noise floor, so
64.6% must not be quoted as the bank's precision.

---

## 5. Model selection study

All on the same ten quote rows with the same checks unless stated. "Clean" = right pair, no
pronoun leak, names intact.

| Model | Build | Prompt | Clean | Speed | Notes |
|---|---|---|---|---|---|
| LFM3 1.7B | Q4 | few-shot | 4/10 | 6 t/s | invented "the speaker"; label collapse |
| Spark 1.7B | Q4 | few-shot | 4/10 | 151 t/s | — |
| Spark 1.7B | Q4 | template | **8/10** | 151 t/s | but 8/10 labelled `mention` (under-claims) |
| Spark 4B | Q4 | few-shot | 6/10 | 80 t/s | — |
| Spark 4B | Q4 | template | 7/10 | 80 t/s | best label spread; one invented negation |
| Spark 4B | Q8 | template | 7/10 | 62 t/s | no gain over Q4 |
| NuExtract 1.5 tiny | Q4 | span template | 0/10 | fast | picked companies/places as object |
| NuExtract 1.5 | Q4 | native template | 2/10 | — | verbatim spans, wrong entities |
| NuExtract3 | Q4 | structured mode | 6/10 strict, 8/10 alias-tolerant | 74 t/s | 10/10 verbatim evidence |

Slot-extraction validation (50 rows, seed 42, alias-aware, verbatim evidence required):

| Model | Correct pair + verbatim | Wrong pair | Non-person | Ungrounded |
|---|---|---|---|---|
| **Spark 4B Q4** | **49/50 (98%)** | 1 | 0 | 0 |
| NuExtract3 Q4 | 37/50 (74%) | 8 | 5 | 0 |

Spark's evidence spans were genuine (3–16 words against 19–33 word quotes), not echoes.

Conclusion: slot extraction with code-composed sentences is far more reliable than free-form
claim writing. Prose claims leak pronouns and can invent negations; slots do neither. Both
models were tested on quotes already in the bank, which is the easy case.

---

## 6. Hardware findings (cost hours; will recur)

1. **Ollama under-fills the GPU.** Auto-split chose 43% CPU / 57% GPU with 1.6 GB VRAM idle.
   `num_gpu: 99` was required to place all layers. With `OLLAMA_NUM_GPU=99` set in the shell
   before starting the app, the CLI inherits it.
2. **A 9B at 16k context does not fit 6 GB.** 6.7 GB loaded, spill, ~6 tokens/sec.
   Reducing project `contextTokens` 16384 → 2048 and enabling flash attention fixed it.
3. **KV cache is the difference between unusable and fast.** With default KV, the 9B fit
   "100% GPU" but memory clock sat at 810 MHz and throughput collapsed to ~6 t/s.
   `OLLAMA_FLASH_ATTENTION=1` + `OLLAMA_KV_CACHE_TYPE=q8_0` raised it to ~50 t/s.
4. **Power/thermal caps matter more than VRAM.** The laptop was in ECO mode: GPU at 98%
   utilisation, 25–30 W of an 80 W limit, P5, memory clock at 11% of maximum. Windows
   "High performance" alone did not lift it; the vendor performance mode is the binding control.
5. **Ollama's HF pull fails on redirects** (`realm host "huggingface.co" does not match
   original host "hf.co"`). Workaround: `curl -L` the GGUF and `ollama create`.
6. **Vendor default tags are often BF16.** `SparkLLM/Spark-X2.6-4B` pulls 8.2 GB BF16 and
   cannot run on 6 GB; `:Q4_K_M` is 3.5 GB and runs at 80 t/s.

---

## 7. Defects found and fixed

| # | Defect | Fix | Evidence |
|---|---|---|---|
| 1 | Births duplicated: 33 born threads for 2 subjects | child subject from pooled evidence; one born thread per subject, later meetings enrich | 33 → 4 threads, 4 subjects, 0 duplicates |
| 2 | Meetings exploded: 27,858 empty rows | admission requires crossing pair notes; note-bearing filter; 0.45 floor | 27,858 → 424 |
| 3 | Assessment never promoted | wired `assignAttestedTiers` as `lore attest` | 26 attested, second run 0 |
| 4 | Aliases/duplicates unresolved | apostrophe fold; relationship-based collision; guarded containment resolver | 13 of 20 benchmark pairs unresolved → 1 |
| 5 | Note strength defaulted to 1.0 | strength from assessment / derived tiers; `strength_source` | no note at 1.0; 171 assessed |
| 6 | Context notes lost after assessment | routing reads `asserted`/`names_both`, not just strength | context 0 → 12 |
| 7 | Benchmark score depended on command order | validator computes collision status read-only | identical lines on differently-prepared copies |
| 8 | Brief inert in the real path | `controller.draftPlan` passes `webBrief`, guarded | prompt contains EVIDENCE WEB; `lore brief` counts match |
| 9 | Status changes were invisible | migration 26 court record, transactional | every move has actor/standard/basis |
| 10 | Claim inputs unsurfaced | `lore ties --assessment` prints the assessment fields | 78 rows printable |

---

## 8. Benchmark status

Four hard criteria against the locked 20-pair sheet:

| Criterion | State | Cause |
|---|---|---|
| No births on 5 absent controls | **PASS** | 0 across every run |
| No births on 5 alias traps; T3/T4 flagged | **PASS** | containment check, both copies |
| S1–S3 each hold a note ≥ 0.35 | **FAIL** | zero relation rows exist for those pairs in this bank |
| C1 holds early evidence | **FAIL** | row exists at 0.9 but cites seq 1208; "early" is ≤ 483 |

Score line (verbatim, current):
`{"criteriaPassed":2,"criteriaTotal":4,"absentBirths":0,"trapBirths":0,"trapFlagged":2,"recallS1S3":0,"c1Evidence":0,"resolved":14,"ambiguous":1,"absent":5,"bornThreads":9,"bornSubjects":9,"duplicateBornSubjects":0,"trapFlaggedData":2,"trapFlaggedDb":0}`

Both failures are properties of the bank's evidence, not the web's logic: no rows, or a row
citing a late passage.

---

## 9. Open defects, ranked

1. **Recall.** 82 citable pairs of ~750 estimated; ~636 unbanked; 213 scan-visible pairs have
   no row. Needs a full sentence-map pass.
2. **Quote fragments.** 56% of note quotes are not complete sentences; 160 rows still lack an
   anchor. The extractor accepts any verbatim fragment.
3. **Judge reliability.** Two judges agree on 59% of rows; 17-point precision spread.
   The A/B sentence-count boundary is the main source of disagreement.
4. **Human confirmations underperform.** 59.4% (Gemini) / 65.6% (Spark); only 12 of 32 agreed
   by both. Either confirmations were loose or the rubric excludes context they relied on.
5. **Contradictions inert.** Closed set of six pairs; 8 literals never occur; the only
   enemy/ally thread is context-only. Zero conflicts.
6. **Open-end backlog is noise.** 6,287 placeholders on zero-note threads; 0 resolvable
   (maximum token overlap with any note is 1); starved windows return 0 because every chunk
   is already mined and `canon_thread_passage` is empty.
7. **Locators malformed.** Stored `source_refs[].locator` values are truncated quote fragments,
   not page references. The brief passes them through, so citations cite nonsense.
8. **Brief sources.** It reads `canon_relation` plus open ends and conflicts; it does not read
   note content. Model-extracted evidence reached only as notes cannot reach the planner.
9. **Labels.** 8 of 11 disputed kind claims judged "no relationship" by a second model.
10. **Live bank.** Still the 7-relation test project.

---

## 10. Recommendations

**A. Fix the grading rubric before trusting any number (cheapest, highest value).**
Replace A/B/C/D with axes that do not require a stylistic judgement:
`tie` = stated | presupposed | absent; `location` = in-quote | passage-only; `kind_fit` = yes | no;
`identity` = ok | collision. Map mechanically to citable / attested-with-scope / provisional /
context. Re-run both judges on the same 82 packets and measure per-axis agreement. If agreement
does not rise above ~80%, the passages are genuinely ambiguous and no judge should decide them
without the book.

Acceptance: per-axis agreement ≥ 80% on the 82 rows; the A/B split disappears from the data.

**B. Human spot-check before any recall work.** Read the 12 human-confirmed rows where both
judges said "not established". That settles whether to fix the judge or the confirmations.

Acceptance: a written verdict on each of the 12, and a decision recorded on whether
`user_confirmed` keeps overriding assessment.

**C. Then recall.** Full sentence-map pass with the slot-extraction setup that measured 98%
pair accuracy: Spark 4B Q4, four slots, code-composed claims, mechanical gates (pair match,
verbatim evidence, no negation absent from the quote). Feed paragraphs, not stored quotes.

Acceptance: citable pairs ≥ 200 with precision unchanged on the absent controls, and no
fabricated evidence in a 50-row audit.

**D. Then the smaller items.** Fix locators at write time; give the sync-generated open ends a
concrete `would_resolve`; make the brief able to read note evidence or promote notes into the
bank; widen contradiction detection to pair-level with period awareness.

---

## 11. Reproduction

```bash
npm run typecheck && npm test          # 870 pass at last run

# web on a copy
lore threads --sync
lore notes-ingest
lore meet --min-admission 0.45
lore attest --write
lore brief --for "Name, Name"

# benchmark
node --experimental-strip-types testing/trials/benchmark/validate-web.ts <db> halfbook testing/trials/benchmark/pairs.json

# grading
node --no-warnings testing/trials/grade-claims/export-packets.ts <db> halfbook <outDir>
node --no-warnings testing/trials/grade-claims/score-verdicts.ts <key.csv> <verdicts.csv>

# model server (6 GB card)
# OLLAMA_NUM_GPU=99 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0
```

---

## 12. What this report could not verify

- **Full-book recall.** Everything is on a half-book copy; the 82 citable pairs are not a
  full-book measure.
- **Human ground truth.** No human has read the 82 blind packets; both judges are models.
- **Extraction as a reader.** Spark and NuExtract3 were tested on quotes already in the bank,
  which is the easy setting. Neither has been run over empty pairs.
- **Planner output quality.** The brief reaches the prompt; no real outline was generated and
  rated with it, only mock-verified.
- **Contradictions.** Zero observed; unit tests only.
- **Live-bank state.** The numbers above are copies; the live bank holds 7 relations.
- **Locator correctness.** Known malformed; no repair attempted.

---

## 13. Plain-language summary

The system now remembers what it has investigated instead of re-deriving it, refuses to promote
anything without a verbatim quote, records who decided every status change, and hands the
planner a brief that separates what is proven from what is merely suspected. That part works,
and it is measurably safe: no fabricated evidence, no births on pairs with no relationship,
no silent status changes.

What it still cannot do is find most of the book's relationships — about one in ten — and the
number used to describe its accuracy is one model's opinion, contradicted by a second model on
four rows in ten. The honest state is: sound machinery, thin evidence, and a measurement that
needs a human before it can be quoted.
