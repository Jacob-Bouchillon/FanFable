# PRESERVED — measurements kept from the tainted evidence run

Stopped 2026-11-01T03:50Z by user order. Nothing here was applied to the live
bank or to `copy.db`: the run died during scoring, before `apply` ever ran.

## Kept (measurements, counts only)

| artifact | value |
|---|---|
| `scores-partial-20261101T035102Z.jsonl` | 10,394 scored candidate calls (58.0% of 17,923) |
| relations represented in that file | 190 of 587 |
| candidates total (`evidence-work.json`) | 17,923 across 587 relations |
| relations with no candidate passage | 194 (re-derived, not taken on trust) |
| distinct relation kinds | 128 |
| vocabulary fall-through | 24 kinds / 28 rows (re-derived from kind keywords) |
| unparsable model replies | 0 |
| error rows | 0 |
| observed wall time | ~30 min, ~5.5 calls/s, 3 lanes |
| model actually used | `spark-x2-q8` (harness constant, line 36 of `evidence.ts`) |

Also kept untouched in this directory: `roster.csv`, `merges.csv`,
`skipped.csv`, `review.csv`, `merge-log.md`, `coverage.json`,
`verify.json`, `rekind.json`, `families.json` (not reached), `manifest.json`,
`copy.db` and its timestamped backups.

## Not kept — and why (one line each)

- **Winners / applied evidence rows**: none exist; `apply` was never run on real
  scores, so no regathered evidence, no direction flips, no status backfill was
  ever written.
- **Tainted aliases**: the merge stage folded names and alias sets into survivor
  rows on textual grounds this run could not verify, so every endpoint match
  downstream is built on contaminated name forms.
- **Substitute model**: the prescribed Spark-X2.6-4B-Q8 is not in the Ollama
  registry (manifest 404 on two casings); scoring ran on `spark-x2-q8`, so the
  scores belong to a different model than the job specified.
- **Dirty chunker**: chunks are page-fragment slices — text begins and ends
  mid-sentence and carries the page locator inline — so any sentence extracted
  from a chunk boundary is unreliable as a quote.

## Method experimentation — untouched (verified, not deleted or modified)

`testing/trials/*` (all existing tracks, venvs, manifests, outputs),
`docs/*`, `RESOURCES/*`, `fanfable/src/*`, and every harness `*.ts` file.
This job wrote exactly one new file here (`scores-partial-*.jsonl`), one file
this document, and one timestamped backup beside the live bank.
