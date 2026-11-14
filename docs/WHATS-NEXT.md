# What's next — ranked work, roadmap, commands, traps

**Recognition filter:** off by default after the 2026-11-01 benchmark (B→C was neutral on quality and cost +439 ms pooled). See `docs/RESEARCH.md` for the numbers and limitations; opt in with `project settings --recognition on`.

## 0. Done 2026-11-14 — extraction identity

Full numbers in the same-dated section of `REPORTS.md`. Three defects, two fixed:

- **Chapter labels.** 40 of 526 passages carried the wrong chapter: a heading now needs a count after the structural word, and its offset points at the heading text rather than the raw line (a PDF page break left a form feed in front of it). Four tests; `testing/scripts/repair-chapter-labels.ts` repairs older banks.
- **Short names minted twins.** `findEntityId` matched names only, never aliases, so "Ron" created a second entity beside "Ronald Weasley"; the duplicate then made the short form ambiguous and every relation using it was demoted to a hint.
- **Short forms resolve by evidence.** Exact, then leading position, then least-diluted name (significant words only), then fail closed. Kind plays no part on purpose.

Measured on two chapters: relations recovered, **new hints 0**, new entities 0. Hint endpoints both resolvable: 59 of 90 → 86 of 90. Gate: 1,589 tests.

**Still open:** four windows truncate one section (`finish-length` on relations, one `mixed-entries`), leaving 28 passages unmined. Split those windows; do not raise the token cap.

## 1. Now: the judge fix (in order)

0. **Baseline — DONE 2026-11-13.** Full numbers in the same-dated section of `REPORTS.md`. On `qwen3.5:9b`, 21 rows, `think: false`: **precision 0.81 / recall 1.00**. The identity/title variants `fixed2` and `fixed3` scored 1.00/0.38 and 0.88/0.54 — they remove the false positives by losing 6 to 8 establishment rows the baseline had right. That is a regression, so **step 1 as written below is not worth running**. The baseline's three errors are presupposition over-reach on co-mentions; the rows step 1 targets (alias pairs, kin titles) are in the missing half.

   **The 42-row set is currently 21.** `gold-map.json` takes 21 rows from `model-ab/n.db` and 21 from `model-ab/hp3.db`, and `n.db` is no longer on this machine. `judge-variants.ts` skips a missing bank and reports `skippedMissingDb` rather than opening an empty one, so a run is honest about what it scored — but 21 rows is half the evidence. Rebuild that bank before treating any judge number as comparable to the published 42-row figures.

1. **One prompt variant** on the same 42 rows, same model (`qwen3.5:9b`): two names for one person are not a relationship; a family title used in the passage establishes what it names. Must move: the 2 alias false positives (`Plagueis — partner — "The Muun"`, `Palpatine — colleague of — Sidious`) and most of the 6 title misses (`Aunt Petunia`/Harry twice, `Uncle Vernon`/Harry, `Uncle Vernon`+`Aunt Petunia` together, `Dudley`/`Uncle Vernon`, `Great Auntie Enid`/`Great Uncle Algie` — every establishment miss is a title). Track separately, not decisive: the 1 reinforces miss (partnership talked *about* rather than restated) and the genitive FP (`Larsh Hill`, "son of Damask's officer" — wrong-noun attachment, no identity rule fixes it). Zero regressions on rows already correct.
2. **Stability:** majority of three runs of the winner. Use the flip rate measured in step 0 for `qwen3.5:9b` as the noise floor; the 6-of-42 figure belongs to the retired judge.
3. **Apply the winner** to candidate pairs — the actual deliverable.
4. **Re-label a random sample of a whole book**, storing the relation id on *every* row (the 226-row key kept it for 42 only — that loss must not repeat), so accuracy is known beyond these 42 hard cases. Label defects to brief the labellers on: 4 past "unclear" verdicts reasoned from outside knowledge against instructions, and 2 rows matching invoice-"bill" to a character named Bill.

Labels: *establishes* (passage supplies the evidence — 20), *reinforces* (presupposed: "his wife" — 2), *mentions* (both appear, nothing stated — 16), *unclear* (4).

Leftovers from the checkpoint: remap `lore-ask` hints still naming removed kinds; decide whether time-scoped relationships earn a migration (`canon_relation` has no time field); notes carry citations inside `source_refs` with no `kind_source` column; publish the calibration table; re-measure the bank at threshold.

## 2. Then: the classifier track

E0 first (an afternoon, no GPU): map the test ontology onto the concept set, measure coverage and the no-relation false-positive rate — it decides whether the rest is worth compute. Then binding accuracy (E1) and speaker attribution (E3) on 20 frozen scenes, literary classifier (E2) on the same windows, fine-tune (E4) only if E0/E2 justify it (5–10k stratified rows, book-level splits, never row splits).

Why this shape (literature, author-reported, unreproduced locally): book-scale coreference is mature but wrong one binding in five (best-in-class); mention detection is easy, cluster linking is hard; character context drives literary performance, graph structure doesn't; small task-tuned models beat zero-shot frontier ones on literary relation extraction. Candidate artifacts: xCoRe/BookCoref (binding baseline — NC-SA weights, research only), ARF fiction relations (measured 37% no-relation population — the negative control source, MIT), compact-relex/LitTune adapters (MIT adapters, but datasets partly unlicensed), GLiREL as fallback (accepts arbitrary labels). **Warnings:** PG-Fiction and ARF share 96 books — split by book, never by row. Tuned adapters emit their training ontology, not ours — label coverage is measured before accuracy.

## 3. Roadmap beyond relationships

