# What's next — ranked work, roadmap, commands, traps

## 1. Now: the judge fix (in order)

1. **One prompt variant** on the same 42 rows, same model (`gpt-oss:20b`, `think: "low"`): two names for one person are not a relationship; a family title used in the passage establishes what it names. Must move: the 2 alias false positives (`Plagueis — partner — "The Muun"`, `Palpatine — colleague of — Sidious`) and most of the 6 title misses (`Aunt Petunia`/Harry twice, `Uncle Vernon`/Harry, `Uncle Vernon`+`Aunt Petunia` together, `Dudley`/`Uncle Vernon`, `Great Auntie Enid`/`Great Uncle Algie` — every establishment miss is a title). Track separately, not decisive: the 1 reinforces miss (partnership talked *about* rather than restated) and the genitive FP (`Larsh Hill`, "son of Damask's officer" — wrong-noun attachment, no identity rule fixes it). Zero regressions on rows already correct.
2. **Stability:** majority of three runs of the winner (6 of 42 flip = 14% noise floor).
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
npm run typecheck && npm test          # 609 green at last full run

# judge variants (42 rows) / blind re-read
node --experimental-strip-types testing/trials/claim-confidence/judge-variants.ts categories
node --experimental-strip-types testing/trials/claim-confidence/blind-gold.ts out.json

# extraction: ONE window first, always
cp testing/trials/model-ab/hp3.db /tmp/opencode/smoke.db
# reset lore_mined for one window, then:
npm run fanfable -- --db /tmp/opencode/smoke.db --project ab lore extract --model qwen3.5:9b --max-windows 1

# bank state / review / rulings
lore status; lore integrity; lore diagnose
lore notes --prioritise; lore promote --dry-run; lore promote --find-evidence --dry-run
lore rulings export --out <path>; lore rulings replay --in <path> --dry-run
```

Ollama must be running with `qwen3.5:9b` and `gpt-oss:20b`. Trial data stays local by `.gitignore`; code, tests and docs commit, run output doesn't.

## 5. Traps (each cost real time)

1. **Reasoning models share their budget with the answer.** `gpt-oss:20b` at 2k–8k tokens returned 0 characters with `done_reason: length` (29k chars of thinking). Check `done_reason` + thinking length before concluding a model "returned nothing." `think: false` is silently ignored; `think: "low"` works.
2. **Never launch a full run without a one-window smoke.** A 66-window run was wasted on a model tested only with short prompts.
3. **Killing the shell does not kill the child.** `ps` afterwards — an orphaned extract fought a second run for the GPU for 23 minutes.
4. **Labels are a hypothesis.** Five "false positives" were correct under re-read labels. Score against re-reads, not first passes.
5. **Match the metric to the prompt.** A variant predicting `reinforces` must count it positive, or it scores its own correct answers as errors.
6. **Losing row identity kills gold sets.** The 226-row key kept `relId` for 42 rows only. New labelling stores the relation id on every row.
7. **Two extraction processes on one GPU thrash** and both crawl.
8. **Don't run extraction when the question is about judging.** An hour burned for nothing.
