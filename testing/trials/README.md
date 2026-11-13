# testing/trials — map

Trial harness: one-off experiment scripts plus the local data they produce.
**Only scripts commit.** Everything a script produces (`.db`, `.json`, `.csv`,
`.tsv`, `.md` sheets, `.log`, `.html`) stays on this machine by `.gitignore`
and never pushes. Do not commit run output; do not delete someone else's
`.db` without asking — extraction runs cost GPU hours.

Scripts commit at one level only (`testing/trials/<topic>/<script>.ts`).
Deeper paths stay ignored on purpose: several folders hold vendored checkouts
and nested clones (`valve-bench/src/llama.cpp`, `valve-bench/src/GLiNER2`,
`coref-probe/data/`), whose sources must never be committed to this repo.

Run a script from the repo root, e.g.:

```bash
node --experimental-strip-types testing/trials/chain/watch-log.ts book-coord
```

## Active topic folders (scripts + their local data side by side)

| folder | what it holds |
|---|---|
| `chain/` | book-walk reads (`book-coord*.ts`), the handoff mechanism (`chain-handoff.ts`, `emit-handoff.ts`), handoff outcome runs (`enrich-ab.ts`, `enrich-sweep.ts`), the live-log watcher, walk vocabulary (`terms.md`), handoff data (`handoff-*.json`) |
| `eval/` | bank counters and coordinators (`eval-coord.ts`, `count-ties*.ts`) |
| `reads/` | small controlled reads (`plain-24.ts`, `product-24.ts`, `fresh-small-read.ts`) |
| `checks/` | regression and quality checks (`regression-check.ts` + `regression-sheet.json`, `lasting-moment-check.ts`, `notes-relabel.ts`) |
| `evidence/` | evidence-selector measurement (`evidence-select.ts`, read-only) |
| `adjudication/` | blind judging sheets, label pools, verifier scoring |
| `claim-confidence/` | judge prompt variants, blind re-reads, calibration, stability runs |
| `grade-claims/` | blind grading packet export, verdict import, relabel and scoring (own README) |
| `guard-ab/` | guard A/B runs and reports |
| `model-ab/` | extraction model A/B databases |
| `halfbook-run/` | half-book lab bank, mention builders, kind appliers, `reclass-pass.ts` (own README) |
| `identity-rebuild/` | staged identity rebuild: gate, dry run, apply, restore (`PRESERVED.md` records the guarantees) |
| `kind-labels/` | kind-label evaluation |
| `name-variants/` | name-variant delta sheets and verdicts |
| `discovery/` | unproposed-pair threads, packet sampler, verdict scorer, top-yield followup allocator, and single-sentence evidence prototype (run output under `discovery/unproposed/`) |
| `entailment/` | review-queue entailment ranking with GLiClass (read-only bank) |
| `combine/` | combination-tally measurement (`measure.ts`) + chain/action feeder (`feed.ts`) + factory slate (`slate.ts`, `label-assess.ts`); disposable copies, manifests local |
| `benchmark/` | web validation against the locked 20-pair sheet (`validate-web.ts`); the pair list is local data (`pairs.json`) |

## Past experiment areas (scripts kept, outputs local)

| folder | what it holds |
|---|---|
| `gold-books/` | window export for blind reading across a second book |
| `bucketing/` | bucketed-sampling packet builders (`build.ts`, `build2.ts`) + `sample-40.md` design record |
| `discovery-cmp/` | liberal-vs-strict relations prompt comparison metrics (`metrics.mjs`) |
| `evidence-audit/` | strict-verbatim bank audit, quarantine and re-derivation tools |
| `fp-audit/`, `fp-audit2/` | false-positive audit harnesses (mechanical + blind judge + scorecard) |
| `name-probe/` | single-probe name experiment (`probe.ts`) |
| `nuextract-duel/` | NuExtract Q8 duel harness (`duel-q8.mjs`) |
| `pair-probe/` | pair sampling probe (`probe.mjs`) |
| `refs-backfill/` | missing-source-ref repair on parked relations (data-only) |
| `sheet-rerun/` | sheet re-run bank with rulings appliers (`rerun.sh`) |
| `review-queue/` | review-queue prompts and rounds (prompt files only, no scripts) |
| `audit/` | past system audit reports (local-only, no scripts) |

## Model benches (own venv or clone, all local)

| folder | what it holds |
|---|---|
| `booknlp/` | one-chapter E1+E3 probe (`run-chapter.ts`) + blind-judged correctness sample (`judge-sample.ts`, re-judge `rejudge-bindings.ts`) + rel-signal test (`rel-signals.ts`) + whole-book finder stage (`book-candidates.ts`) + voice probe (`voice-print.ts`); venv, chapter text and outputs stay local |
| `booknlp2/`, `booknlp2b/` | fork-vs-upstream reruns on the identical chapter; own venv, outputs local |
| `booknlp-drew/` | Drew fork block-41 fight outputs; own venv, local only |
| `assessor-bench/` | judge bench (build + GLiClass/GLiDRE/compare runners); venv and outputs local |
| `coref-probe/` | LitBank pairwise description probe (build + judge harnesses); gold clone under `data/`, outputs local |
| `coref-fast/` | fastcoref slice fight (run-fc harness); own venv, outputs local |
| `valve-bench/` | valve benchmark workspace; vendors `llama.cpp` and `GLiNER2` clones (never commit) |
| `spark-x2/` | unquantized Spark server (`serve.py`), kept as a live tool rather than a trial |

## Local-only output folders (no scripts)

`hp1-partial/` (`counts.json`), `nuextract3/`, `archive/` — run residue only.
`archive/` is currently empty; it is the place for finished or superseded run
output. Nothing under these folders is imported by active scripts, so delete
from here first if disk runs short — but `.db` files anywhere cost GPU time to
rebuild, so prefer deleting logs and HTML dumps.

## Rules for the next experiment

1. New script goes in the matching topic folder, or a new folder named after the question it answers.
2. New folder gets one line in the table above.
3. Never import across experiment folders; shared logic belongs in `fanfable/src/` or `testing/scripts/`.
4. Usage line at the top of every script shows the repo-root command.
5. Run output stays untracked. If a result matters, write it up under `docs/` (tracked) with counts only, no book text.
6. Never un-ignore a nested path: vendored clones live under this tree.
