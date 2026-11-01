# Research record — methods, measurements, and intake

**Status:** the complete research record for FanFable. Design contracts live in `HOW-IT-WORKS.md`; ranked next steps in `WHATS-NEXT.md`; the locked probe in `BENCHMARK.md`; setup in `REQUIREMENTS.md`. This file is the evidence behind those four: every method we used, every number we trust, every external artifact we reviewed, and what each one decided.

**Reading rule (applies to the whole file):** every accuracy figure carries its provenance — **locally measured** (with n and date) vs **author-reported and unreproduced**. A passing test establishes that a mechanism behaves as specified; it never establishes that the mechanism is effective. Effectiveness evidence is the A/B numbers below; regression evidence is the suite. Measurements are never rewritten — a new number gets a dated note.

**Counts only.** Numbers are reported, never quotes or passages.

**Provenance of this document (2026-10-29, branch `experiment/evidence-scan`):** built from the four live docs, the deleted-but-recoverable reports in git (`REPORT-2026-10-29-final.md` §5 recovered verbatim via `git show`; `REPORT-2026-10-28.md`, `REPORT-FULL-2026-10-29.md`, `REPORT-2026-10-29-evidence-scoring.md`, `REPORT-2026-10-29-kinds.md`, `HANDOFF-2026-10-29.md`, `NEXT-STEPS.md`, `SESSION-REPORT-2026-10-28-B.md`, `REVIEW-2026-10-29-gemini-proposal.md`, `docs/frozen/v1-relationships/session-findings.md` at `cf5e591`), and the trial harnesses in `testing/trials/` (read directly, not from memory). External-artifact verdicts from research sessions are marked **session-reported** where no re-verification was done in this pass.

---

## 1. The frozen yardsticks

### 1.1 The 20-pair benchmark sheet (locked 2026-10-26)

Full sheet in `BENCHMARK.md`. Twenty pairs in four blocks of five: stable labels, changing-across-boundary (asked pinned to a chapter), alias traps (must abstain, never merge), absent controls (must abstain with evidence). Ask shape: "status of A to B as of chapter X"; output shape: label, exact span-verified quote, locator, scope. Lazy mining capped (2 windows per ask). Verdicts ternary: `correct-cited-scoped` / `correct-abstain-with-evidence` / `wrong-or-uncited` (subclass alias / direction / scope / quote). A flagged or unplaced row never counts as an answer. Endpoint-thin quotes trigger a targeted enrich before the verdict counts as cited.

