# Past tracks — what each trial asked, what it decided, where it rests

House rules (agreed before any redesign; the map, not the territory):

- Results live in their track folder: `out-<run>/` + `manifest.json` + `README`.
  A result with no manifest is a rumor — write the manifest in the same job.
- Scratch dies in-job: a scratch copy is created, verified, deleted, reported.
- `/tmp` never homes a result. `/tmp` holds copies and runs; the record
  lives in the repo (docs) or the track folder.
- Keys and banks stay gitignored: `key.csv`, `verdicts.csv`, `*.db` never
  commit. Counts and params commit; raw material does not.
- Nothing here is deleted on the strength of this paper. The closing list
  names candidates; the user points at names next round.
- Plain words throughout: proven tie, held-aside, checker, re-read,
  review queue. No per-row verdicts, no passage prose, no quotes.

Live tracks first (ran this month or wired into current flows), then one
block per resting track, then strays, then the delete list.

## Live (9)

- `adjudication/` — blind-adjudication harness (gold sheets, three-way
  labels, anchored sheets). Evidence: RESEARCH §1.3 procedure + HOW-IT-WORKS
  cite it; scripts committed `b366570`. Rerun on demand.
- `benchmark/` — `validate-web.ts`, home of the locked BENCHMARK sheet.
  Evidence: touched `3208732` (evidence-web month).
- `checks/` — `halfbook-judge.ts` (committed `935535f`) + contamination
  probes cited in BENCHMARK §9. The `.json` outputs are gitignored run
  data, not the harness.
- `claim-confidence/` — blind-gold runs + `judge-variants.ts` (the pattern
  the third judge reused). Evidence: SESSION-REPORT model study, Oct 30.
- `discovery/` — `sample-unproposed.ts` / `score-unproposed.ts`; feeds the
  WEBS-AND-THREADS discovery section. Touched `3208732`.
- `grade-claims/` — export/score harness (`734a942`) + Oct 31 third-judge
  run (60 packets, manifest in `/tmp/opencode/out-qwen35/`).
- `halfbook-run/` — the half-book bank + build scripts + trial README.
  Current measurement ground. `backfill-copy.db` stays only on user word.
- `model-ab/` — comparison banks; `hp3.db` is the WHATS-NEXT smoke fixture.
  Fixture + `compare-banks.ts` stay; the rest are leftovers (see list).
- `spark-x2/` — unquantized Spark server (`serve.py`, Oct 31). Live tool,
  not a trial.

## Resting (24) — one block each

- `audit/` — Asked whether the bank survives a strict-verbatim audit.
  Decided: demote-with-reason + integrity exit codes (SESSION-REPORT:
  4 violations found, 4 demoted, exit 0 after). Died when the reports
  were merged into SESSION-REPORT-2026-10-30 (`734a942`); the audit
  command lives in src. Recover: `git log -- testing/trials/audit/`.
- `bucketing/` — Asked whether bucketed sampling finds ties. Ran a
  40-row blind packet (42-line CSV incl. header) + 43-line judge verdicts
  under a rejected A/A'/D/I scheme. Superseded by the 80-row stratified
  design (DESIGNED BUT UNRUN). Last touch `61a9841`. Recover: same path.
- `chain/` — Asked how walks read the book (book-coord runners + the
  thin-first ordering reader). Folded into `fanfable/src/chain-handoff.ts`
  + the diagnostics re-read. Died at the `ab74bb0` reorg (scripts kept).
- `discovery-cmp/` — Asked whether a liberal relations prompt beats the
  current one: the three prompt conditions over the same 10 windows (triageable 16 / 2 / 1
  per 4-minute run). Decided: do NOT adopt — the determinism check
  failed (rerun A 37 vs 20 claims), so arm gaps are noise. `compare.md`
  holds the verdict; the `.db`/`.log` files are its run residue.
  Last touch `b366570`. Recover: `git log -- testing/trials/discovery-cmp/`.
- `eval/` — One-off tie counters (`count-ties*.ts`, `eval-coord.ts`).
  No docs references, no runs since the reorg. Died `ab74bb0`.
- `evidence/` — A single `evidence-select.ts` from the reorg; the
  evidence concept lives in `fanfable/src/evidence*.ts`. Script dead.
- `evidence-audit/` — Answer/integrity/quarantine/rederive/repair probes
  (`audit.json`, `rederive-*.json`, `repair.*`). The flows moved into
  src diagnostics. Last touch `61a9841`.
- `gatecheck/` — Orphan outputs only (`extract.log`, `gatecheck.db`):
  no scripts, never committed, no docs references. Dead on arrival.
