# Benchmark — locked 20-pair relationship probe (2026-10-26)

**This sheet is locked.** The 20 pairs, their expected verdicts, and the scores below must not change: any future extractor sits this exam, gated, and is graded against it. Procedure changes go in the changelog (§9) — verdicts are never edited silently. Merged 2026-10-29 from the nine frozen files (originals in git history); nothing normative was dropped, only repeated prose.

## 1. Source and build

Source file is local-only and untracked. All locators (`p. N`) are print pages as extracted from that file; a different printing may paginate differently — every verdict rests on quotes verified in that file, never on an oracle's citations. Build: 12-window selective extract, seed 42, then capped probe mining. No tuning, no weight changes during the probe.

## 2. The 20 pairs

### Stable (5) — label holds wherever asked

| ID | A | B | Expected |
|----|---|---|----------|
| S1 | Pax Teem | Kim | peer/colleague (NOT assistant; old bank `assistant of` was misattachment) |
| S2 | Aks Moe | Pax Teem | `aide of` — banked, cited (p. 172) |
| S3 | Ranulph Tarkin | Bor Gracus | `aide of` — true per text; recall miss in rebuild |
| S4 | Darth Maul | Darth Plagueis | no master tie — operative/pawn at most; silent `master of` stays pending |
| S5 | Hego Damask | Darth Plagueis | association only — no lasting formal tie asserted |

### Changing across boundary (5) — ask pinned, label depends on chapter

| ID | A | B | Asked as of | Expected |
|----|---|---|-------------|----------|
| C1 | Plagueis | Tenebrous | early Part Three | `apprentice of` — "I call you apprentice" (p. 18-19) |
| C2 | Plagueis | Tenebrous | late (p. 440+) | terminal event (`killed`) — event, never a tie |
| C3 | Plagueis | Palpatine | early | `encourager of` behavior only — NOT a bankable tie (pending) |
| C4 | Darth Plagueis | Darth Sidious | early | master→apprentice arrow Plagueis→Sidious; reversed reading is wrong |
| C5 | Jabba Desilijic Tiure | Darth Plagueis | late | `partner` — cited (p. 311-312), quote must name endpoints |

### Alias traps (5) — must never merge, must abstain as ties

| ID | A | B | Expected |
|----|---|---|----------|
| T1 | Boss Cabra | Boss Darnada | distinct people (father/son); abstain |
| T2 | Darth Maul | Darth Sidious | distinct people sharing `Darth` — abstain (but see §5: Maul→Sidious `apprentice of` is lore-true with verifying quote; trap status lifted for that direction only) |
| T3 | Plagueis | Darth Plagueis | same person short form — abstain as tie |
| T4 | Palpatine | Emperor Palpatine | same person — abstain as tie |
| T5 | Scar | No Scar | distinct, same passage — abstain as tie |

### Absent controls (5) — must abstain with evidence

A1 Han Solo / Jocasta Nu, A2 Dooku / Toonbuck Toora, A3 11-4D / Aurek-Bacta, A4 Count Vemec / Chatak, A5 Geonosian Archduke / Climber — no tie in text, abstain.

## 3. Ask and rubric

Exact ask per pair: "status of A to B as of chapter X". Output shape: `label` (one closed-vocabulary kind, or `abstain`), `quote` (exact span-verified quote, or empty), `locator` (chunk locator, or empty), `scope` (chapter/part scope). Lazy mining capped (2 windows per ask). Determinism scope: code paths bit-deterministic; LLM prose excluded (compare row counts, verification outcomes, reason codes — never token equality).

Verdicts, ternary: `correct-cited-scoped` (right label, verifying quote, resolving locator, pinned scope); `correct-abstain-with-evidence` (no tie and abstains; pending-on-flagged counts as abstain); `wrong-or-uncited` with subclass (`alias` / `direction` / `scope` / `quote`). A flagged (`needs_review`) or unplaced row never counts as an answer. Endpoint-thin quotes (correct label, quote names neither endpoint) trigger a targeted enrich before the verdict counts as cited.

