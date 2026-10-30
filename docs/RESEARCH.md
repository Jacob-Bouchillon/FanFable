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

Common failure: code asked to hold a definition of a relationship. Any definition specific enough to reject "Harry and Ron stood in the hall" also rejects "he already felt like his best friend." Resolution (2026-10-29): **the model judges, the code measures.** The model's assessment (`names_both`, `asserted`, `other_person`, `directness`, `strength`, `why`) is stored in `supporting_evidence`; the code certifies only verbatim quote, entity existence, non-identity, and the calibrated threshold (default 0.7, project setting `minConfidence`). Deleted, not disabled: assertion matcher, `KIN_GROUPS`, synonym lists, `open-vocab` refusal, reverse-direction-as-promotion-condition, concept-as-promotion-gate (the concept set stays for labelling and querying), the `kind_source` substitution loophole. One survivor: a quote hiding a preceding "perhaps"/"not" is still refused — misquotation, not grammar.

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
