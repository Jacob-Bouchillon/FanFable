# testing/trials — map

Trial harness: one-off experiment scripts plus the local data they produce.
**Only scripts commit.** Everything a script produces (`.db`, `.json`, `.csv`,
`.tsv`, `.md` sheets, `.log`, `.html`) stays on this machine by `.gitignore`
and never pushes. Do not commit run output; do not delete someone else's
`.db` without asking — extraction runs cost GPU hours.

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
| `sheets/` | judging-sheet builders (`prep-sheet.ts`, `sample-sheet.ts`) and the `*.csv` sheets they write |
| `checks/` | regression and quality checks (`regression-check.ts` + `regression-sheet.json`, `lasting-moment-check.ts`, `notes-relabel.ts`) |
| `evidence/` | evidence-selector measurement (`evidence-select.ts`, read-only) |
| `adjudication/` | blind judging sheets, label pools, verifier scoring |
| `claim-confidence/` | judge prompt variants, blind re-reads, calibration, stability runs |
| `guard-ab/` | guard A/B runs and reports |
| `model-ab/` | extraction model A/B databases |
| `halfbook-run/` | half-book lab bank, mention builders, kind appliers, `reclass-pass.ts` |
| `sheet-rerun/` | sheet re-run bank with rulings appliers |
| `kind-labels/` | kind-label evaluation |
| `name-variants/` | name-variant delta sheets and verdicts |
| `review-queue/` | review-queue prompts and rounds |
| `product-loop/` | product-loop chapter outputs |
| `gold-books/`, `bucketing/`, `discovery-cmp/`, `evidence-audit/`, `gatecheck/`, `name-probe/`, `nuextract-duel/`, `pair-probe/`, `reader-ab/`, `reader-strict/`, `refs-backfill/`, `tiers-probe/` | past experiment areas, kept as-is |
| `audit/` | past system audit reports (local-only) |
| `discovery/` | unproposed-pair threads, packet sampler, verdict scorer, top-yield followup allocator, and single-sentence evidence prototype (run output under `discovery/unproposed/`) |
| `benchmark/` | web validation against the locked 20-pair sheet (`validate-web.ts`); the pair list is local data (`pairs.json`, untracked) |
| `booknlp/` | one-chapter E1+E3 probe (`run-chapter.ts`) + blind-judged correctness sample (`judge-sample.ts`); venv, chapter text and outputs stay local (gitignored) |
| `booknlp2/` | fork-vs-upstream rerun on the identical chapter (`run-chapter.ts`, scoring identical); own venv, outputs local (gitignored) |

## archive/ — finished or superseded runs, local data included

`retired/`, `tmp-archive/`, `tmp-archive-20261027/`, `rescan/`,
`sheet-reruns/` (runs 2–4), plus filed run output: `case-runs/`,
`continuity-runs/`, `answer-dumps/` (one-off answer HTML), `rulings/`,
`chunk-rebuild/`, `misc/`. Nothing here is imported by active scripts.
Delete from here first if disk runs short — but `.db` files anywhere cost
GPU time to rebuild, so prefer deleting logs and HTML dumps.

## Rules for the next experiment

1. New script goes in the matching topic folder, or a new folder named after the question it answers.
2. New folder gets one line in the table above.
3. Never import across experiment folders; shared logic belongs in `fanfable/src/` or `testing/scripts/`.
4. Usage line at the top of every script shows the repo-root command.
5. Run output stays untracked. If a result matters, write it up under `docs/` (tracked) with counts only, no book text.