| # | issue | impact |
|---|---|---|
| 1 | production bank uses the old duplicated chunker | retrieval carries repeats; timings not comparable |
| 2 | rebuilt bank thinner, unmerged | promotion would reduce counts; needs audit first |
| 3 | planner has no keeper list | outlines can't distinguish canon from invention |
| 4 | continuity can't separate canon / AU timeline / divergence | only canon contradictions detected |
| 5 | 10 quarantined keepers unprovable from text | stay provisional; confirmations preserved |
| 6 | no entity-category checks in prose | a misstated character type passes |
| 7 | no secrecy/context constraints | hidden titles usable publicly, unflagged |
| 8 | 18 parked rows unquotable | unreviewable |

- **Unproposed pairs:** ~3,100 co-occurring pairs with no relation row. Sample 80 stratified by co-occurrence (1 / 2–3 / 4–9 / 10+) and book position (thirds), seed 42, record stratum + population weight. Build packets mechanically — every shared passage (cap 6, spread across the book), one sentence context either side, exact locators, nothing about bank status. Independent judge verdicts: A (single-sentence quotable) / B (multi-sentence) / C (not a relationship) / D (indeterminate), quote + locator for A/B, ≤12-word reason each, no outside knowledge. Score with stratum weights + Wilson intervals. Mostly C → skip broader evidence machinery; meaningful A → improve discovery; meaningful B → prototype multi-sentence evidence. Scoring scaffold prints PENDING until verdicts exist; never invents them.
- **Bank promotion:** compare counts, kinds, keepers, facts, integrity old vs rebuilt; replay rulings export; `lore integrity` must exit 0; back up production first; any keeper failing replay stops promotion.
- **Canon-aware planner:** pass keeper ties with evidence into drafting; mark provisional separately; require locators for canon claims; report missing evidence as uncertainty; record AU divergence, never reject it.
- **Second book:** same pipeline and probes, failures separated by stage (extraction / retrieval / planning / continuity).

A claim fails three ways — contradicts canon (error, with quote), contradicts AU state (error against story state), intentional divergence (recorded, not rejected). The system implements the first.

## 4. Commands

```bash
npm run typecheck && npm test          # offline suite; run it before citing any number

# judge variants (42 rows) / blind re-read
node --experimental-strip-types testing/trials/claim-confidence/judge-variants.ts categories
node --experimental-strip-types testing/trials/claim-confidence/blind-gold.ts out.json
node testing/trials/claim-confidence/measure-precision.ts sample --db /tmp/opencode/bank-copy.db --out /tmp/opencode/precision --seed 42 --n 120
node testing/trials/claim-confidence/measure-precision.ts score --dir /tmp/opencode/precision

# extraction: ONE window first, always
cp testing/trials/model-ab/hp3.db /tmp/opencode/smoke.db
# reset lore_mined for one window, then:
npm run fanfable -- --db /tmp/opencode/smoke.db --project ab lore extract --model qwen3.5:9b --max-windows 1

# bank state / review / rulings
lore status; lore integrity; lore diagnose
lore notes --prioritise; lore promote --dry-run; lore promote --find-evidence --dry-run
lore rulings export --out <path>; lore rulings replay --in <path> --dry-run
```

Ollama must be running with `qwen3.5:9b`. One model: the judge and the extractor are the same weights, which also removes the two-model residency the older judge needed. Trial data stays local by `.gitignore`; code, tests and docs commit, run output doesn't.

## 5. Traps (each cost real time)

0. **The default extraction path cannot publish.** `lore extract` without `--legacy` stages its claims and stops: "publication is not implemented". Canon, `lore_mined` and embeddings are untouched, so a run that looks successful changes nothing. `--legacy` is currently the only path that writes canon; every measurement in the 2026-11-14 report used it.
0. **A bigger token cap buys wall-clock, not completeness.** `--max-tokens n` doubles in the entities-facts section (`min(n * 2, 16384)`), so 8192 permits 16,384-token answers. Two such calls cost 147 s and 156 s on a card running at 89% and 112 tok/s — five minutes of a seven-minute run. The default budget is 3,000; a window that needs more than that is a window to split.

0. **A heading needs a count, and its offset is the heading's own** (fixed 2026-11-13, `48daa43`). Two chunker defects filed 40 of 526 passages under the wrong chapter: a hard-wrapped line opening "the book had screamed" matched the chapter pattern, and a heading that opened a PDF page sat behind a form feed so its offset fell outside its own block. Both are fixed and covered by four tests that fail on the old code; `testing/scripts/repair-chapter-labels.ts` repairs banks written before the fix.
1. **Reasoning models share their budget with the answer.** Measured on `gpt-oss:20b`, retired 2026-11-13: at 2k–8k tokens it returned 0 characters with `done_reason: length` (29k chars of thinking), `think: false` was silently ignored, and `think: "low"` was the workaround. The model is gone; the lesson is not. Before concluding a model "returned nothing", check `done_reason` and the thinking length.
2. **Never launch a full run without a one-window smoke.** A 66-window run was wasted on a model tested only with short prompts.
3. **Killing the shell does not kill the child.** `ps` afterwards — an orphaned extract fought a second run for the GPU for 23 minutes.
4. **Labels are a hypothesis.** Five "false positives" were correct under re-read labels. Score against re-reads, not first passes.
5. **Match the metric to the prompt.** A variant predicting `reinforces` must count it positive, or it scores its own correct answers as errors.
6. **Losing row identity kills gold sets.** The 226-row key kept `relId` for 42 rows only. New labelling stores the relation id on every row.
7. **Two extraction processes on one GPU thrash** and both crawl.
8. **Don't run extraction when the question is about judging.** An hour burned for nothing.
