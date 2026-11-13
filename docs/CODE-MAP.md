# Code map — where to look for what

This is a navigation aid, not a design document. Design lives in `HOW-IT-WORKS.md`;
module purposes are stated in each file's own header comment, which is the authority.

## The shape of the code

One product, one command line, one test suite:

| path | lines | role |
|---|---|---|
| `fanfable/src/lorebook.ts` | 16,320 | extraction runs, bank answers, promotion, retrieval — 228 exports |
| `fanfable/src/lorebook/rulings.ts` | 759 | rulings export, parse and replay |
| `fanfable/src/cli.ts` | 3,521 | the command line: 14 top-level commands, 46 `lore` subcommands |
| `fanfable/src/**, everything else` | 42,065 | 75 modules across 13 folders |

`lorebook.ts` is still 26% of the source and is imported by 19 modules plus 96 of the
173 test files. It is the highest-cost thing to change and the highest-value thing
to understand first. Read its section map below before touching it.

## `lorebook.ts` section map

The file is divided by banner comments. Line numbers are from the 2026-11-13 tree;
the banner text is stable even when the numbers move.

| line | section | what it owns |
|---|---|---|
| 111 | gates | re-exports the proof rules from `gates/gates.ts`; no logic of its own |
| 167 | models | `EntityKind`, `CanonEntity`, `CanonRelation`, `CanonFact`, `CanonTimelineEntry` |
| 241 | extraction | prompt constants that delegate to `extract/extract-prompts.ts`, plus the extraction result types |
| 760 | window scoring | `scoreWindow`, `selectWindows`, `starvedCandidateIndices`, stage-only extraction and the run loop |
| 2924 | batch plumbing | window batching, mined-chunk bookkeeping, unfinished-run recovery, fragment planning |
| 4580 | name roster | `buildNameRoster`, window name caps, roster diagnostics |
| 5424 | bank-aware ranking | ranking candidates with what the bank already knows |
| 5692 | bank-answer cue and inverse rules | the largest section (4,972 lines): keeper/attested lookup, pair questions, kind glosses, promotion decisions, attested tiers, entity merges, tie evaluation, relation assessment |
| 10664 | attested tier | `checkAttested`, anchor filling, tier assignment, relation insertion |
| 13680 | tie-note relabeling | tie hints, merge/tie counts, quarantine rulings, tie evaluation and prioritisation |
| 14297 | relabel claims | `relabelRelations` |
| 14442 | timeline ↔ event join | timeline/event linking, kind normalisation, modality, subject resolution, entity capacity |
| 15411 | rulings | **moved to `lorebook/rulings.ts`**; only a re-export remains here |
| 16156 | retrieval | entity/relation/fact/timeline listing, pair history, `searchLore`, `loreStats` |
| 16581 | brief | `buildLoreBrief`, `renderBrief`, `formatLoreBrief` |

Two sections dominate the file: *bank-answer cue and inverse rules* (4,972 lines)
and *attested tier* (3,016). Between them they hold the proof-and-promotion half of
the system. If you are working on whether a claim may bank, start there, not at
the extraction section.

Note that `lorebook.ts` deliberately re-exports `gates`, `extract-prompts`,
`identity/names` and `identity/relation-proof` so older importers keep working.
The comment at each re-export names the module that actually owns the logic.

### Which sections can actually be split out

Measured 2026-11-13 by transitive-closure analysis. A section is a **clean cut**
only if the code it needs does not lead back into `lorebook.ts` — a new module that
imports from its old parent re-creates the coupling it was meant to remove.

| seed section | sections its closure needs | lines | verdict |
|---|---|---|---|
| `rulings` | batch plumbing, extraction, timeline↔event, rulings | 3,889 | **done** — see below |
| `brief` + `retrieval` | + bank-answer, models, timeline↔event | 6,907 | too entangled |
| `extraction` | + bank-answer, bank-aware ranking, window scoring | 7,923 | too entangled |
| `tie-note relabeling` | 5 sections | 11,230 | too entangled |
| `relabel claims` | needs private `canonicalKind`, `pairClause` | 145 | not worth it |

`rulings` was the only section with a small, mostly external dependency set, and it
has been moved. The rest are not separable without first partitioning the two huge
sections, and a split that imports back from `lorebook.ts` is not a split.

`lorebook/rulings.ts` imports `loadOrderedChunks` and `ChunkRow` from
`lorebook.ts`; that one direction is deliberate and tolerated, because no top-level
code runs in either module, so the cycle is initialisation-safe. Moving
`loadOrderedChunks` out is the next real boundary, not more section-shuffling.

## Modules by folder

