# FanFable docs — the whole picture

**The bet:** a book becomes a *bank of proven claims*, and stories are written from the bank, not the raw text. Three rules shape everything: canon is evidence (no verbatim quote, no bank); the model proposes but the system decides (no model sets a status); answers show provenance (*confirmed by you* vs *the model, 0.78*).

**Current snapshot (2026-11-13, branch `experiment/evidence-scan`):** `npm run typecheck` is clean and `npm test` passes 1,555 tests. The bank on the trial book holds 164 relations; the judge scores 0.83 precision / 0.68 recall on 42 blind-labelled rows. Two systematic defects remain open measurements, not solved work: alias pairs judged as two people (Plagueis/"The Muun", Palpatine/Sidious) and family titles refused as evidence ("Aunt Petunia" — six of six establishment misses). Those numbers are the 2026-10-29 measurement and are not rewritten.

**What's next:** one prompt variant fixing identity + titles, measured on the same 42 rows; then majority-of-three stability; then apply the winner to candidate pairs. Longer track: recall (classifier E0–E4), bank re-measurement at threshold, canon-aware planner, second book. Full ranked list in `WHATS-NEXT.md`.

**The trap that cost three hours:** `gpt-oss:20b` spends the output budget thinking and returns empty with `done_reason: length`. `think: false` is silently ignored by this Ollama build; `think: "low"` works. Always smoke-test one window before any full run, and `ps` after killing a run — orphaned processes compete for the GPU.

## Start here

| file | answers |
|---|---|
| `HOW-IT-WORKS.md` | the standing design: guard, kinds, names, confidence, sweep, packets, and the rules future work must obey |
| `CODE-MAP.md` | where to look for what: the section map of `lorebook.ts`, modules by folder, test layout |
| `WHATS-NEXT.md` | ranked next steps, the classifier track, the broader roadmap, commands, and the traps |
| `RESEARCH.md` | the complete research record: methods, measurements, intake, judgments |
| `BENCHMARK.md` | the locked 20-pair probe that grades future extractors — read before changing extraction |
| `REPORTS.md` | every dated measurement report in one file, in date order |
| `REQUIREMENTS.md` | what FanFable needs to run |
| `../README.md` | what FanFable is, and how to install and run it |
| `../GLOSSARY.md` | locked vocabulary — plain words win over code words |

## Design and plans (living documents)

| file | answers |
|---|---|
| `PIPELINE-PLAN.md` | who owns which pipeline stage, and the bar a new part must clear before it is allowed in |
| `WEBS-AND-THREADS.md` | the proposed thread/web visual system, and what of it actually shipped |
| `PAST-TRACKS.md` | what each trial asked and decided — a dated record, not a live inventory |
| `ASSESSOR-BENCH.md` | what the judge bench measured, and what it did not |
| `GLINER-ARCHITECTURES.md` | architecture notes on GLiNER for entity finding |
| `RESOURCE-SHELF.md` | models, datasets and recipes kept for reference |

## Dated reports (measurements — never rewritten)

All 13 dated reports now live in one file: [`REPORTS.md`](REPORTS.md), in date order,
with a table of contents at the top. Their text is unchanged; only the heading level
was shifted so they nest under one document. Each section names the file it came from,
so any claim stays traceable with `git log -- docs/<file>`.

A new number gets a new section in `REPORTS.md`; an old report keeps every number it
was written with. The measurements most often cited today:

| report | records |
|---|---|
| 2026-10-30 — Evidence web session | the combined planner/coder/audit report: migrations 19–26, the six web modules, 82 blindly graded pairs, two-judge agreement |
| 2026-11-04 — Consolidated code audit | 48 code findings across four subsystem slices, with per-finding status |
| 2026-11-04 — 70% feasibility | why 70% keeper precision is not reachable on the current books |
| 2026-11-05 — Case-file judge | confidence calibration, judge variants on 42 held-out rows, the integrated keeper pipeline |
| 2026-11-06 — Baseline / Fixed extraction | the baseline bank, and what the token-cap fix changed |

`build-reports.py` regenerated `REPORTS.md` from the original files; it was removed
once the merge was verified, since its only inputs are now in git history. To rebuild
from history, `git show <sha>:docs/REPORT-<date>.md` gives the original text.

## Where the code lives

`fanfable/src` holds the product; `testing` holds the offline suite and the experiments.
The full module-by-module map, including the section map of the 17,000-line
`lorebook.ts`, is in `CODE-MAP.md`. The short version:

| path | holds |
|---|---|
| `fanfable/src/lorebook.ts` | the largest module (17k lines) — extraction, bank answers, promotion, rulings, retrieval |
| `fanfable/src/cli.ts` | the command line (3.5k lines, 46 `lore` subcommands) |
| `fanfable/src/` other 12 folders | `core`, `gates`, `extract`, `identity`, `court`, `answer`, `plan`, `product`, `web`, `support`, `trace`, `ui` |
| `testing/tests/` | the offline suite — 173 files in one directory, run by `npm test` |
| `testing/scripts/` | measurement entry points named in `package.json` |
| `testing/trials/` | one-off experiments; see its own `README.md` |
| `testing/banks/` | deliberate baseline bank snapshots (versioned on purpose) |

**Specs vs reports, explained once:** a *design* section is a contract for code; a *measurement* next to it is the dated evidence for why. Measurements are never rewritten — a new number gets a dated note. Deleted drafts and session logs live on in git history, not in folders.