Frozen scores: **3 cited** (S2 aide, C1 apprentice, C5 partner — endpoint-thin), **14 correct-abstains**, **3 known failures** (#3 Tarkin aide recall miss, recovered by pinned single-window re-read — emission failure, not gate or coverage; #10 Jabba partner confirmed recall miss; #7/#8 open-vocabulary labels, fixed by the closed role-noun gate).

Verification re-run (fresh bank, same build, same 20 asks): **3 cited** (incl. label-variant `master of` for C1 and the T2 sheet correction), **13 correct-abstains**, **3 recall misses** — all emission variance across runs, 0 gate violations. Precision on surfaced answers 3/3; recall of v1-true ties varies run to run. The gates are deterministic; the extractor is not.

Changelog rule: every future deviation (reworded asks, changed budget, gate edits affecting verdicts) gets a dated entry; scores are never edited without one.

### 1.2 The gold sets

| Set | Size | Construction | What it measures |
|---|---|---|---|
| 226-row gold pool | 226 | accepted rows + scan candidates from every bank, deduped, shuffled, capped (`testing/trials/adjudication/gold-pool.ts`); sheet carries id/pair/sentence only, group + verdicts in the key file | assertion-rule precision, not naming |
| 42-row accepted group | 42 (of 226) | located via `gold-map.json`, which kept `relId` for 42 rows only | 8 supported / 2 context = 19% (locally measured, blind) |
| 184-row candidate group | 184 (of 226) | the remainder | 18 supported / 11 context = 9.8% |
| 30-row human sheet | 30 | half where two verifiers disagreed (informative cases), half from the rest; sheet omits verifier verdicts (`human-sheet.ts`) | 5/30 = 17% supported (locally measured) |
| 42-row blind judge set | 42 | same rows, different judge | 7/42 = 16.7% supported (locally measured) |
| 30-row delta set | 30 | rows the rule change alone admitted | 7/30 supported, 4/30 second judge, 2 agreed (locally measured, 2026-10-29) |
| 78 shared pairs | 78 | claims in both frozen sweep runs | 13 supported (16.7%), 37 context, 19 identity, 9 unsupported (locally measured, blind) |

Known defect: the 226-row key kept `relId` for 42 rows only. New labelling must store the relation id on every row. Label defects briefed to labellers: 4 past "unclear" verdicts reasoned from outside knowledge, 2 rows matching invoice-"bill" to a character named Bill.

Limitation with teeth: the gold pool was drawn from both-named rows, so **all 226 locate and 225 were resolvable by explicit names alone** — 0 newly resolvable with name variants. The pool remains valid for measuring the assertion rule and cannot measure the naming change.

### 1.3 Blind adjudication procedure

Sheets carry id, pair, and sentence only — no run labels, no model kinds, no verifier verdicts. The key is held separately and never committed (`testing/trials/adjudication/*-key.json` are local-only by `.gitignore`). Verdicts: supported / context-only / identity failure / unsupported, with ≤12-word reason each, no outside knowledge. Two independent judges for contested sets. Precision of any guard change is measured **on rows the new rules alone admit**, adjudicated blind — never on the historical accepted set, because those rows were selected by an older, weaker guard and cannot detect new false positives.

### 1.4 A/B and differential measurement on identical ground

Reader/model comparisons run on the same book, same priority windows, same seed (42), same prompt, fresh database per arm, one repetition per cell unless stated. The seed makes a run repeatable, not representative — it repeats the same observation rather than taking another one. Single-run differences smaller than the measured run-to-run spread are noise, not signal (documented case: `qwen2.5:3b` scored 6% recall before a fix and 2% after it on identical ground — the fix cannot have made it worse, so that spread is the noise floor).

The differential pattern that replaced single-arm claims: fixed candidate pool, two matcher/index variants, same pair×kind checks, blind adjudication of the newly admitted rows only (REPORT-final §3.2: fixed 855-candidate pool, 1,114 pair×kind checks, 12 accepts without index / 42 with, 30 newly admitted).

### 1.5 Negative controls

ARF (Artificial Relationships in Fiction, MIT, 95,475 annotated chunks, ~128k relations, **35,230 chunks with no relation — 37%**): **50 no-relation chunks → 2 proposals (4%)**; 50 positive chunks → 42% recall (locally measured, qwen3.5:9b kind-label evaluation). The 4% chunk-level false-positive rate is the number that bounds any claim about proposal discipline; the 42% is the recall number on positives. No-relation chunks are also the prescribed negative baseline for any tuned classifier: the paper headline (LitTune 0.833 literary) excludes the no-relation class, so it says nothing about invention rate — ARF's 35,230 negatives are the data that answers it.

### 1.6 Calibration bands and the combination rule

`testing/trials/claim-confidence/calibrate.ts` (trial-only, read-only): joins blind-labelled rows (226 gold verdicts, 30 human, 30 delta) to stored `confidence` and assessment, reports predicted vs observed support per band. Procedure: group by predicted band, compute observed support rate, apply a fixed correction table measured once and stored in one place. The same procedure validates the combination formula (`score = 1 − Π(1 − sᵢ)`: one thin 0.4 mention scores 0.40, no bank; two independent 0.4+0.8 score 0.88, banks; one explicit 0.95 banks; three damped weak 0.2s score 0.49, no bank) plus the catch-all damper (a sentence cited for more than three distinct pairs gets each contribution halved). If the formula does not beat raw confidence on the same rows, it earns nothing. **Outstanding:** published calibration table, full-bank re-measurement at threshold.

### 1.7 Stability runs

Judge stability: **6 of 42 verdicts flip across identical runs (14%)** — the noise floor for judge measurements (locally measured, `gpt-oss:20b`, `think: "low"`). Prescription: majority of three runs for any judge verdict that ships. Sweep stability: two frozen passes, same model and settings — 59% agreement on *who* is connected, 25% on *what* the connection is; 16 of 58 shared claims cite the same sentence; 9 reversed direction. Shared-pair adjudication scored the same for same-citation and different-citation pairs (17.1% vs 16.2%) — a shared sentence is no evidence of correctness.

### 1.8 Contamination probes

Run against `qwen2.5:7b` (the incumbent at the time): 8 no-context QA → 1 weak hit only (11-4D is a droid); 4 confabulation controls → 4/4 abstained; 3 verbatim completions → 0/3. No parametric memory of the book's specifics; v1 scores citable as system-on-text recall (small-n caveat: 20 pairs, selective 12-window base). **Re-run this probe if the model changes.**

### 1.9 Capped mining and the close-the-loop mechanism

Caps sweep (fresh rebuild + same 12-window seed extract, 20 asks): bank-only 19/20 vs mined 18/20 over 33 windows (~468s). Mining added zero wins and one loss; corroboration is 1 on all 53 banked ties, so caps 3/5/uncapped are identical. Verdict recorded: **touch nothing** — bank answers; mining is insurance that did not pay on this sheet.

Close-the-loop (verified same day, suite green, `tsc` clean): gap-driven re-read at the end of extraction — gap entities (0 ties, or 1 tie with mentions > 3) → tight gate (same-sentence name+cue, mined passages only; 14 hits including Tarkin, vs 75 for a loose gate) → cap 5 entities × 4 passages → dedupe, never throws. Settles emission-vs-coverage: "His aide, Bor Gracus" sat in mined chunks across three extracts un-emitted; pinned re-read banked it first try. Limits: recall variance dominates run to run; tight-gate junk hits burn bounded calls; the loop raises emission chances, it cannot make the model deterministic.

### 1.10 Frozen-benchmark procedure

No tuning, no weight changes during a probe. Procedure changes go in the changelog (§9 of `BENCHMARK.md`); verdicts are never edited silently. One repetition per cell is reported as preliminary and directional. Determinism scope: code paths are bit-deterministic; LLM prose is excluded — compare row counts, verification outcomes, and reason codes, never token equality.

---

## 2. The guard: what banks, and the experiments that shaped it

Standing rule, unchanged through every experiment: **no bank without a span-verified quote.** `lore integrity` exits non-zero if any keeper's quote is not verbatim in a cited chunk. `canPromote()` is the single gate. A parked tie becomes a keeper only when all hold: closed relationship-grade kind; no PARK ruling on the pair or its inverse class (a human ruling binds the pair — new evidence becomes a pending note, never a status change); quote verbatim in its cited passage; both endpoints named in that quote; tie word present; direction not reversed.

Unresolved names are reported, never guessed. Fabrications bank as `unsupported-citation`. Anchor evidence (`anchor_evidence`, migration 18): the guard runs the assertion test on the anchor **or** the quote, never on the union. The ten keepers that could not be re-proved from the text are quarantined, not deleted — provisional with `confirmed_by_user` preserved. Ten quarantined rows traced to six invented quotes, one spliced, three with no chunk reference. Rulings export/replay (`lore rulings export/replay`) makes human decisions portable across rebuilds.

**Answer side:** the muzzle (bank-or-quote for CONFIRMED ties) plus the answer guard (unproven CONFIRMED rewritten to abstain, original kept below for audit). `lore ask` is the only path allowed to state a relationship. `FANFABLE_NO_GUARD=1` exists only for experiments.

### 2.1 Three failed definitions of "relationship" (all in code, all measured)

1. **Closed label list + synonym lists** (36 kinds, hand-written noun groups): 30 accepted rows with 7 adjudicated real; after tightening, 3 with 3 real — precision bought by throwing away 90%. Vocabulary the list lacked counted for nothing.
2. **The assertion matcher** (both names + tie word + possessive/of-phrase/SVO): rejected scenes correctly and most real relationships too — only 9.1% of sweep quotes name both people. Measured on 1,111 rejected candidates, 66% were two names in a list.
3. **The open-vocabulary gate**: owned 5 of 258 queue notes. Never the bottleneck; the most visible one.

Common failure: code asked to hold a definition of a relationship. Any definition specific enough to reject "Harry and Ron stood in the hall" also rejects "he already felt like his best friend." Resolution (2026-10-29): **the model judges, the code measures.** The model's assessment (`names_both`, `asserted`, `other_person`, `strength`, `why`) is stored in `supporting_evidence`; the code certifies only verbatim quote, entity existence, non-identity, and the calibrated threshold (default 0.7, project setting `minConfidence`). Deleted, not disabled: assertion matcher, `KIN_GROUPS`, synonym lists, `open-vocab` refusal, reverse-direction-as-promotion-condition, concept-as-promotion-gate (the concept set stays for labelling and querying), the `kind_source` substitution loophole. One survivor: a quote hiding a preceding "perhaps"/"not" is still refused — misquotation, not grammar.

### 2.2 Name variants at match time (shipped)

Stored `name` + `aliases` are explicit and unconditional. Everything else is derived once per command and filtered — canonicalise; title-strip while the first token is a title (universal honorifics/kin titles, or any token carried by more entities than `NAME_DF_CAP`); emit full/stripped/surname/given; filter derived forms only (shorter than 3 chars; lowercase form occurring whole-word in text — same predicate as the suspect-character quarantine; roster collision; duplicates of explicit forms). **Nothing is stored, merged, or written back.** Wired through mention matching, assertion, endpoint/direction helpers, sentence scan, name sweep, and the answer guard; with no index every function takes the exact previous path.

Measured on the test book: 157 entities, 88 variants retained (164 dropped common-word, 51 collision, 1 too short); sentences naming two characters 84 → 208; guard accepts 0 → 13; scan candidates 147 → 855 (5.8×). Hygiene: database byte-identical after a full pass; variant maps run-identical. "Aunt Petunia looked over at Dudley" still rejected with variants on; two same-named entities both keep full names.

Session-finding caveat: naming was the ceiling in the right direction but ~3× too large in size — real gain 5→9 accepts, not 0→13. Most entities gain nothing; roster full names and duplicate rows absorb most of the gain.

### 2.3 Structural tie anchors and the evidence classifier (shipped, current)

The assertion matcher admits an anchor only when it is the kind's own head word (`married`, `friend`, `partner`) or a glossary read carrying a linking preposition after its first token (`sided with`, `member of`, `sworn to`, `works for`). Bare action verbs (`joined`, `backed`, `fought`) and coordination (`X and Y`) no longer anchor. An anchor inside an endpoint's name proves nothing ("Dudley asked Aunt Petunia" rejected; "Petunia, Dudley's aunt" accepted). Bare `partner` needs a qualifier. `classifyEvidence()` returns `asserted` / `scene` / `none`; `assertsRelationship` keeps its signature. The classifier is the hook for the scene layer: `scene` rows are co-presence candidates, and `canon_event` already exists, so routing needs a rule and a test, not a migration.

Differential result (same 855 candidates, same DB copy): accepts without index 12 → 3, with index 42 → 4; newly admitted 30 → 1; guard column 2 → 3 keepers. Blind adjudication of the 30: 7 supported (23.3%), 23 context, 0 identity failures, 0 false facts (pairs real, evidence not); second judge 4/30 (13.3%), both agree on 2 excerpts (3/11). Mechanism: 24 of 30 from action verbs or coordinated lists (`joined` 9, `backed` 1, coordinated kin 14). The one assertion-grade tie: "Dudley's best friend, Piers Polkiss." Verdict recorded: the accepted rows are now two relationships (Dudley–Piers Polkiss, Ginny–Ron); n = 3 is no general accuracy, and there is no recall figure yet.

### 2.4 Guard audit and evidence-split diagnostics (method, reusable)

`testing/trials/model-ab/guard-audit.ts` re-evaluates every relation row against each promotion predicate independently and compares with the persisted reason. Finding: **the persisted reason is not the guard's reason** — 10 of 12 parked rows (qwen bank) and 82 of 99 (NuExtract bank) disagree; rows stored as `unsupported` are in fact `endpoint-unnamed`, `quote-not-verbatim`, or `open-vocab`. The note trail is not an audit trail without recomputation. Per-predicate failures and the 2×2 (label-valid × evidence-valid) separate the models' problems: qwen's failure splits between label and evidence; NuExtract's is almost entirely evidence (93 of 99 rows carry a legal label over a quote that does not establish the tie). `evidence-split.ts` buckets endpoint-naming failures (alias / adjacent / same-sentence / split-across-sentences / absent): for qwen 23–30% of candidates have both names on the page but never in one sentence (the measured cost of the one-sentence proof rule); NuExtract's largest bucket is absent-from-cited-passage, of which 31 of 99 rows never co-occur in any sentence in the book.

---

## 3. The judge: identity, titles, stability

Model: **`gpt-oss:20b` with `think: "low"`** — at 2,048 and 8,192 output tokens it produced 0 content characters with `done_reason: "length"` (29,546 chars of thinking at 8k); `think: false` is silently ignored by this Ollama build; `think: "low"` works (456 thinking / 4,480 JSON). `llm.ts` accepts `think: boolean | 'low' | 'medium' | 'high'`. Trial scripts: `judge-variants.ts`, `blind-gold.ts`, `blind-gold-cite.ts`, `calibrate.ts`, `pair-evidence.ts` (concluded: not viable, evidence too thin), `reason-check.ts` (concluded: flags everything), `three-way-sheet.ts`.

| Prompt variant (same 42 rows) | Precision | Recall |
|---|---|---:|
| boolean "lasting relationship" | 0.72 | 0.65 |
| **three categories: establishes / reinforces / mentions / none** | **0.78 (0.83 incl. reinforces)** | 0.70 (0.68) |
| passage-bounded | 0.71 | 0.50 |

Labels on the 42: 20 establishes, 2 reinforces, 16 mentions, 4 unclear. Error profile — two concrete defects, both prompt-fixable: **identity** (Plagueis–"The Muun" partner, Palpatine–Sidious colleague — same person twice) and **titles** (all seven misses are family titles: Aunt Petunia/Harry ×2, Uncle Vernon/Harry, Vernon+Petunia, Dudley/Vernon, Great Auntie Enid/Great Uncle Algie — every establishment miss is a title). Track separately: 1 reinforces miss, 1 genitive FP ("son of Damask's officer"). Zero regressions on rows already correct. Stability: **6 of 42 flip (14%)** — majority of three runs required.

WHATS-NEXT order (unchanged): one prompt variant (two names ≠ relationship; title establishes what it names) → stability → apply winner to candidate pairs → re-label a whole-book sample with `relId` on every row.

---

## 4. Kinds are concepts, not words (shipped)

Each concept has a description (what it is, how it differs from its neighbour) and a direction: **directional** (`enemy`, `mentor`, `teacher`, `bullied`, `protective of`, `obeyed`, `loyal to`, family set — direction checked, reversals refused) or **symmetric** (`disliked`, `admired`, `trusted`, `feared`, `friend`, `sibling`, `cousin`, `colleague`, `partner` — stored once, either order). Guard checks: label is a closed concept; the model's `kind_source` appears verbatim in quote or anchor (label itself need not); the anchor's sentence links it to both endpoints; direction enforced only where directional. The `kind_source` substitution loophole is closed (`enemy of` can no longer ride on "hated").

Measured: qwen3.5:9b ×3 runs — 6/6 concept mappings stable each run, 0 false, 0 wrong pairs (locally measured). One earlier 5/6 run emitted `loathed` as a label: it parked rather than banked. Ontology decisions 2026-10-29: absorbed same-concept wordings (friend/friendship/teammate; spouse/wife/husband/married; sibling/brother/sister; parent/mother/father/son/daughter/child kept alongside generics); added `rival of`, `acquaintance`, `guardian of`, `employer of`, `customer of`, `owner of` + affect family; removed duplicates (`married to`, `partner with`, `assistant of`) and non-relationships (`standing next to`, `blocked by`, sentence-long pseudo-labels). Rule: usage in one book never deletes a concept.

---

## 5. Readers compared (same 10 priority windows unless stated)

All runs: same book, same windows, same seed, fresh DB. `provable` = closed kind + both names + tie word (looser than `canPromote`, which adds verbatim quote + direction).

| Model | Relations | Closed | Both named | Tie word | Guard-eligible | Time |
|---|---:|---:|---:|---:|---:|---:|
| qwen2.5:7b Q4 (incumbent) | 28 | 14 | 1 | 16 | 0 | 3m50 |
| qwen2.5:7b Q8 | 15 | 2 | 3 | 12 | 0 | 6m06 |
| qwen3:8b | 15 | 8 | 3 | 9 | 0 | 6m41 |
| llama3.1:8b | 15 | 10 | 1 | 5 | 0 | 8m13 |
| qwen3.5:9b Q4 ×3 | 22/26/37 | 11/17/23 | 6/5/10 | 13/13/16 | **1/1/1** | 5m31–59 |
| qwen3.5:9b Q3 ×2 | 11/9 | 5/5 | 1/4 | 7/5 | 0/1 | 4m07–17 |
| NuExtract3 default | 83 | 11 | 12 | 43 | 0 | 7m12 |
| NuExtract3 strict | 99 | 95 | 10 | 11 | 2 | 5m17 |
| NuExtract 1.5 | 8 | 0 | 1 | 5 | 0 | 6m58 |

What this establishes: qwen3.5:9b Q4 is the only chat model that produced guard-eligible ties, in all three runs; the same two pairs recur (reliable quoting discipline, not broad discovery). Q4 (5.68GB weights, 6.1GB loaded) is the quantization floor — Q3 halves yield. NuExtract is a span-copier: strict mode obeyed the closed list (95/99) but its 48 strict quote retries all failed — the constraint is the text, not the model. Plausible remaining use: targeted pair probing with the pair given (untested). Name finding is not the bottleneck (roster holds ~87%; NuExtract3 found 93 names, 81 already on roster; "new" names mostly artifacts). Hardware: two parallel decode slots on the 16GB dev card; full book ~55 min qwen3.5 at concurrency 3 (~3× at ship concurrency 1); 6.1GB on 16GB ≠ 6.1GB on an 8GB box with a compositor (unmeasured headroom).

Full-book runs (same model, same book): eligible 2; 7–9; 3; 1; 8; 2 — variance dominates. The ten windows are the richest (`bridge×50, names×10, relations×10`), so per-window rates overestimate the book. 33-window free-vs-free duel: NuExtract 186 verifiable quotes (~182s) vs qwen free 118 (~146s); qwen feast-or-famine (11/33 windows zero verifiable, 4 unparseable), NuExtract yielded on 32/33. Wider-window stress: 2× input → filler loop, zero ties; 4× → confident hallucination (invented mission, wrong book ID). Operating point stays ~8 passages. Verdict recorded: **muzzle the bank, never the reader** — free recall, gated banking. The NuExtract-as-reader wiring was later closed: the recall fix was the prompt, not the model.

Session-finding addenda (cf5e591): NuExtract3 safetensors (8B, local transformers+CUDA), pinned window, 13 ties with exact quotes; GGUF Q4_K_M via Ollama (3.5GB, Apache-2.0) ~12 relations, 7.5s wall (~190 tok/s), format imperfect; NuExtract3-W4A16 does not run here (dequant crash); MLX build wrong hardware; LoRA notes: per-book LoRA rejected (breaks verifiability), skill-LoRA open, book-LoRA = installed contamination.

---

## 6. Candidate generation: sweep, scan, notes, pairs

- **Sweep** (`lore sweep`, shipped): per-character ledger in reading order, line-number quotes fetched by index, derived pairs filed as proposals — never `canon_relation`, never overwrites, skips keeper pairs. 77 characters → 133 proposals (122 distinct pairs), 132 verbatim, but **9 in 10 quotes name one person — a queue filler, not proof**. Run-to-run: 59% pair agreement, 25% label. `lore relationships` / `lore proposals` collapse inverses and duplicate roster rows.
- **Sentence scan** (`scanSentenceCandidates`, 25-token name window + tie phrase within 10): 62 candidates → 15 accepted; reading all accepted rows: ~6–7 true; error mix 3–4 direction-reversed, 3 alias/wrong-pair, 4–5 incidental. Direction was the top error — fixed by taking pair order from the judge's `from`/`to`, refusing verdicts that name neither endpoint. Page-wide tie word tried and reverted (invented spouses, reversed master). Name-anchored windows: 0 of 80 sampled — dropped.
- **Notes accumulator**: 125 pending notes, 23 multi-span, 16 naming both across spans, 12 with a tie-stating span — **0 of 125 promoted**. The span with the tie word never holds both names; the spans with both names never carry the word.
- **Identity**: nested names refused ("X" inside "Captain X"); transitive alias-chain grouping reverted (one bad alias merged six entities); suspect characters quarantined (one mention + no alias + lowercase occurrence in text → `quarantined`, excluded from scan/promotion until a second mention or real alias).
- **Direction**: enforced for directional concepts; reversals refused; sweep emitted `Vernon (wife/husband)` + `Vernon (husband)` for the same pair — canonicalisation must run before direction checking.
- **Generic kinship**: `relative of` requires the text to say relative/kin/relation/family (kin-word co-presence refused; "only living relative" accepted).
- **Unproposed pairs** (~3,100 co-occurring pairs, no row): 80-row stratified sample (co-occurrence 1/2–3/4–9/10+ × book thirds, seed 42), mechanical packets (all shared passages cap 6, one sentence context, locators, nothing about bank status), independent long-context judge verdicts A (single-sentence quotable) / B (multi-sentence) / C (not a relationship) / D (indeterminate) with Wilson-weighted scoring; scaffold prints PENDING until verdicts exist. Paste-ready prompt in NEXT-STEPS appendix. Caveat: absence from the bank is not proof of extraction failure.

---

## 7. Chunking, windows, costs

Two chunkers exist. The old one produced 1,448 passages for the test book by duplicating text; the rebuilt one (word-bounded sentence overlap, no duplicate chunks — commit `b4ee4d9`) produces 738 (527 for a shorter book). The live bank still uses the old chunker; every session experiment used the rebuilt one. **Session-reported defect (re-verify before citing):** the old bank stores the novel's text ~2.95× — 2,153,102 stored chars for 730,910 source chars; 1,370 of 1,447 adjacent pairs are literal substring pairs; one extraction window carries ~19k chars but ~5.9k unique. Consequence if confirmed: corroboration counts, co-occurrence counts, timings, and passage counts are all inflated. Rebuilt-bank promotion (Task B) requires: entity/relation/kind/keeper/fact/timeline count diff, rulings replay with every keeper resolving, `lore integrity` exit 0, backup first, no promotion if any keeper fails replay.

Windows: 8 consecutive passages (~1,500 words); split extractor makes three narrow calls per window (entities+facts, relations, events) because one large call loses the later schemas and one truncated answer loses the whole window (`parseExtraction` salvages complete records per section). Extraction over a full book: ~55 min (qwen3.5, concurrency 3). One-window smoke before any full run; `ps` after killing a run (orphaned extract fought a second run for 23 minutes); never two extractions on one GPU; never extraction when the question is judging.

---

## 8. Retrieval, answers, story pipeline

- **Retrieval** assembles passages (FTS5) + knowledge graph + story memory + character knowledge. Graph: PPR over all edges incl. mention edges; recognition filter drops dense seeds lacking lexical backing; passage trails (cap 6) record why a passage surfaced. Older round (EVALUATION.md, pre-fix harness, `hp.json` questions): graph variant 90% relation / 90% 2-hop recall, 94% evidence coverage, 45% quoted, 99% correct, in 1,457 words / 17ms; FTS5-only found words (100% answer terms) but not relations (43%/47%). Treat as a previous harness generation, not current numbers.
- **Answers:** muzzle + guard (above); keeper-denial caught with keeper quote + locator; omissions produce no issue; unsupported claims are not canon and not contradictions; provisional-denial notes visible via `issues --all`; model findings without chapter evidence dropped and counted.
- **Planner:** owns premise, divergence, structure, chapters. Known defects: `selectCanonEvents` by word overlap can anchor the wrong event (cast relationships + full canon index now passed in, commit `fe064aa`); outlines cite nothing. Canon-aware planner (Task C): keeper ties with evidence into drafting, provisional/parked marked, locators required, missing evidence as uncertainty, AU divergence recorded not rejected.
- **Writer:** sequential chapters, structured mid-draft context requests (deduped, capped). Older benchmark (RESULTS.md, 4 models, one chapter each): obedience 100% everywhere (characters, scenes, canonΔ 0 in all runs); differences are shape (sentence length, dialogue share), not obedience; prose quality NOT measured — blind packet built (`packet.md`, `brief.md`, `ratings.csv`, `key.json` held separately), model judge available as screen only. Treat all RESULTS.md model-vs-model tables as one-repetition-per-cell, preliminary, directional.
- **Continuity/state:** contradiction checks (older round: bigger models found more with more false positives); `state-conflicts.ts` records chapter-vs-state, never resolves; intentional divergence is recorded, not rejected. Three failure kinds kept distinct: contradicts canon (error) / contradicts AU state (error) / intentional divergence (recorded).
- **Events:** full-source event index (200-passage/200-event ceilings removed; chapter headings no longer indexed as events); `lore events --extract` reports Complete/Truncated truthfully; 392 canon events on the test bank.

---

## 9. External research intake

### 9.1 Standing rules for anything external

Local-only; TypeScript/Node; SQLite the only store of record; no new runtime deps without approval; ship ceiling 8GB VRAM; one heavy job at a time; universal machinery only (no book terms in `fanfable/src/` or `testing/tests/`); user confirmation for merges, commits, pushes, new machinery. Terms locked (GLOSSARY.md): never bare "gate" — **strict checker** or **RAGmodel**; chain = **logbook** (never judges); notes = **inbox**; enrich = **loopback**. No tuning without a frozen gold set; single extra 4B judge max; no model committees. Speed is a first-class goal for retrieval and deciding paths.

### 9.2 Literature with transferable findings (author-reported, unreproduced)

| Claim | Figure | Caveat |
|---|---|---|
| Book-scale coreference mature, still wrong ~1 binding in 5 | xCoRe 78.3 LitBank book splits; 42.4 ECB+; 31.0 SciCo | Best-in-class; failure is a silent wrong antecedent |
| Mention detection easy, cluster linking hard | Maverick XL: MUC 94.30, B³ 55.30, CEAFe 33.45, CoNLL-2012 61.02 | The gap is linking, not spotting |
| Character context drives literary performance, graph structure does not | GraphLit ablation over 12 tasks | Time-localised scene graphs are the right shape |
| Small task-tuned models beat zero-shot frontier LLMs on literary RE | SmolLM3-3B LitTune 0.833 vs GPT-5.4 0.578 literary; Qwen2.5-0.5B 0.83 vs 0.69 general; 0.92 vs 0.83 biographical | Positive-class micro-F1 (no-relation excluded); sentence-level; entity pairs supplied; silver labels |
| Prompt-conditioned adapters emit their training ontology, not ours | LitTune prompt has no candidate label list | Label coverage measured before accuracy |

### 9.3 Artifact register (role + licence + verdict)

| Artifact | Role considered | Licence | Verdict |
|---|---|---|---|
| xCoRe / BookCoref | binding baseline, evaluator, proposal source | models **CC-BY-NC-SA**; code unlicensed | research only; never auto-accept from a binding |
| GraphLit | design evidence for context grounding | paper CC-BY-4.0 | no code adopted |
| BookNLP (Java + Python) | speaker attribution, scene fields | Python **MIT**; Java unlicensed | borrow fields, not code |
| compact-relex / LitTune adapters | literary pair classifier (Arm C) | adapters **MIT**; some datasets unlicensed | test after E0; GLiREL fallback (accepts arbitrary labels) |
| ARF (`Despina/project_gutenberg`) | fiction relations + 37% no-relation negatives | **MIT** | negative baseline + mapping corpus |
| PG-Fiction relations (146,579 train / 48 labels / 0-2-5-shot prompts) | literary RE training set | **unstated** | map 48 labels first |
| Biographical (238k subsampled) | literary/biographical rows | **MIT** | auxiliary |
| LitTune / GenTune / MixTune mixtures | paper-recipe convenience | **unstated** | skip unless reproducing |
| RE-DocRED, NYT11, REBEL (CC-BY-SA), GIDS ("other"), SemEval | controls only | mixed/undeclared | not training data |
| SmolLM3-3B LitTune adapter (483MB) | best literary classifier candidate | **MIT** (base Apache-2.0) | Arm C lead |
| Qwen2.5-0.5B GenTune adapter | cheap harness baseline | **MIT** | validate scoring cheaply |
| Llama-3.2-3B adapters | — | Llama 3.2 licence | skip unless SmolLM3 fails |
| GLiNER-Relex (466M DeBERTa, zero-shot spans+relations) | discoverylane proposal source | Apache-2.0 | spike on frozen windows; Python sidecar, dev-only |
| GLiREL | relation classifier on supplied spans | code Apache-2.0 (PyPI); **weights undeclared** | Arm C fallback; local research only |
| NuExtract-1.5-tiny (494M, template→spans) | extraction-first candidate (Arm A) | **MIT** | spike before Relex; `trust_remote_code` inspected or GGUF |
| GLiNER2.5-base (194M CPU span finder) | span floor | permissive (confirm) | queued behind classifier |
| RAG-Gate-4B (abstain/router) | router/abstain candidate | confirm | deferred, phase-batched, never per-query |
| ModernBERT reranker (`gte-reranker-modernbert-base`) | lexical-rank rescue | Apache-2.0 | only if frozen paraphrase set proves FTS miss; needs onnxruntime or sidecar |
| RAGmodel (4B bouncer: Answer/Retrieve/Stop) | deciding-path judge | n/a (internal) | deferred; frozen-contract shape (binary decision, dangerous error first, fixed prompt/schema/decode, JSON repair, reason as hint) |
| NovelQA (89 novels, 2,305 questions, >200k-token avg) | second-book benchmark | gated access; use public-domain only | stratified 50-question sample; state the claim honestly |
| SARL (arXiv 2610.30435) | search-state awareness idea | paper CC-BY-4.0; checkpoint unusable (30.5GB F32, no code/prompt) | take typed gaps, not the model |
| Sentinel-gate (4B LoRA, ESCALATE/DECIDE) | decision-gate template | Apache-2.0 | copy the reporting shape, not weights |
| RouteWeaver-4B / EvoRouter-4B | router cost/accuracy operating points | Apache-2.0 | copy the policy-table accounting; pools are cloud-only |
| Local Minutes contextualizer (4B) | contextual-retrieval technique | Apache-2.0 | technique only: notes in a separate index, never evidence |
| OneKE (13B schema-guided IE) | schema descriptions | **CC-BY-NC-SA** | model no; keep one-line kind definitions +/− examples |
| ReLiK (+`relik-cie-small`) | retrieve-then-read linking | confirm | no — KB-dependent; fiction names aren't in it |
| npcpy | approval-queue pattern | MIT | ideas only; `source_text` unverified, dream facts in-store |
| Symbiotic-1B | — | — | no; card describes an architecture absent from the files |
| DualMind (1.7B explore→examine→response) | planner self-critique shape | Apache-2.0 | pattern only: adversarial examine pass on drafts |
| Mistral-RAG (Italian SQuAD 7B) | extractive-vs-generative | Apache-2.0 | no; extractive mode without quote-checking is just style |
| SMOLM2Prover (362M math) | — | Apache-2.0 | no; wrong domain |
| Sentiment-7B (support-ticket rubric) | — | MIT | no; wrong domain, 72.8% on 3 classes |
| Wordle/OpenEnv SFT+GRPO | train-against-checker recipe | — | log the recipe; gated on frozen set + chunk fix |
| VKORE-325M (NPU pretraining demo) | honest-evaluation example | Apache-2.0 | no; 256-byte context, base LM only |
| ContextPilot (Tencent, agentic RAG) | — | — | no; Elasticsearch + 8-GPU RL, wrong shape |
| Neo4j text-to-KG tutorial + importer docs | anti-pattern reference | — | no code; demo shows role confusion, entity overlap, literal relations, no provenance |
| PyMuPDF / pypdfium2 | PDF engines | AGPL / Apache-2.0+BSD | no; PDF text already clean (0 replacement chars, 2 hyphen artifacts) |
| Unstract / Pathway | doc platform / streaming ETL | AGPL / BSL | no; violate local-only and dependency rules |
| RAPTOR / community GraphRAG / LightRAG / MemoRAG / MiRAG / HELP / HKVM / IGMiR / ConRAG / CatRAG / NeocorRAG / NKW / AtomicRAG / ToG / AAR | summary-graph families | various | rejected: summaries pollute grounding, per-query reweighting, no provenance |
| HippoRAG2 PPR idea | PPR context | — | adopted the PPR mechanism, rejected the rig (LLM OpenIE without quotes, dense seeds, no ledger) |
| ReLiK-adjacent closed-ontology extractors, ExtractionDataset, Gemma-12B-rel, name-sort GPT-2, 15-row eval sets | — | — | killed in triage (closed ontology, licence, capacity, or sample size) |

Corrections welcome: anything here whose licence or figure I could not re-verify in this pass is marked; check the card before depending on it.

### 9.4 Deferred list, in order, with the conditions that change each

1. **GLiNER-Relex triage spike** → adopt iff new verified keepers ≈1 per 10 proposals, <1 min/window CPU; kill iff mostly `appears_with`, direction wrong, or >90% rejected.
2. **NuExtract-as-reader wiring** → closed; the recall fix was the prompt, not the model. Reopen only if a frozen probe shows reader-limited (not rule-limited) failure.
3. **Caps/quotas tuning** → concluded: touch nothing while the sheet holds.
4. **RAGmodel spike** → frozen router probes (route accuracy, over-refusal, unsupported rate with CIs, first-token latency); adopt iff faster AND ≤ unbacked; stays phase-batched, never per-query.
5. **GLiNER2.5-base CPU spike** → adopt iff verified spans the 7B missed without flooding the checker.
6. **Planner slot** (temp 0.7→0.3, versioning fix, own quote-or-openQuestion frozen set) → after the classifier track; temp change needs its own diff + harness.
7. **Fine-tune against the strict checker** (Wordle/GRPO recipe) → only with a frozen set, the chunk fix landed, and a demonstrated model-capability (not input-quality) failure.
8. **ModernBERT reranker** → only if a frozen paraphrase set proves the lexical ranker misses top-4.
9. **Second-book run** (NovelQA public-domain novel) → after the assertion rule is stable; proves universality the code search only asserts.

---

## 10. Standing judgments

- Precision is solved (0 wrong surfaced on the verification re-run); recall is the open problem.
- The bank is the exam — any future extractor sits it, gated, with the frozen sheet as judge.
- Free recall, gated banking: prompts stay exhaustive; only proven rows bank.
- Per-book model tuning is rejected (breaks verifiability); the NuExtract-as-reader wiring was closed.
- No new machinery while the sheet has open failures. No tuning without a frozen gold set. No model committees. Single extra 4B judge max.
- Tier B stands: no automatic `accepted` from a pronoun binding — even the best binders err ~1 in 5, silently. Confirmed bindings become `user_confirmed`.
- Scene → event is schema, not pipeline; context notes are a separate index, never evidence.
- Never relax proof to raise counts; never add kinds for a yield of two rows; never treat a relationship word as proof; never let a model set a status; never splice quotes.
- Titles strip from both sides and match as a contiguous run containing the surname; "Aunt Petunia" never proves a tie to whoever stands next to her; a title alone leaves direction unknowable.
- Human rulings of record: Damask → Hego Damask MERGE; Palpatine → Darth Sidious MERGE.
- Agreement is not truth: 59% pair repeatability with 16.7% support; two judges agreeing is correlated error, not evidence. There is exactly one checker: `canPromote`.
- Proposal generators (NuExtract, GLiNER-Relex, GLiREL, LitTune, OneKE, ReLiK, routers, adjudicators) propose into the inbox; none adjudicates. Adjudication requires a ruling, and a ruling is the one thing a model cannot supply.
- Scope fence, typed gaps, mode-cost table, and overlap fix are specified but unbuilt at this writing — check the code before assuming they exist.

## 11. Open gaps and next experiments

1. **E0** — map the 48 ARF relations onto the concept set; measure coverage and the no-relation false-positive rate (afternoon, no GPU). Decides whether the classifier track is viable.
2. **E1** — binding accuracy: xCoRe vs the unique-antecedent heuristic on 20 frozen scenes; never auto-accept.
3. **E3** — speaker attribution on one chapter (BookNLP reference); size the scene layer.
4. **E2** — literary classifier (SmolLM3-3B LitTune) on the same 20 windows; needs negative precision + keeper recall.
5. **E4** — QLoRA fine-tune only if E0/E2 justify it: 5–10k stratified rows, mapped labels, book-level splits.
6. **Full extraction on the test book** with the tightened rule, accepted set adjudicated blind — replaces the candidate-pool number with a bank-level one.
7. **Whole-book long-context read** as a dev oracle (~$0.05, ten minutes) to produce the missing denominator and the missed-tie list.
8. **Scene routing rule** — apply the classifier so `scene` rows become event candidates instead of being discarded.
9. **Unproposed-pairs measurement** (NEXT-STEPS Task A) — the largest unmeasured population.
10. **Bank promotion replay** (Task B), **canon-aware planner** (Task C), **second book** (Task D).
11. **Prompt variants on the frozen set:** schema descriptions (one plain sentence per top-ten kind +/− examples); planner self-critique (adversarial examine pass, then revise).
12. **Measurement hygiene:** freeze the 50-row probe before the chunk fix; label every report with the bank it used; `lore integrity` after any change.

### 2026-10-30: half-book funnel, backfill, attested re-measurement (plagueis-half.db)

Funnel (352 distinct triples denominator; mutually exclusive single-outcome stages): endpoint-unnamed 262 (74.4%, pipeline refusal); kind-open-vocab 22 (6.3%, semantic, unclassified); no-quote 21 (6.0%, extraction failure); tie-word-absent 11 (3.1%); ruled-park 8 (2.3%); identity-contained-name 4 (1.1%); quote-not-verbatim 4 (1.1%); kind-moment 1 (0.3%); passes-all 3 (0.9%). Stored quote pipeline (overlapping, sums past claimed): verified 283, repointed 117, dropped 208, unsupported 37, unresolved 7, unrelated 10, claimed 608 over 33 windows. Assessments scored 0/336 pre-backfill (??1.0 class: 257 at 1.0, 79 at 0.7); semantic model/policy split 0/0 (all unclassified, no stored verdicts).

Backfill (`assess --write`, qwen3.5:9b, disposable copy): 314/314 assessable rows scored, 22 non-verbatim skipped (unscoreable without fabrication). Bands: <0.5: 205, 0.5–0.6: 0, 0.6–0.7: 14, 0.7–0.8: 0, 0.8–0.9: 21, 0.9–1.0: 74; 95 at/above 0.7; user_confirmed average 0.624. Runs vary band-to-band (model nondeterminism across three runs).

Re-measurement (committed code only, assessed copy): 262 endpoint-unnamed rows → attested 0, keeper-grade +3 accepted in-set (2 of the 3 fail strict verbatim), 24 pre-existing user_confirmed untouched, still provisional 2, still needs_review 206. Other 74 → 1 keeper-grade (fails strict), 0 attested, still provisional 5, still needs_review 58. Fallback promotions without assessment: keeper 0, attested 0 (1 fallback row remains, non-verbatim, promotion-inert). Before/after: {needs_review 291, provisional 11, user_confirmed 34} → {needs_review 264, provisional 7, user_confirmed 34, accepted 4, attested 27}. Integrity on copy: exit 1, 3 violations (accepted quote-not-verbatim). Real bank untouched throughout.

E0 coverage (user-reported, not locally measured here): 64% same-concept, 71% mass in 9 labels; invention rate still open.

## 12. What this document could not verify

- **Session-reported figures not re-checked against runs in this pass:** the 2.95× chunk-duplication measurement (recompute from `plagueis-half.db` before citing); the reader/judge wall-times and token counts; the 59%/25% sweep-agreement split beyond the REPORT-final table; any model-card number in §9.2–9.3 (all author-reported by construction).
- **Licences marked "confirm"/"unstated":** PG-Fiction relations, LitTune/GenTune/MixTune mixtures, RE-DocRED, NYT11, SemEval, GIDS ("other"), `xcore` library code, ReLiK weights, RAG-Gate-4B, GLiNER2.5-base. Check the card before depending on any of them.
- **Live-doc drift:** bank counts (164 relations etc.) and suite size (609 green at last full run) are dated 2026-10-29; re-run `lore status` and the suite rather than quoting this file.
- **Missing from git:** adjudication keys (by design — never commit them); run databases, sheets, and logs (by `.gitignore` design); the books themselves. Every reproduction command assumes the local `testing/trials/` data and `RESOURCES/` are present.

## 13. Evidence web vs the locked 20-pair sheet (2026-10-30)

**Method.** `testing/trials/benchmark/validate-web.ts`, read-only against a copy of the `halfbook` trial bank
(360 entities, 373 notes, 183 meetings, 35 births). Pair list from `BENCHMARK.md` sec. 2, stored as local data
so no book names live in committed code. Resolution is by canonical name and derived variants only; an
ambiguous or absent name is reported, never guessed.

**Verdict: FAIL, 3 of 4 hard criteria.**

| criterion | result | counts |
|---|---|---|
| zero births on absent controls | PASS | 0 births across 5 controls |
| alias traps never birth; T3/T4 flagged | FAIL | 0 births across 5 traps; T3 and T4 not flagged `identity-collision` |
| S1-S3 each hold a note at or above 0.35 | FAIL | S1, S2, S3 unresolved or 0 qualifying notes |
| C1 holds a note at or above 0.35 on the early book | FAIL | 0 early qualifying notes |

**Resolution: 13 of 20 pairs unresolved.** Ambiguous (canonical form matches more than one entity): S1 (`Kim`),
C1/C2/C3/T3 (`Plagueis`). Not found: S3, T1, T4 (`Emperor Palpatine`), T5, A1, A3, A4, A5. Resolved: S2, S4, S5,
C4, C5, T2, A2.

**What the failures are, reported not fixed.**

- The bank holds two rows for one person in several places (`Pax Teem` / `Senator Pax Teem`; `Palpatine` /
  `Senator Palpatine`) and five `Plagueis`-named entities that are distinct people. These are same-person
  duplicates the collision pass cannot see, because it groups canonical forms and these forms differ.
- T3 and T4 are exactly those same-person short forms, so the identity criterion fails on the sheet as written.
- Four absent controls have no entity at all. For a control that is the expected state and is reported as
  `not found`, not as an error.
- Where a pair resolved, C4 carried 15 notes (2 qualifying) and 2 `pooled_evidence` births at combined score
  0.725; the sheet treats its direction as informative only. S4, S5 and C5 hold pair threads with no notes and
  no births.

No threshold, tier, trigger or admission rule was changed to produce this record.

## 14. Identity by relationship, and the same 20-pair sheet re-run (2026-10-30)

**What changed.** Collision detection now groups rows when `nameRelation` says `same` or `containment`,
not only when two canonical strings are equal. A containment edge counts only when the shorter form could
name someone on its own: a token of length >= 3, no title, no token carried by more than `NAME_DF_CAP`
entities, and no form contained in more than `NAME_GROUP_CAP = 8`. Name resolution moved into
`identity.ts`: exact name, then alias, then guarded containment, then `ambiguous` or `absent` - never a guess.

**Collision pass on a fresh copy (360 entities).** 36 groups: 9 same-form edges, 52 containment edges.
82 entities newly flagged, 12 already flagged from the earlier pass, 0 quarantined skipped, 0 pairs
rejected by the group cap. Second `--write` flagged 0 new. Nothing merged, renamed or re-kinded.

**Ingestion and meetings unchanged by the pass:** `notes-ingest` added 0 notes and 0 open ends;
`lore meet` created 0 meetings and 0 exchanges (183 reused); `lore integrity` exit 0;
`canon_relation` / `canon_tie_note` / `canon_tie_hint` still 336 / 98 / 0.

**Benchmark re-run, same sheet and same four criteria: FAIL (3 of 4).**

| criterion | result | counts |
|---|---|---|
| zero births on absent controls | PASS | 0 births across 5 controls |
| alias traps never birth; T3/T4 flagged | PASS | 0 births across 5 traps; T3 and T4 flagged |
| S1-S3 each hold a note at or above 0.35 | FAIL | S1 ambiguous, S2 and S3 resolved with 0 qualifying notes |
| C1 holds a note at or above 0.35 on the early book | PASS | 1 early qualifying note |

**Resolution moved from 7 of 20 resolved to 14 of 20.** Moved from unresolved to resolved: S3, C1, C2, C3,
T1, T3, T4. Still ambiguous: S1 (`Kim`, two candidates - Senator Vidar Kim and Ronhar Kim). Still absent:
T5, A1, A3, A4, A5 (no such entity in the bank; for the controls that is the expected state).

**Where the remaining failure is.** The recall floor is not about names any more; it is about evidence.
S2 and S3 resolve and own pair threads (2 and 1) but carry no note at or above 0.35. S1 cannot be judged at
all until `Kim` is disambiguated in the bank, which is a human ruling, not a matching rule.

**Informative rows.** C1/C2 (one pair, two scopes) carry 3 notes, 1 qualifying, and 2 `pooled_evidence`
births at 0.725. C3 carries 8 notes (4 qualifying) and 30 `pooled_evidence` births at 0.821, reading
A to B. C4 carries 15 notes (2 qualifying) and 2 births at 0.725. S4, S5, C5 and T1 own pair threads with
no notes and no births. No threshold, tier, trigger or admission rule was changed to produce this record.

## 15. Birth subject, duplicate births, and the first automated score (2026-10-30)

**What changed.** A birth now takes its subject from the evidence that was pooled, not from the meeting that
held it: the pair key with the most pair-scope contributions wins, and a person subject is used only when no
pair contribution exists. A child that would duplicate one of its parents is refused and counted
`child-equals-parent`, with the investigation identity including the period label so a combined child is not
mistaken for a copy. Before creating a child the run looks for a live born thread of the same subject: if one
exists the new evidence is attached to it as references, wants carry over, no birth row is written, and the
event is counted `birthsEnriched`. `lore births --reconcile [--write]` marks every extra born thread of a
subject dormant, lowest id staying live, appending `superseded-by:<id>`; dormant threads leave meeting
candidacy. Nothing is deleted or merged and no note is touched.

**Copy run** (`m10`, fresh from the pre-milestone bank): `threads --sync` 0 created; `notes-ingest` 0 notes,
0 open ends; first `lore meet` 0 created, 183 reused, 0 births (all 35 legacy births already had meetings,
so `one-per-meeting` 35). `births --reconcile --write`: **2 duplicate subjects, 31 extra threads, 31 marked
dormant.** Born threads went 35 -> 4 live, born subjects 4, duplicate subjects **0**. Second `lore meet`:
0 created, 0 births. `lore integrity` exit 0; `canon_relation` / `canon_tie_note` / `canon_tie_hint` still
336 / 98 / 0; 373 notes unchanged.

**Benchmark, same four criteria: 2 of 4, FAIL.** Precision passed (0 births on the five absent controls).
Identity failed because this sequence does not run `identity-check`, so T3/T4 were not flagged in this copy -
the M9 pass on that criterion came from running the collision pass, which this order omits. The recall floor
still fails: S1 is ambiguous (two candidate rows), S2 and S3 resolve but hold no note at or above 0.35. C1
holds one early qualifying note.

**Automated score (verbatim, one line):**

```json
{"criteriaPassed":2,"criteriaTotal":4,"absentBirths":0,"trapBirths":0,"trapFlagged":0,"recallS1S3":0,"c1Evidence":1,"resolved":14,"ambiguous":1,"absent":5,"bornThreads":4,"bornSubjects":4,"duplicateBornSubjects":0}
```

Exit code 1, matching `criteriaPassed != criteriaTotal`. The line is the comparison point for later runs.

**Honest notes.** The copy carries legacy births made by the old rule, so the run measures the reconciled
state rather than a clean re-birth; the new subject rule is proven by unit tests (a pooled pair produces a
pair child, a repeat pooling enriches instead of birthing, a parent-copy is refused). `pooled_evidence` on a
pair whose legacy thread is a parent is now refused rather than birthing a copy, so real-data births are
expected to come from combined investigations where pooled evidence does not fire first. No threshold,
criterion or policy was changed.

## 16. Score reproducibility: collision status read from the data (2026-10-30)

**What changed.** The benchmark harness no longer reads `review_status` to decide whether two names are the
same identity. It computes the relationship from the rows themselves - `nameRelation` over names and aliases
with the same usability guards the collision pass uses (token of 3+ characters, not a title, token frequency
within `NAME_DF_CAP`, group size within `NAME_GROUP_CAP`) - so the scored value cannot depend on whether
`identity-check --write` happened to run first. The stored answer is still reported, as `trapFlaggedDb`,
beside the computed one, `trapFlaggedData`; only the computed value enters the criteria. Nothing is written
to any bank.

**Two copies, same data lineage, different pipeline history.**

Copy A - `m10`, no `identity-check` ever run:

```json
{"criteriaPassed":3,"criteriaTotal":4,"absentBirths":0,"trapBirths":0,"trapFlagged":2,"recallS1S3":0,"c1Evidence":1,"resolved":14,"ambiguous":1,"absent":5,"bornThreads":4,"bornSubjects":4,"duplicateBornSubjects":0,"trapFlaggedData":2,"trapFlaggedDb":0}
```

Copy B - `m11b`, `identity-check --write` run first (36 collision groups, 82 entities newly flagged):

```json
{"criteriaPassed":3,"criteriaTotal":4,"absentBirths":0,"trapBirths":0,"trapFlagged":2,"recallS1S3":0,"c1Evidence":1,"resolved":14,"ambiguous":1,"absent":5,"bornThreads":4,"bornSubjects":4,"duplicateBornSubjects":0,"trapFlaggedData":2,"trapFlaggedDb":2}
```

Every key that feeds the criteria is identical, including `criteriaPassed`, `trapFlagged` and
`trapFlaggedData`. The only differing key is `trapFlaggedDb`, which is the reported stored value - 0 on A, 2
on B - and it is precisely the quantity that varied with pipeline order before. It no longer decides anything.
Both runs exit 1.

**Criteria, identical on both copies: 3 of 4.** Precision passes (0 births on the five absent controls),
identity passes (0 births on the five traps; T3 and T4 flagged by the computed check on both copies), C1 holds
one early qualifying note. The recall floor still fails: S1 is ambiguous, S2 and S3 resolve with no note at or
above 0.35.

No criterion, threshold, tier, trigger or admission rule was changed. No bank was written by the harness.

## 17. Never-cold reads and visible contradictions (2026-10-30)

**What changed.** Window selection now reserves windows for starved threads before the priority pass: threads
with no notes first, then the oldest unresolved question, then the fewest notes, then the lowest id. Each
starved thread is mapped to the windows its passages fall in, a window scores the number of distinct starved
threads it covers, already-mined windows are dropped, and up to `starvedFirst` windows are taken in descending
score then ascending index. The default reserves a quarter of the budget (1-4), or 4 when no budget is set;
`--starved-first 0` restores the previous selection exactly. Notes now remember the concept they asserted
(`claim_kind`), and opposition between two notes on one thread is recorded as a visible conflict, never as a
ruling. The opposition set is closed and small (enemy of/ally of, enemy of/friend, trusted/distrusted,
feared/protected by, loved/hated, loyal to/betrayed); across threads the same opposition is change over time
and is left alone.

**Copy run** (fresh from the pre-milestone bank, 360 entities): `threads --sync` created 182 person and 6,267
pair threads (4,200 later periods); `notes-ingest` wrote 373 notes (pair 151, identity 222, context 103), 103
of them context, with 6,370 open ends; `lore meet` created 183 meetings, 678 exchanges and 2 births
(`pooled_evidence` 1, `combined_investigation` 1), 116 below-threshold skips. Second `notes-ingest`: 0 notes,
0 open ends.

**claim_kind populated:** 171 of 373 notes carry a kind (29 `ally of`, 12 `master of`, 7 `opponent of`, 6
`enemy of`, and a long tail); 202 are empty (identity and context notes). **Conflicts created: 0.** Nine
threads hold two or more distinct claim kinds, but none of them is one of the six opposed pairs, so the
detector correctly wrote nothing. A second run also wrote nothing.

`lore integrity` exit 0; `canon_relation` / `canon_tie_note` / `canon_tie_hint` unchanged at 336 / 98 / 0;
373 notes. No extraction was run, so the starved reservation is measured by unit tests only (ranking, window
mapping with gaps, mined exclusion, budget respected, `starvedFirst 0` equivalence).

**Honest note.** The 0-conflict result is a property of this bank and this narrow opposition set, not evidence
that contradictions cannot occur: the closed pairs are the only comparison, and same-thread opposition across
them did not appear in this data.

## 18. Assessment-aware routing, attested CLI, enumeration filter (2026-10-30)

**What changed.** Note routing now follows what the assessment says a quote is, not only its number: a scene
(no both names, not asserted, or hedged) is context whatever its strength, a one-sided assertion stays an
observation, and unassessed rows behave exactly as before. `lore attest [--write]` wires the existing
`assignAttestedTiers` (temp-path guard on write, dry run by default). Meeting enumeration now drops candidates
whose two threads both hold no note, reporting `candidatesSkippedNoNotes`. `lore ties --assessment` prints the
stored assessment per supporting item and falls back to the relation evidence when the item has no quote. The
unused `directness` field was removed from the two docs that described it.

**Copy run** (`m15b`, from the assessed `m13` copy; note rows cleared on the copy so they regenerate under the
current routing): 373 notes (pair 151, identity 222, context 12), strength sources assessed 171 / derived 202,
open ends 0 after the rebuild. **Context notes 12 - non-zero, where the regression produced 0.** Meetings
1,039 created with 3,558 exchanges and 13 births (`pooled_evidence` 3, `combined_investigation` 10);
**candidates 56,978** against 1,168,644 before the filter. `lore integrity` exit 0; `canon_relation` /
`canon_tie_note` / `canon_tie_hint` unchanged at 336 / 98 / 0.

**`lore attest` on the same copy.** Dry run: checked 302, would attest 26, keeper-track 6, blocked by
`open-vocab` 146, `coverage-only` 75, `endpoint-unnamed` 15, `quote-not-verbatim` 11, `assessment-missing` 11,
`assertion-missing` 9, `ruled-park` 2, `same-identity` 1; status counts unchanged. `--write`: attested 26,
status `needs_review` 291 -> 265 with `attested` 26 (provisional 11, user_confirmed 34 unchanged). Second
`--write`: checked 276, attested **0**.

**Benchmark score (verbatim):**

```json
{"criteriaPassed":2,"criteriaTotal":4,"absentBirths":0,"trapBirths":0,"trapFlagged":2,"recallS1S3":0,"c1Evidence":0,"resolved":14,"ambiguous":1,"absent":5,"bornThreads":15,"bornSubjects":15,"duplicateBornSubjects":0,"trapFlaggedData":2,"trapFlaggedDb":0}
```

Exit 1. Precision and identity pass; the recall floor and the early-evidence floor both fail on this rebuilt
copy (C1 early qualifying notes went from 1 to 0 because the regenerated notes landed on different threads).

**Deviations reported, not smoothed over.** Meetings are 1,039, not the ~183 the task expected: clearing note
rows on the copy invalidated the prior meeting evidence, so the mesh was rebuilt from scratch rather than
compared like-for-like. The 26 attested rows are more than the 6 the audit measured, because this copy
regenerated its notes and assessments layout differs. The 222 promotable `needs_review` rows were noted and
not actioned, as instructed.

## 19. Admission strength floor, swept; C1 evidence traced (2026-10-30)

**Part A.** `MIN_ADMISSION_STRENGTH = 0.45` now gates the pair-scope crossing test and the resolved-want
path; `lore meet --min-admission n` sweeps it. Four fresh copies from one assessed base, notes regenerated,
meeting and birth rows cleared so nothing carried over:

| min | meetings | exchanges | births | triggers | criteria |
|---|---|---|---|---|---|
| 0.35 | 443 | 1501 | 11 | pooled 3, combined 8 | 2 of 4 |
| 0.45 | 424 | 1462 | 9 | pooled 1, combined 8 | 2 of 4 |
| 0.60 | 405 | 1403 | 9 | pooled 1, combined 8 | 2 of 4 |
| 0.70 | 353 | 1268 | 8 | combined 8 | 2 of 4 |

Every point holds the same two criteria, so the stated rule is: the lowest value that keeps every criterion
and refuses the 0.2-0.4 tier. That is **0.45**. A pure "lowest value, more meetings" rule would pick 0.35,
which is the defect being fixed, and 0.6/0.7 only lose meetings.

**Part B, C1 (`Darth Plagueis` / `Darth Tenebrous`).** Relation 87: `apprentice of`, confidence 0.9,
`user_confirmed`, assessment present with `strength 0.9`, `asserted true`, `names_both false`. Its note is id
59: strength 0.9, source `assessed`, `is_context 0`, claim kind `apprentice of`, chunk seq **1208**, on thread
253 (`p12`, seq 1207-1221). The pair owns 13 period threads; the book runs to seq 1447 and the harness defines
"early" as seq <= ceil(1447/3) = **483**.

**Cause: none of (a), (b) or (c) as posed.** The note was written, is not context, and clears 0.35 - it is
excluded only by the early-window test. It sits on the period that contains its own cited passage (seq 1208 in
1207-1221), so period selection is correct; the banked row simply cites a late passage. Relation 73 (`master
of`, 0.1) does cite an early passage (seq 288) but is far below the evidence floor. No code was changed: a
threshold or period edit would have hidden a citation choice, not fixed a bug.

**Post-fix benchmark (0.45 copy), verbatim:**

```json
{"criteriaPassed":2,"criteriaTotal":4,"absentBirths":0,"trapBirths":0,"trapFlagged":2,"recallS1S3":0,"c1Evidence":0,"resolved":14,"ambiguous":1,"absent":5,"bornThreads":9,"bornSubjects":9,"duplicateBornSubjects":0,"trapFlaggedData":2,"trapFlaggedDb":0}
```

Exit 1: 2 of 4. Missing criteria remain the recall floor (S1-S3) and the early-evidence floor (C1).
`lore integrity` exit 0; `canon_relation` / `canon_tie_note` / `canon_tie_hint` unchanged at 336 / 98 / 0.

### 2026-10-31: third-judge manifest (qwen3.5:9b, tightened gate)
Run manifest (counts + params only; packets and verdicts live in gitignored /tmp/opencode/out-qwen35/): model qwen3.5:9b, temperature 0, seed 42, code df1cfc3, db plagueis-half.db copy with 314 assessed rows; attest 39 attested / 17 accepted; anchors 112; packets 60; verdicts 60; score 51/60 A+B (85.0%, Wilson 95% 73.9-91.9; human 27/32, assessed 24/28; C 9, D 0). Prior denominators 53/82 and 39/82 were graded under the loose policy and are not comparable (this set carries only assessed+human strata). Blind key stayed local; counts only.

### 2026-10-31: name pass (Spark unquantized, per-person recall onto threads)
Copy `testing/trials/discovery/namepass-copy.db` (fresh disposable copy of the half-book bank; live bank untouched). 182 character entities front to back, 179 Spark calls (temp 0, seed 42, thinking off; 5 persons had no naming passages), 0 call errors, 822 returned items, 410 notes added (verbatim gate + dedupe enforced, strength assessed never default). Skips: duplicate 23, same-person 184+1, unresolved-other 67+7, not-verbatim 130, no-passages 5. Open ends 234. Meetings 2078 created, 687 one-sided refused, 6138 exchanges, births 0 (30 child-equals-parent, 19 below-threshold). Bank diff 0/0/0 (336/98/0 before and after); attest dry-run unchanged (291/11/34, 0 moves); integrity exit 0. validate-web 3/4: recallS1S3 0->2 (S2 3 notes, S3 1 note, S1 excluded-ambiguous Kim), c1Evidence 0->1, absent births 0, trap births 0, T3/T4 flagged. Manifest: `testing/trials/discovery/out-namepass/manifest.json` (local, gitignored); pairs sheet rebuilt names-only from BENCHMARK sec.2.

### 2026-10-31: name pass Q8 leg (Spark Q8 via Ollama, same frozen inputs)
Copy `testing/trials/discovery/namepass-q8-copy.db` (fresh disposable copy; live bank untouched). 182 names, 177 calls, 0 errors, 800 items, 439 notes (same verbatim gate + dedupe + assessed strength). Skips: duplicate 9, same-person 171, unresolved-other 70, not-verbatim 111, no-passages 5. Open ends 217. Meetings 2311 created / 653 refused, exchanges 7217, births 0. Bank diff 0/0/0; attest dry-run unchanged; integrity exit 0. validate-web 3/4: recallS1S3 0->2 (S2 3, S3 1, S1 ambiguous-excluded), c1Evidence 0->2, absent births 0, trap births 0. Ollama Modelfile: FROM local Q8 GGUF + num_ctx 16384 (OpenAI-compat path drops thinking models' answers into reasoning with empty content — native /api/chat with think:false used). Manifest local (gitignored). BF16 vs Q8: notes 410/439, meetings 2078/2311, births 0/0, recall 2/2, C1 1/2, VRAM ~15.6GB/~6.1GB, ~18.8s/call vs ~6.4s/call.

### 2026-10-31: name pass Q4 leg (Spark Q4_K_M via Ollama, same frozen inputs)
Copy `testing/trials/discovery/namepass-q4-copy.db` (fresh disposable copy; live bank untouched). 182 names, 177 calls, 0 errors, 678 items, 269 notes (same verbatim gate + dedupe + assessed strength). Skips: duplicate 19, same-person 262, unresolved-other 47, not-verbatim 81, no-passages 5. Open ends 273. Meetings 646 created / 345 refused, exchanges 2424, births 0. Bank diff 0/0/0; attest dry-run unchanged; integrity exit 0. validate-web 2/4: recallS1S3 0->1 (S3 1, S2 0, S1 ambiguous-excluded), c1Evidence 0, absent births 0, trap births 0. Same Modelfile shape (FROM local Q4 GGUF + num_ctx 16384), native /api/chat think:false. Manifest local (gitignored). Ladder BF16/Q8/Q4: notes 410/439/269, meetings 2078/2311/646, births 0/0/0, recall 2/2/1, C1 1/2/0, VRAM ~15.6/~6.1/~4.5GB, ~18.8/~6.4/~4.0s per call.

### 2026-10-31: frozen-50 slot duel, NuExtract3-Q8 vs Spark-Q8 (nuextract-duel/duel-q8.mjs)
Seed-42 sample of 279 quoted character relations (mostly held-aside rows whose quotes do not state the banked tie). Verbatim-string template, pair named in prompt, zero-shot, think off. NuExtract3-Q8: pair 7, verbatim 3, both 2, abstain 40, wrong 3, unparsable 0, 0.3s/call. Spark-Q8 same fifty: pair 36, verbatim 13, both 8, abstain 2, wrong 12, 0.5s/call. Reading: abstainer vs reader — null-unless-stated vs finds-someone-often-wrong-pair. Gates already refuse non-proof, so abstention adds nothing here; Spark Q8 keeps the pen. Prior 49/50 was the easy case (accepted bank quotes); this probe is the hard case.

### 2026-10-31: BookNLP one-chapter test, E1 (binding) + E3 (speaker attribution), small model
Harness `testing/trials/booknlp/run-chapter.ts` (select|run|score; bank opened read-only, size 6586368 before and after every step). Env: track venv (plain venv+pip, no sudo, system interpreter untouched), booknlp 1.0.8, spacy 3.8.18, en_core_web_sm 3.8.0, torch 2.15.0+cpu, transformers 5.22.1, CPU-only, Ollama untouched. Adaptations (all inside the track venv, no vendored file modified): full-README install failed on disk quota (CUDA bundle + tensorflow); retried CPU-only — torch from the CPU index, booknlp --no-deps (wheel scan: it never imports tensorflow), era-matched transformers 4.30.2 then failed (no cp314 tokenizers wheel, Rust build fails on 3.14); kept modern transformers with a harness-side strict-load bridge ignoring only stale bert position_ids keys (identical values recomputed on the fly; any other drift still raises — observed on exactly 3/3 taggers, nothing else). Small model succeeded, so big was not tried. Chapter: the bank carries no chapter field (marker scan: 5 prologue/epilogue chunks only), so contiguous 25-chunk seq blocks served as proxy; densest block with >= 20 chunks was block 4, seq 100-124, 25 chunks, 886 quote marks (35.44/chunk), 8571 words, pipeline 10 s wall (60-min cap untouched). Scores (counts only): 97 clusters, 9 exact-one-person, 0 BAD two-person merges, roster 182 with 173 missed (one chapter covers few); pronouns linked to named entities 775/799; quotes attributed 321/321 (100%, presence not correctness); event tokens 451 vs 0 bank events in range (comparison vacuous this chapter — informational). NOTHING banks — outputs are blind-review candidates. Manifest: `testing/trials/booknlp/out/manifest.json` (local, gitignored). Verdict (quantity signal only): zero merges is the E1 signal worth a wider run; attribution and event numbers need blind-judge review before any claim. Failures/limits: exact match is conservative (single-token forms never exact-match full roster names); quote attribution presence says nothing about correctness; no blind review done here.

### 2026-10-31: booknlp2 fork vs upstream on the identical chapter (counts only)
Fork `blueprintparadise/booknlp2` @ 2267c9c (MIT, "successor aiming to fix bugs and improve performance"), separate venv, upstream `testing/trials/booknlp/chapter.txt` reused byte-for-byte (block 4, seq 100-124, 25 chunks, 8571 words; this track never re-exports). Same pipeline entity,quote,event,coref, supersense skipped, small model, 60-min cap untouched (10 s wall). Setup notes: fork pins transformers==4.11.3, bypassed with the same disclosed --no-deps + CPU-torch playbook as upstream; fork README usage snippet is stale (no `booknlp.booknlp` wrapper ships — entry is `booknlp.english.english_booknlp.EnglishBookNLP` with identical params, the only driver change); fork loads weights via from_pretrained semantics (base-BERT head keys reported UNEXPECTED, expected) plus the same position_ids bridge (3/3 taggers, nothing else). Harness `testing/trials/booknlp2/run-chapter.ts` (scoring identical to upstream; paths/manifest/select only). Scores, upstream vs fork: clusters 97/97, exact-one 9/9, BAD merges 0/0, roster 182/182 missed 173/173, pronouns 775/799 both, quotes 321/321 (100%) both, event tokens 451/451, bank events in range 0/0. All four output files byte-identical (md5). NOTHING banks — outputs are blind-review candidates. Manifest: `testing/trials/booknlp2/out/manifest.json` (local, gitignored; carries repo booknlp2-fork). Verdict: the fork changes NO number on this chapter/pipeline — same checkpoints through refactored loading. No adoption call.

### 2026-10-31: BookNLP correctness, blind-judged sample (one precision number)
Seed-42 sample from the chapter outputs: 40 pronoun bindings + 40 quote attributions, blind packets (evidence + candidate only, no system labels/roster/bank flags) in gitignored `testing/trials/booknlp/out-judge/`. Judge spark-x2-q8 via Ollama, temp 0, seed 42, 80/80 calls, 0 unparsable; VRAM 884 MiB used of 16303 before, 6426 after (judge resident); nothing else on the GPU. Precision 42/80 = 0.525 (Wilson 95% 0.417-0.631). Splits: bindings 8/40 supported (12 refuted, 20 unclear; 0.20, 0.105-0.348), attributions 34/40 (6 refuted, 0 unclear; 0.85, 0.709-0.929). Outputs stay candidates — NOTHING banks here. Manifest: `testing/trials/booknlp/out-judge/manifest.json` (local, gitignored). Limits: single judge run (no majority-of-three, judge noise unmeasured); binding evidence was sentence-only so wider-context links forced unclear; one chapter only; attribution presence-vs-correctness caveat from the prior probe resolved here as correctness-graded. No adoption verdict.

### 2026-10-31: Binding re-judge with passage context (20 unclear → migrated)
Same 20 unclear binding packets rebuilt with ±1-sentence passage context from the read-only bank chunks (all 20 anchored, full 3-sentence context, chunk ids recorded per packet), blind rules identical, spark-x2-q8 temp 0 seed 42, 20/20 calls, 0 unparsable. Migration: 6 supported, 9 refuted, 5 still unclear. Revised binding precision (8+6)/40 = 0.35 (Wilson 95% 0.221-0.505); attributions stand at 34/40. Passage context resolved 15/20 against-or-for, refuting more (9) than it confirmed (6). The 5 still-unclear anchor 5/5 in one chunk (seq 114) — a wider-than-±1 or genuinely ambiguous spot, not a width artifact elsewhere. Outputs stay candidates — NOTHING banks here. Manifest: `testing/trials/booknlp/out-judge2/manifest.json` (local, gitignored). Limits: single judge run; ±1 width only; one chapter. No adoption verdict.

### 2026-10-31: combination tally measured — does not beat raw confidence, NOT wired (§1.6 bar)
New tally `fanfable/src/core/combine.ts` (pure, no bank reads/writes, bar imported from the strict checker's single owner): 1−Π(1−sᵢ) over separate shares — one per passage (strongest wins), clue repeats collapsed, sentence cited for >3 pairs halved, co-presence excluded, unassessed 0 until assessed. Pins held in `testing/tests/combine.test.ts` (11 tests): three 0.2s 0.49 no-bank, 0.4+0.8 0.88 banks, single 0.4 0.40 no-bank, single 0.95 banks, same-passage and cross-passage dupes collapse, damper boundary at 3/4, unassessed-0, empty-0. Measured on a disposable copy of the assessed snapshot (314 assessed rows; 373 notes rebuilt: 151 pair, 171 assessed): 101 pair-threads scored, 24 candidate threads vs 28 raw-clearing threads, **0 new pairs**; frozen-50: 9 proven, 4 candidate (subset of raw 5); locked-20: 11 resolved / 1 ambiguous / 8 absent, 0 candidates and 0 raw in every block (traps and controls clean); 131 contributions, 11 damped, 0 zeroed (pair notes all assessed), 9 co-presence excluded. Why: only 3 multi-note threads sit below the bar and all carry 0.0–0.1 scraps (combined ≈0.19 at best) — the assessment spread is bimodal with no combinable middle tier. Verdict per the §1.6 bar: the formula earns nothing here, so the inbox return path is NOT wired; module + tests stay as an unwired spike for when mid-tier clues exist. Zero-drift: attest dry-run on the copy 302 checked / 39 attested / 17 accepted — the manifest grades, unmoved. Manifest: `testing/trials/combine/manifest.json` (local, gitignored); scratch copy and sheet deleted in-job, source untouched. Limits: one snapshot; derived-share notes excluded by design; damper calibrated by construction, not by blind labels.

### 2026-10-31: feeder test — BookNLP chains + .book actions as combination inputs (shelved again)
Fed the chapter outputs into a disposable copy of the assessed snapshot as rule-recorded mid-tier notes (1×0.5 shared agent-patient verb, 3×0.45 multi-passage co-mention, 1×0.35 single co-mention, 8×0.4 possessor/modifier on person threads; identity by exact→alias→guarded-containment only, 4 ambiguous, 15 absent, 3 gate-failed, 3 open ends, 0 multi-person chains; verbatim-gated, kinds never asserted, rerun idempotent 0-added/13-dup). Re-measured with the same bar: 106 threads scored (+5 new pair threads), contributions 131→136, candidates 24 vs raw 28 — **0 new pairs**; frozen-50 9 proven / 4 candidate (still ⊂ raw 5); locked-20 unchanged (0/0 all blocks); attest dry-run 302/39/17 accepted 17, unmoved. Why the flip failed: the 5 feeder pair notes each landed on note-less threads (single shares 0.35–0.5, combinable with nothing) and the 8 attribute notes sit on person threads outside pair combination; the chapter's chains barely overlap banked pairs. All three wire conditions fail → return path stays shelved. Manifests: `testing/trials/combine/manifest-fed.json` vs shelved `manifest.json` (local, gitignored); scratch fed copy and sheets deleted in-job, source untouched. Limits: one chapter only — a whole-book feed would widen the overlap but cannot invent co-location; forcing notes onto banked threads to manufacture a win was refused.

### 2026-10-31: BookNLP-for-rel — do its signals predict banked ties? (no slot earned)
Three code-only candidate sets from the ran chapter (identity exact→alias→guarded-containment; chains must resolve unanimously, else dropped unmapped 15 / ambiguous 4): action agent→patient pairs 0 (no shared verb between two cleanly-mapped persons this chapter), quote-exchange pairs 9 with 2 banked hits (precision 0.222), coref co-mentions 6 with 1 hit (0.167); combined 12 pairs, 2 hits, precision 0.167, scored unordered (stated in manifest). Recall denominator is 2 banked pairs citing seq 100–124 (of 235 bank-wide); hits 0/2 in every set. Locked-20: 11 resolved, 0 hits in any block (no S/C pair hit). Nothing banks — candidates for review, verbatim. Manifest: `testing/trials/booknlp/out-rel/manifest.json` (local, gitignored); scratch sheet deleted, bank content untouched (main file identical; -shm churns on any connection, recorded as info). Verdict (quantity signal only): no signal earns a pipeline slot — best 2/9 precision on tiny n with zero recall and zero locked overlap. Limits: one chapter, strict chain unanimity, in-range denominator of 2.

### 2026-10-31: action-set rescore, both identity rules (correction: keys premise was wrong)
Correction first: the voided run's 0 was NOT a schema mismatch. The harness always read agent[]/patient[] (rel-signals.ts:186/191) and chapter.book holds no actions/possessives/modifiers keys; the 0 came from unanimous identity voiding 89 of 97 chains (8 clean, 0 shared verbs). Rescored the same agent→patient signal both ways, same chapter/range/scoring: unanimous 8 chains → 0 verbs → 0 pairs (reproduces the voided run exactly); loose 6 shared verbs → 2 pairs, precision 1/2 = 0.5, in-range recall 0/2, locked hits none in any block. Gap cost: 89 void chains vs 8 clean. Wire neither — strict stays the banking rule, loose stays a measurement. Nothing banks — candidates for review, verbatim. Manifest: `testing/trials/booknlp/out-rel/manifest2.json` (local, gitignored); scratch sheet deleted, bank content untouched. Limits: n=2 makes 0.5 a quantity flicker, not a signal; one chapter.

### 2026-10-31: ties run — empty live bank; re-attest + slate on the Q8-walked copy; second-half scope (plan only)
Empty-live-bank finding: `~/.local/share/fanfable/fanfable.db` holds 0 projects/entities/chunks (0/0/0) vs half-book 182/1448/336 — there is no populated full live bank and no full-novel bank anywhere, so the full-book walk could not run; full-book Q8 copy path not created. Work moved to a disposable copy of the Q8-walked half-book bank (182 chars, 1448 chunks, 336 relations at 291/11/34, 439 Spark-assessed notes, 2311 meetings, 0 births).
Re-attest (proven gate as committed, zero policy changes): dry-run checked 302, attested 0, accepted 0 (blocked: assertion-missing 224, coverage-only 75, moment 3 — the walk assessed notes, not relation rows, so the relation grader has nothing to clear); --on-copy --write changed 0, grades 291/11/34 before and after. Anchors --write: 112 filled, 112 changed, grades unmoved. Locked-20 validate-web read-only: 3/4 (absent 0 births, traps 0 + T3/T4 flagged, recall S1 ambiguous-excluded with S2 3 + S3 1 notes, C1 early 2) — score line criteriaPassed 3, recallS1S3 2, c1Evidence 2, resolved 14, ambiguous 1, absent 5, bornThreads 0.
Candidate slate for your word alone (counts + where, never prose): new attested 0, new accepted 0 (nothing to rule from this run); loose BookNLP pairs 2 (out-rel/manifest2.json + a future blind pass — no bank rows); seq-114 unclear 5 (out-judge2/packets.json — wider-context re-read, future job); still pending on the copy 291 needs_review + 11 provisional + 73 tie-note files + 217 open ends (review: `lore notes --prioritise`, `lore docket`, `lore ties --from/--to`). No row banked by this run.
Second-half scope (PLAN ONLY, awaiting your word — no GPU started, nothing extracted): source present (full novel PDF, 528 pages; half-book covers pp. 13–377). Key constraint measured just now: the half-book bank uses the old duplicating chunker (1370/1447 adjacent-substring pairs, 94.7%, 2.15M stored chars) — second half must either reuse it (seq-consistent, defects preserved) or take the rebuilt one (clean, halves join by re-chunking both; your call). Phase 0 CPU-only: import pp. 378+ with the chosen chunker, count windows, then firm the GPU budget (parametric: ~180 windows × 3 narrow calls at measured Q8 single-call rates, concurrency 1, one model at a time). Phase 1: seed-42 budgeted extract matching first-half prompts/model (verify from bank provenance first — unconfirmed here). Phase 2: close-the-loop re-reads, then integrity exit 0 + counts + attest dry-run vs the 39/17 assessed baseline before anything banks. Killed partial `fullbook-partial-20261030/` referenced in the track README is absent on disk — treated as gone, not resumed.

### 2026-10-31: ties button — spark assessments then attest on a fresh copy (79 rows moved)
Fresh copy of the half-book bank (291/11/34 verified; live still 0 projects). Relation assessments via spark-x2-q8 (temp 0, seed 42, think false; sole GPU tenant): 314 scored / 22 skipped-unverbatim — the expected counts exactly — but a different assessor shape than the qwen baseline (bands <0.5: 110, 0.5–0.8: 0, 0.7–0.8: 126, 0.8–0.9: 0, 0.9–1.0: 78; above bar 204 vs 95; user_confirmed avg 0.741 vs 0.624 — spark rates coarser and more generous). Attest (gate as committed, zero policy changes): dry-run checked 302, attested 57, accepted 22; --on-copy --write changed 79; after: accepted 22, attested 57, needs_review 214, provisional 9, user_confirmed 34. Anchors --write: 112 filled. Integrity exit 0. Locked-20 validate read-only: 2/4 (precision + identity pass; recall fails — this copy never built the web; the Q8-walked copy holds the 3/4). Slate for your word alone (counts + where): new attested 57 + new accepted 22 (review: `lore docket`, `lore ties --from/--to` on the copy); loose BookNLP pairs 2 (out-rel/manifest2 + blind pass); seq-114 unclear 5 (out-judge2); still pending 214 + 9 + 73 tie-note files (review: `lore notes --prioritise`). Ties bank on your word next — NOTHING banks here. Manifest: `testing/trials/discovery/out-assess/manifest.json` (local, gitignored; out-fullbook/ not created — no full-book walk exists). Limits: per-call timing not captured; spark assessor uncalibrated against blind labels (generosity unproven as accuracy).

### 2026-10-31: dense-chapter fight — signals vs 19 known ties (block 41, seq 1025–1049)
25-chunk blocks ranked by banked-pair density (relation rows citing range, any status) then quote marks; top-5: #41 seq 1025–1049 19 pairs/616 marks (picked), #51 1275–1299 14/543, #46 1150–1174 14/501, #26 650–674 12/536, #34 850–874 12/287. Same small-model pipeline on the new block (7660 words, upstream venv only). Both identity columns, same scoring code (voided baseline re-verified drift-free: 0/0, 9/2, 6/1): unanimous (21 clean of 106 chains) action 3 pairs 1 hit (0.333), exchange 24 pairs 2 hits (0.083), coref 20 pairs 3 hits (0.15, recall 1/19), combined 39 pairs 4 hits (0.103, recall 1/19); loose action 3/1 and exchange 24/2 identical, coref 26/4 (0.154, recall 2/19), combined 44/5 (0.114, recall 2/19). Locked-20: 11 resolved, changing 1 in both columns. Gap: 85 void of 106 chains either way. Nothing banks — candidates for review, verbatim. Manifest: `testing/trials/booknlp/out-rel-dense/manifest.json` (local, gitignored); scratch sheet deleted, bank content untouched. Verdict (quantity signal only): YES — signals hit known ties at density (4–5 banked hits of 39–44, recall 1–2/19 carried by coref, 1 locked changing hit), but precision ~0.11 combined with 19-pair recall denominator. Limits: one chapter; loose adds 6 coref pairs for +1 hit; no blind judging of the hits.

### 2026-10-31: BookNLP finder stage — whole-book run, candidates queued (judge stays human)
Whole-book single run (no block fallback needed): 442617 words in 252 s wall (cap untouched), small model, upstream venv, CPU-only. Book-scale four: 3647 clusters, 167 exact-one, 18 BAD merges (vs 0 on the chapter), roster 182 with 30 missed, pronouns 27848/28807 linked, quotes 10005/10005 attributed. Rel signals, unordered, bank-wide recall: action 5 pairs 1 hit (0.20/0.004), exchange 113 pairs 20 hits (0.177/0.085), coref 111 pairs 9 hits (0.081/0.038), combined 209 pairs 26 hits (0.124/0.111). Locked-20: 11 resolved, stable 1 + changing 1 + alias 1 (the trap overlap is candidate noise at 0.12 precision — nothing merged, nothing banks). Staged 178 candidate rows on disposable copy `testing/trials/booknlp/out-book/review-copy.db` (78 quote-exchange + 100 co-mention; reason booknlp-candidate; skipped banked 29 / dup 31 / unlocatable 17; byte-match locate fails on BookNLP spacing artifacts so the rule is lowercase alnum-only containment, 20-char minimum). Review-queue proof in-process: 251 queued (73 pre-existing + 178), all candidates queued, promotable 0 of 178 and 0 overall — the shape parks. Nothing banks — candidates for review, verbatim. Manifest: `testing/trials/booknlp/out-book/manifest.json` (local, gitignored); scratch sheet deleted, source untouched. Verdict (quantity signal only): finder wired as a candidate stage on exchange strength (0.177 + real recall); judge stays human. Limits: 18 whole-book merges need quarantine eyes; 17 unlocatable spans unsurfaced; per-call timing not captured.

### 2026-10-31: voice-fingerprint probe — same-speaker quotes do not cluster (no)
263 speakers with >= 5 attributed quotes (9093 quotes), nomic-embed-text via Ollama (embeddings only; spark-x2-q8 parked; VRAM 1132→1693 MiB, unloaded after; nothing else resident). Separability on 20k/20k seeded pairs: same-speaker 0.539 vs cross-speaker 0.509, gap 0.030. Leave-one-out nearest-centroid vote: 1663/9093 top-1 = 0.183 (Wilson 95% 0.175–0.191; chance ≈ 0.004). Nothing banks — measurement, verbatim. Manifest: `testing/trials/booknlp/out-voice/manifest.json` (local, gitignored); bank untouched. Verdict (quantity signal only): NO — a 0.03 gap with 18% top-1 is far above chance but useless as a fingerprint; literary quotes sit in one tight neighborhood (cross 0.51 absolute) and topic leaks past voice. Limits: cluster ids, not roster persons; single embedder; no blind review of votes.

### 2026-10-31: three-way fork fight on block 41 — byte-identical three-way tie
Upstream, Drew (booknlp-plus 1.0.7, RESOURCES), booknlp2b (local source, EnglishBookNLP direct) on identical 7660-word block bytes, same small pipeline/CPU, separate venvs. Scores identical in every column: action 3 pairs 1 hit, exchange 24/2, coref 20/3 strict and 26/4 loose, combined 39/4 and 44/5, locked changing 1, gap 85 void of 106 chains. md5 identical on all four outputs (.entities/.quotes/.tokens/.book) across all three pairs. Verdict: no runner differs anywhere on this block — same checkpoints through refactored loading; Drew's extra side outputs (simplified JSON, tagged book) don't touch the four. Setup findings: Drew's `<3.13` pin bypassed (runtime clean, finding recorded); booknlp2b background setup dropped the spacy model (installed after); Drew needed no position_ids bridge (native loads); Drew age-inference warnings only (sentence-transformers absent). Manifests: per-track out-41/manifest.json (3, local, gitignored); scratch sheet deleted, bank untouched. No adoption call.

### 2026-10-31: three-way breakdown — the "no slot" verdict is ~93% adapter (counts only)
Same upstream whole-book outputs, three stages: (1) INSTRUMENT raw yield in cluster namespace — 3647 clusters (1931 singleton / 1716 multi), pronouns 27848/28807, quotes 10005/10005, own-pairs 12,860 (co-mention 12,847, exchange 50, action 877; 6819 multi-multi). (2) ADAPTER funnel, chain grain — exact 72, alias 22, containment 28, ambiguous 18, absent 3507; coverage 0.051; pair survival 850/12,860 (0.066). (3) SIGNALS AMONG MAPPED — 1118 pairs, 121 hits, precision 0.108; recall 0.515 of 235 total, 0.747 of 162 reachable (funnel labels strict; survival/mapped use any-resolved persons — disclosed). Nothing banks — measurement, verbatim. Manifest: `testing/trials/booknlp/out-book/breakdown.json` (local, gitignored). Verdict in three numbers: instrument yields 12,860 pairs; the adapter kills ~93% (coverage 0.051); signal quality holds at 0.108 among mapped (≈ finder 0.124). Caveats: loose mapping carries merge pollution (18 whole-book bad merges); 73 banked pairs unreachable with no mapped endpoint.

### 2026-10-31: ties factory — 90 genuine ties end-to-end into the live bank (user's word next)
Phase 0: empty live bank backed up (timestamped) and promoted from the Q8-walked copy; assessments replayed byte-identical (314/314, hash match); attest reproduced 57+22 exactly; integrity 0. Phase 1: committed identity bridge (`identity/booknlp-bridge.ts`, tested 7/7 — exact/alias/containment, merged/ambiguous/absent reported, never merged); coverage exact-only 0.013 vs full-rule 0.033; slate 156 provisional kind-less rows (81 exchange, 4 action, 71 repeated co-mention; cap 400 unhit; skipped banked 86 / dup 160 / unlocatable 41 / single 16) via committed insertRelation. Finding mid-run: committed relabel serves attested/accepted/needs_review only, so kind-less rows were realigned needs_review (both grades held/invisible) and void-scored assessments discarded; relabel then labeled 31 (125 none-verdicts stay held as refuted-by-model). Fresh assess: 156 scored, 124 above. Phase 3: attest moved 90 (34 attested + 56 accepted; held reasons: endpoint-unnamed 12, assertion-missing 111, below-threshold 82, same-identity 3, coverage-only 75, quote-not-verbatim 1, moment 3, ruled-park 2); live now accepted 78, attested 91, needs_review 280, provisional 9, user_confirmed 34 untouched, 492 relations, integrity 0, validate-web 3/4. Slate for your word alone (ids in local `testing/trials/combine/factory-slate.json`; review `lore docket`, `lore ties --from/--to`): new attested 34 + new accepted 56 for ruling; loose pairs 2 + seq-114 5 unchanged from trial tracks; merges pending 18 cluster-level with 0 bank-side quarantine flags (collision pass never ran on live); 73 tie-note files still queued. Nothing proven — keeper stays your word alone. Suite 894/894, typecheck clean. Limits: spark assessor uncalibrated (generosity ≠ accuracy); 125 none-verdicts parked, not deleted; single-pass kind labeling (no majority).

### 2026-10-31: coverage push — 91 → 136 covered (74.7%, bar 128 met)
91 uncovered names listed (86 with co-mention passages, 5 with none); one Q8 call each (slot-extraction wording, temp 0 seed 42, think false), 86 calls 0 errors, 296 items, 103 rows + 4 from the failed-first-run retry (UNIQUE fix: one kind-less row per pair — dedupe now pair+kind, disclosed). Relabel 18 changed / 148 none-verdicts; assess 107 scored, 94 above. Attest moved 74 (38 attested + 36 accepted): live accepted 78→114, attested 91→129, needs_review 387→313, provisional 9, user_confirmed 34 intact, 599 relations, integrity 0, locked-20 3/4. Coverage 91→136 (+45); remaining 46 uncovered include the 5 passage-less, rest gate-held. Reconciliation worth keeping: 66 kind-less rows sit in attested/accepted tiers — the committed gate has no closed-kind requirement by design ("vocabulary for naming, never a promotion gate"), so kind-less + quote-proof + assessed rows move legitimately; the blind audit of the factory 90 will judge whether they should have. No src changes; scratch sheets deleted; backups timestamped before every live write.

### 2026-10-31: false-positive audit of the factory 90 — MIXED at 0.711, no action
Mechanical (code-only, all 90): 89/90 strict pass (90/90 gate-equivalent — the one strict miss resolves under derived-variant surname matching, checker gap not bank gap); gate agreement 90/90; identity violations 0; tie-word reason `tie-word-absent` is dead code (declared, produced nowhere — the assertion rules carry that weight). Blind (qwen3.5:9b, never the assessor; temp 0 seed 42; 25 accepted + 20 attested, seed 42): 32/45 supported = 0.711 (Wilson 95% 0.566–0.823); splits attested 13/20, accepted 19/25; error classes co-presence 3, wrong-kind 6, wrong-direction 4, cannot-tell 0. Verdict MIXED → no demote action. Batch: factory 34 attested + 56 accepted (statuses re-verified at audit time). Harness fixes disclosed: format-json constraint, multi-block parser, think:false after root-causing 41/45 empties (thinking ate the output budget, done_reason length) — the interim BAD was unparsable responses, never a batch finding. Nothing banks, nothing demotes here. Manifests: `testing/trials/fp-audit/out/` (mech/packets/verdicts/manifest; local, gitignored). Limits: single judge run; direction errors cluster 4 (arrow discipline); 13 attested + 6 accepted unsupported-or-misgraded stand as flagged, not fixed.

### 2026-10-31: second FP audit — newer proof rows MIXED at 0.756, coverage barely moves
Pool 232 (277 proof rows minus the 45 already judged, all still proof-grade). Mechanical on all 232: 184 pass; fails non-person-endpoint 19, endpoint-scope 27, strict-verbatim 5, anchor-missing 6 (failing rows: accepted 8, attested 14, user_confirmed 26 — user word banks regardless of proof, as designed); gate agreement 232/232; identity violations 19 (the non-person set). Blind (qwen3.5:9b, temp 0 seed 42 think false, constrained JSON, 0 unparsable; seed-42 25 accepted + 20 attested): 34/45 supported = 0.756 (Wilson 95% 0.613–0.858); splits attested 15/20, accepted 19/25; error classes 3/6/2/0. Coverage impact: 11 unsupported sample rows put 5 character names at risk; demoting them all moves coverage 136→131 (74.7%→72.0%). Verdict MIXED → no demote action. Nothing banks, nothing demotes here. Manifests: `testing/trials/fp-audit2/out/` (local, gitignored). Limits: single judge run; user_confirmed rows judged against proof they never needed; manifest %-grain fixed mid-run (entity ids vs characters — character grain reported).

### 2026-10-31: assessor bench — GLiClass wins precision, Q8 keeps recall, GLiDRE narrow, relweave blocked
Frozen 58 (34 user-confirmed POS + 24 audit-unsupported NEG; <60 stated, proceeding). Q8 incumbent from stored assessments (no new calls): acc 0.500, prec 0.547, rec 0.853, NEG FPR 1.0 — says yes to everything. GLiClass v4 edge (0.4B CPU, ~4.8s/item): acc@0.5 0.655, prec 0.938, rec 0.441, best t=0.45 acc 0.69, AUC 0.727, POS/NEG means 0.47/0.276. GLiDRE multi (~300M CPU, fast): 40/58 unlocatable spans (explicit-name dependence), 18 scored, acc 0.833, prec 1.0, rec 0.571, AUC 0.714 — perfect precision on the measurable third. relweave-4b blocked: 4-bit needs CUDA torch, env is CPU-only (peft+bnb installed to prove it). Verdict as delivered: GLiClass wins on precision at acceptable recall; Q8 stays the recall path; GLiDRE is a precise-but-narrow checker pending name-span plumbing; relweave unmeasurable here. Manifests: `testing/trials/assessor-bench/` (packets/labels/scores/metrics/compare; local, gitignored). Env notes: GLiDRE source install downgraded transformers 5.22→4.51 in the bench venv (GLiClass already scored — order mattered, disclosed); root causes fixed mid-run (GLiDRE list-typed entity refs, quote-joined docs). Bank read-only throughout. Limits: n=58 frozen; single thresholds reported alongside best-threshold accuracy.

**CORRECTION (same day, after reading the artifacts).** Two defects void the comparison, not the measurement: (1) the claim string concatenated kind with " of" although 8 of 10 kinds already end in " of", so most packets asked about "X is ally of of Y", and 19 blank-kind packets asked about no predicate at all; (2) the Q8 column is circular — the 24 negatives are rows banked through a gate requiring the same ≥0.7 stored strength, so FPR 1.0 is the definition of the set, and the "+0.39 precision margin over Q8" must not be quoted. Also noted: labels measure truth (user_confirmed) while the judge answers proof, and 512-token model vs median 1,883-char passages truncated many packets. What survives: AUC 0.69–0.73 (0.694 restricted to the 5 kinded negatives), 15/16 kept rows true at 0.5 for 19/34 confirmed ties lost, and 4.85 s/item on CPU (not the card's 11 ms). Verdict becomes: no swap, judge slot open, one cheap corrected re-run (Phase 1b) before any adoption. Full analysis and the pre-registered decision rule: `docs/ASSESSOR-BENCH.md`.

### 2026-10-31: entailment ranking — AUC 0.775, docket sort only, no integration
GLiClass P("the passage states this claim") over kind-aware claims (phrase table, empty kinds skipped) and quote-anchored windows (±1 sentence, 1200 cap) on CPU: sets A 277 / B 313 / C 578 (21 chunkless); 364 scored, 214 kind-less skipped, 364/364 windows trimmed, mean 304 / median 278 chars, 1.08 s/row (~11 min full queue). Validation on 37 surviving labels (53 kind-less excluded — stated selection bias; pos 32 / neg 5): AUC 0.775, acc@0.5 0.541, prec 1.0, rec 0.469, best t=0.05 acc 0.865 (majority artifact), means 0.52/0.263. Ranked file `testing/trials/entailment/ranked.csv` (id/status/score/trimmed); top decile 36 (6 user_confirmed, 13 accepted, 7 attested, 8 needs_review, 2 provisional); 39 proof rows below 0.3. Verdict per the pre-registered rule (0.70–0.80): sort order for the docket only — no flags, no integration proposal. Bank read-only throughout; Ollama never touched; scratch none beyond gitignored outputs.

### 2026-10-31: nominal coreference — more pairs, worse precision, proposal refused (counts only)
Same 442,617-word input bytes (sha b5d49…), small model, flag False, 272 s wall (vs 252). Flag bites (smoke: 0→6 proper+NOM clusters, 97→80 clusters). Full-book vs baseline: characters 3279/3647, mappedWithNom 56 (the merges sought), bad merges 24 (vs 18, within the 36 cap), quotes held 10,005/10,005, pronouns 27,880/28,807. Strict columns barely move (combined 199 pairs, 20 hits). Loose explodes: 5349 shared verbs → 2445 combined pairs (139 hits), precision 0.108→0.059, mapped 1118→2145 pairs. Pre-registered rule: roster+roster needs ≥2,775 (got 2145, 2.3x) — FAIL; blind merge check mooted and not run (conjunction already failed); bad merges 24 pass; quotes pass. Verdict: report the failure and stop — no wiring proposal. Extra honest signals: loose locked overlap touches stable 1 + changing 5 + alias 1 (trap touch at 0.06 precision is noise, nothing merged); recall 70/223 loose is junk-broad, not evidence-deep. Manifest: `testing/trials/booknlp/out-book-nominal/manifest.json` (local, gitignored); scratch deleted; bank read-only throughout; Ollama never touched (CPU only). No patch to the vendored repo — parameter only, as ordered.