| folder | modules | what it owns |
|---|---|---|
| `core/` | `db`, `schema`, `migrations`, `llm`, `json`, `text`, `vocab`, `combine` | SQLite access and migrations, the model client, tolerant JSON, shared vocabulary |
| `gates/` | `gates`, `veto`, `veto-bridge`, `veto-batch` | the proof rule (what may bank) and the removable model veto stage |
| `extract/` | `extract-prompts`, `recovery`, `sweep` | prompt wording, the durable attempt/lease ledger, name sweep |
| `identity/` | `names`, `identity`, `identity-check`, `roster-rules`, `relation-proof`, `cleanup`, `alias-context`, `alias-groups`, `surface-shape`, `name-harvest`, `booknlp-bridge`, `candidate-categories` | who a name refers to, which rows are one person, which names may match |
| `court/` | `claim-proof`, `claim-transition`, `ruling` | claim identity, compare-and-set status transitions, the audit record |
| `lorebook/` | `rulings` | rulings export, parse and replay — extracted from `lorebook.ts` on 2026-11-13 |
| `answer/` | `lore`, `lore-ask`, `lore-search`, `lore-diagnostics`, `dossier`, `chapters`, `retrieval`, `evidence`, `evidence-retrieval`, `rule-checker`, `thin-ranked` | retrieval, answering, dossiers, missing-lore diagnostics, evidence packets |
| `plan/` | `planner`, `controller`, `brief`, `context-trace` | premise and outline, the only DB-touching orchestrator, the web brief |
| `product/` | `server`, `writer`, `continuity`, `continuity-settings`, `memory`, `premise-check`, `recognition`, `state-conflicts`, `trail-html`, `web3d`, `dev-summary`, `booknlp` | the local web UI, chapter writing, continuity, story state |
| `web/` | `threads`, `pair-threads`, `meetings`, `note-ingest`, `character-sweep`, `thread-worker`, `chapter-index` | the evidence web: threads, notes, open ends, meetings, births |
| `support/` | `graph`, `graph-checks`, `embeddings`, `importer`, `lore-import`, `edge-rank`, `search-policy` | the knowledge graph, embeddings, format-aware import, ranking |
| `trace/` | `trace`, `extraction-trace`, `write-trace`, `trace-readonly` | accounting ledgers for retrieval, extraction and writing |
| `ui/` | HTML, CSS, JS | the browser front end; no build step |

## Modules not reached from `fanfable/src`

Ten modules are imported only by tests or by scripts under `testing/`. They are
not dead by default — several are deliberate experiments awaiting wiring — but they
are not on any product path today. Confirm with `git log` before deleting anything.

| module | reached from |
|---|---|
| `identity/cleanup.ts` | identity tests, `scripts/entity-harvest.ts`, `scripts/cleanup-entities.ts` |
| `identity/name-harvest.ts` | name-harvest tests, `scripts/entity-harvest.ts` |
| `identity/alias-context.ts` | alias-context tests, `scripts/alias-context-report.ts` |
| `identity/alias-groups.ts` | alias-groups tests, two report scripts |
| `identity/surface-shape.ts` | surface-shape tests, `scripts/classify-surfaces.ts` |
| `identity/booknlp-bridge.ts` | booknlp-bridge tests |
| `web/character-sweep.ts` | character-sweep tests, `scripts/character-sweep.ts` |
| `web/thread-worker.ts` | thread-worker tests, `scripts/thread-worker.ts` |
| `core/combine.ts` | combine tests, `trials/combine/measure.ts` |
| `gates/veto-bridge.ts` | veto-path tests |

## The test suite

`npm test` runs `testing/tests/*.test.ts` — **one directory, no recursion**. A test
moved into a subfolder stops running and the suite still reports success. If you
ever reorganize tests, change the glob in `package.json` and `.github/workflows/ci.yml`
in the same commit.

173 files, no `describe()` blocks, one behaviour per file, named after the behaviour.
The vocabulary is close to the glossary, but three spellings of the same concept are
in use: `relation-*` (7 files), `relations-*` (2), `relationship-*` (2). Prefer
`relation-` for new files.

Tests import the module under test directly; 87 of them do `import * as lorebook`,
so any split of `lorebook.ts` touches the majority of the suite.

`typecheck` covers `fanfable/**` and `testing/**` but excludes `testing/trials/**`,
which is why trial scripts may drift out of type-safety without failing CI.

## Entry points named in `package.json`

| script | file |
|---|---|
| `npm run fanfable` | `fanfable/src/cli.ts` |
| `npm test` / `test:ci` | `testing/tests/*.test.ts` |
| `eval:retrieval` | `testing/scripts/evaluate.ts` |
| `eval:continuity` | `testing/scripts/evaluate-continuity.ts` |
| `eval:writing` | `testing/scripts/evaluate-writing.ts` |
| `eval:models` | `testing/scripts/evaluate-models.ts` |
| `eval:blind` | `testing/scripts/evaluate-blind.ts` |
| `eval:long` | `testing/scripts/evaluate-long-story.ts` |
| `eval:ratings` | `testing/scripts/compare-blind-ratings.ts` |
| `bench:corpus` / `bench:corpus:fresh` / `bench:watch` | `testing/scripts/benchmark/` |

26 other scripts in `testing/scripts/` are not referenced by `package.json`, the
docs, or each other. They are one-off report generators; run them directly.

## CLI structure

`cli.ts` has 14 top-level commands (`project`, `import`, `sources`, `lore`, `plan`,
`write`, `check`, `issues`, `state`, `continuity`, `graph`, `conflicts`, `llm`,
`serve`). `cmdLore` alone handles 46 subcommands as a flat `if (sub === '...')`
chain spanning roughly 1,800 lines. When adding a `lore` subcommand, follow that
pattern; do not introduce a dispatch table for one command.