- `gold-books/` — Cross-book fixture banks (lotr, gatsby, halo) plus
  `export-windows.ts`. Verified: zero code references anywhere. Dormant
  fixtures, not a flow.
- `guard-ab/` — Checker A/B (`guard-test.db`, 121-line question file,
  before/after reports). Verdict recorded (strict-verbatim integrity won).
  Last touch `b366570`.
- `kind-labels/` — `evaluate.ts`; the kinds it evaluated shipped
  (`841b007`). Died with the kinds commit.
- `model-ab/` (leftovers) — The comparison banks except the `hp3.db` smoke
  fixture + `compare-banks.ts`. Verdicts recorded in SESSION-REPORT §5.
  The rest is residue (see list).
- `name-probe/` — One-off `probe.ts`. No refs. Died `61a9841`.
- `name-variants/` — Differentials, failure census, `FREEZE.txt`,
  delta sheets. Name-variant matching shipped (RESEARCH §2.2). Died
  around `841b007`.
- `nuextract-duel/` — Extractor comparison (`manifest.json`, gemini/qwen
  claim CSVs, contest windows). Decision recorded in the SESSION-REPORT
  model study. Died `61a9841`.
- `pair-probe/` — One-off `probe.mjs` + results + log. Died `b366570`.
- `product-loop/` — Chapter drafts + `product.db` + write logs. The
  story pipeline lives in src. Untracked outputs, no refs. Dead.
- `reader-ab/` + `reader-strict/` — Reader comparisons (`a/b/c.db` + logs).
  Untracked, unreferenced, superseded by the model-selection study.
- `reads/` — 24-window read scripts. Docs hits for "reads" are English,
  not references. No runs since the reorg. Dead.
- `refs-backfill/` — `run.ts` + audit JSONs. The backfill it rehearsed
  ran via the assess command (Oct 30, disposable copy, deleted). Done.
- `review-queue/` — Review prompts + 60-row `gemini-round1.csv`.
  Verdicts recorded. Dead.
- `sheet-rerun/` — Bench-20pair asks + rerun logs + `rerun.sh`. Folded
  into `docs/BENCHMARK.md` (merged 2026-10-29). Dead.
- `sheets/` — Claim and sample CSVs (11–52 lines each; `claim-sheet.csv`
  52 lines). Folded into BENCHMARK. Dead.
- `tiers-probe/` — `find.db` only: no scripts, no log, no refs. Orphan.

`archive/` is not a track: already-archived old runs (answer dumps,
case runs, chunk rebuilds, continuity runs, misc, rescan). Storage,
not a verdict.

## Stray outputs

- `testing/trials/*/*.db` — all owned by their track folders; all
  gitignored (`*.db` + explicit paths). No orphan banks except
  `tiers-probe/find.db` and `gatecheck/gatecheck.db` (no owning scripts).
- `testing/trials/halfbook-run/fullbook-partial-20261030/` — owned
  partial-extract evidence (51/93 windows); kept on user order, not stray.
- `testing/trials/halfbook-run/backfill-copy.db` + `testing/trials/grade-claims/qwen35-copy.db` — kept on explicit user word; delete only on word.
- No `out-*` dirs under `testing/trials/` — current runs went to `/tmp`
  with manifests; nothing to re-home this round.

## Delete list (names only — NO action taken)

- `testing/trials/gatecheck/` — orphan outputs, no scripts, never committed.
- `testing/trials/tiers-probe/` — single orphan bank, no scripts.
- `testing/trials/reader-ab/` + `testing/trials/reader-strict/` —
  superseded comparisons, untracked outputs.
- `testing/trials/discovery-cmp/` — verdict recorded in `compare.md`;
  keep the paper trail in git history, drop the residue (dbs, logs).
- `testing/trials/model-ab/` except `hp3.db`, `compare-banks.ts`,
  `config.before.json` — comparison leftovers incl. audit-backup + pre-replay
  snapshots.
- `testing/trials/nuextract-duel/` except `manifest.json` — comparison
  residue; verdict lives in SESSION-REPORT §5.
- `testing/trials/product-loop/` outputs (`*.db`, `*.log`, chapter
  drafts) — pipeline moved to src; keep nothing.
- `testing/trials/sheets/` + `testing/trials/sheet-rerun/` except
  `rerun.sh` — folded into BENCHMARK; CSVs survive in git history.
- `testing/trials/bucketing/` outputs (`*.csv`, `*.json`) — keep the
  two scripts + `sample-40.md` (the design record).
- `testing/trials/evidence-audit/` logs + JSONs — keep `audit.ts`,
  `repair.ts`, `rederive*.ts` as tool records.

Nothing above was deleted, renamed, or moved. Recovery for anything
dropped later: `git log -- <path>` — every script survives in history.