## 4. Frozen scores

3 cited (S2 aide p. 172; C1 apprentice p. 18-19; C5 partner p. 311-312, endpoint-thin), 14 correct-abstains (S1 pending-not-assistant; S4 masters invisible; S5 unbanked; Cabra/Darnada pending; all 9 controls + all 5 alias traps, zero false merges), 3 known failures: **#3 Tarkin aide** (recovered by pinned single-window re-read — emission failure, not gate or coverage); **#10 Jabba partner** (confirmed recall miss — true per text, no bank, probe, or enrich emitted it); **#7/#8 open-vocabulary labels** (fixed by the closed role-noun gate + directed status).

## 5. Verification re-run (committed baseline)

Fresh bank, same build, same 20 asks: 3 cited (incl. label-variant `master of` for C1 and the T2 sheet correction above), 13 correct-abstains, 3 recall misses — all emission variance across runs (unresolved 0–10), not gate behavior. Zero gate violations across the accepted bank. Precision on surfaced answers 3/3; recall of v1-true ties varies run to run. The gates are deterministic; the extractor is not, and this sheet measures both halves honestly.

## 6. Contamination probe (`qwen2.5:7b`)

8 no-context QA (1 weak hit only), 4 confabulation controls (4/4 abstained), 3 verbatim completions (0/3). No parametric memory of the book's specifics; scores here may be cited as system-on-text recall (small-n caveat: 20 pairs, selective 12-window base). **Re-run this probe if the model changes.**

## 7. Close-the-loop mechanism (verified same day: suite green, `tsc` clean)

Gap-driven re-read at the end of extraction: gap entities → tight gate (same-sentence name+cue, mined passages only; 14 hits including Tarkin, vs 75 for a loose gate) → cap 5 entities × 4 passages → dedupe, never throws. Settles emission-vs-coverage: "His aide, Bor Gracus" sat in mined chunks across three extracts un-emitted; pinned re-read banked it first try. Limits: recall variance dominates run to run; tight-gate junk hits burn bounded calls (priced in); the loop raises emission chances, it cannot make the model deterministic.

## 8. Standing judgments

Precision is solved (0 wrong surfaced on the verification re-run); recall is the open problem. The bank is the exam — any future extractor sits it, gated, with this sheet as judge. Free recall, gated banking: the relations prompt stays exhaustive while only proven rows bank. Per-book model tuning is rejected (breaks verifiability); the NuExtract-as-reader wiring was closed (the recall fix was the prompt, not the model). No new machinery while the sheet has open failures. Human rulings of record: Damask → Hego Damask MERGE; Palpatine → Darth Sidious MERGE.

## 9. Changelog (procedure-change log)

2026-10-26: v1 freeze (20 pairs, seed-42 build; 3 cited / 14 abstained / 3 known failures). Tarkin enrich confirmed-miss → pinned re-read recovered it (narrow scope, not gate change). #7 closed role-noun gate. Contamination probe (no memory). Caps sweep verdict: touch nothing (bank answers; mining is insurance). Jabba enrich confirmed-miss. Verification re-run: 0 violations; T2 + C1 sheet corrections (above). Free-vs-free duel → free recall, gated banking. Close-the-loop wired + verified. GGUF head-to-head (smaller, faster, recall matches; format imperfect). Relations-prompt unmuzzling (recall fixed by reader freedom; precision failures isolated to answer layer + entity intake). Entity identity rule (both-names quote or `needs_review`). Ingest scope trim (contents-bounded; back-matter blanked). Answer-layer muzzle (bank-or-quote for CONFIRMED ties). Quarantine rulings (the two MERGEs above). Rerun-4 full stack: both aide misses recovered and holding, precision intact end to end. Bank gates tightened (endpoint-silent quotes park with relabel note). Every future deviation (reworded asks, changed budget, gate edits affecting verdicts) gets an entry here with date + reason. Scores never edited without one.
