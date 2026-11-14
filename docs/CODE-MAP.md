# Code map — where to look for what

This is a navigation aid, not a design document. Design lives in `HOW-IT-WORKS.md`;
module purposes are stated in each file's own header comment, which is the authority.

## The shape of the code

One product, one command line, one test suite:

| path | lines | role |
|---|---|---|
| `fanfable/src/lorebook.ts` | 12,692 | extraction runs, bank answers, promotion — the remainder of the monolith |
| `lorebook/bank.ts` | 920 | entity, relation, fact and timeline reading, search, writer brief |
| `lorebook/roster.ts` | 890 | name derivation, window filtering, span/quote verification |
| `lorebook/timeline.ts` | 844 | event joining, modality, subject resolution, entity capacity |
| `lorebook/rulings.ts` | 759 | rulings export, parse and replay |
| `lorebook/ranking.ts` | 579 | ranking retrieved passages against the bank |
| `lorebook/kinds.ts` | 507 | closed kind vocabulary, glosses, inverse pairs |
| `lorebook/shared.ts` | 251 | helpers two or more modules need |
| `fanfable/src/cli.ts` | 2,581 | entry point, dispatch, and the 1,839-line `cmdLore` |
| `cli/shared.ts` | 153 | argument parsing, colours, data path, flags, project lookup |
| `cli/commands/` | 910 | `state`, `trace`, `checks`, `graph`, `llm` — eight commands |
| `fanfable/src/**, everything else` | 42,065 | 84 modules across 13 folders |

`lorebook.ts` is now 20% of the source (down from 27%) and still imported by 19
modules plus 96 of the 175 test files. Seven modules have been extracted from it;
the remaining cost is concentrated in two sections, *bank-answer* and *attested
tier*, which are mutually dependent.

## `lorebook.ts` section map

The file is divided by banner comments. Line numbers are from the 2026-11-13 tree;
the banner text is stable even when the numbers move.

| line | section | what it owns |
|---|---|---|
| 198 | gates | re-exports the proof rules from `gates/gates.ts`; no logic of its own |
| 254 | models | `EntityKind`, `CanonEntity`, `CanonRelation`, `CanonFact`, `CanonTimelineEntry` |
| 328 | extraction | prompt constants and the extraction result types |
| 847 | window scoring | `scoreWindow`, `selectWindows`, stage-only extraction and the run loop |
| 3,011 | batch plumbing | window batching, mined-chunk bookkeeping, fragment planning |
| 4,650 | name roster | **moved to `lorebook/roster.ts`**; re-export only |
| 4,665 | bank-aware ranking | **moved to `lorebook/ranking.ts`**; re-export only |
| 4,688 | bank-answer cue and inverse rules | `lookupKeeperPair`, `bankAnswerForQuestion`, `quoteNames*`, `locateSentence`, `applyRelations`, `applyTimeline` |
| 8,844 | attested tier | `checkAttested`, anchor filling, tier assignment, relation insertion |
| 11,860 | tie-note relabeling | tie hints, merge counts, quarantine rulings, tie prioritisation |
| 12,477 | relabel claims | `relabelRelations` |
| 12,622 | timeline ↔ event join | **moved to `lorebook/timeline.ts`**; re-export only |
| 12,645 | rulings | **moved to `lorebook/rulings.ts`**; re-export only |
| 12,664 | retrieval + brief | **moved to `lorebook/bank.ts`**; re-export only |

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

| module | lines | closure | verdict |
|---|---|---|---|
| `kinds` | 507 | empty | **done** |
| `ranking` | 579 | empty | **done** — cleanest cut of all |
| `rulings` | 759 | small, external | **done** |
| `shared` | 251 | empty | **done** — helpers two or more modules need |
| `brief` + `retrieval` | 6,907 | + bank-answer, models, timeline | **done** as `bank` after helpers moved |
| `name roster` | 890 | 4 private helpers | **done** as `roster` |
| `timeline ↔ event join` | 844 | 1 private helper | **done** |
| `extraction` pipeline | 4,322 | 5 private fns living in bank-answer | **blocked** |
| `bank-answer` / `attested tier` | ~12,000 | mutually dependent | **blocked** |

The rule that emerged: **a section moves cleanly only when its dependency closure is
empty**, not when its banner looks self-contained. Every section that stalled stalled
because its closure reached back into the monolith.

### The two blocked sections

`extraction` needs `extractWindowLegacy`, `extractWindowSplit`,
`extractWindowWithRecovery`, `recoveryRosterRows` and `aliasHits`, which physically
live about 2,000 lines away inside the *bank-answer* section. The banners describe an
older file layout than the code has.

*bank-answer* and *attested tier* call each other in both directions. Separating them
means deciding where bank answering ends and claim promotion begins — a design
question, not a relocation. That is the honest boundary of the mechanical refactor.

### Staying honest while refactoring

`lorebook.ts` is a facade: it re-exports what the modules under `lorebook/` own. If a
declaration also stays behind in the monolith, **TypeScript raises no error and the
suite cannot see it**, because every test imports through the facade. The local copy
silently shadows the re-export and the two drift apart.

This happened twice during the 2026-11-13 refactor, with typecheck and 1,557 tests
green both times. `testing/tests/lorebook-split.test.ts` now fails loudly on it, and
also flags any module under `lorebook/` that nothing imports.

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
`serve`). Eight of them now live in `cli/commands/`, and the shared plumbing is in
`cli/shared.ts`. `db` is passed to each command rather than held as a module-level
singleton — that singleton was the reason the commands could not be moved before.

`cmdLore` alone still handles 46 subcommands as a flat `if (sub === '...')` chain
spanning 1,839 lines. Measured for splitting: 46 blocks, **6 of which do not end in
`return;`** (`pair-threads`, `births`, `trails`, `rulings`, `correct`, `remove`), so
those need per-branch reading rather than a bulk transform. Largest blocks:
`extract` 232 lines, `trails` 170, `ties` 104, `thread` 100.

When adding a `lore` subcommand, follow the existing chain; do not introduce a
dispatch table for one command.
