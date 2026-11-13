# Organization pass — report (2026-11-13)

Two commits on `experiment/evidence-scan`, pushed to origin. This records what
changed, what was measured, and what was deliberately left alone. It is a report
of work done, not a plan.

| commit | subject |
|---|---|
| `2b2f718` | Lorebook: move rulings export and replay into `lorebook/rulings.ts` |
| `7b9c4f3` | Docs: index every document and merge the dated reports into one file |

Gate at the time of writing: `npm run typecheck` clean, `npm test` 1,555/1,555
passing, before and after every change.

---

## What was wrong

Four separate problems, with very different risk levels.

**The repository root was cluttered.** Eighteen `.log` files from 3 November
(1.5 MB) recorded suite sizes from 1,378 to 1,393 against a current 1,555. A
session report sat at the root while its siblings lived in `docs/`.

**The docs index had drifted.** `docs/` held 26 files and 53,600 words; the index
covered 10 of them, its headline claimed 1,394 tests, and `PAST-TRACKS.md`
described six trial folders that no longer existed plus one source file
(`chain-handoff.ts`) that never did.

**Ignore rules could have committed vendored code.** `.gitignore` re-included
every directory under `testing/trials/` recursively. `valve-bench/` holds two
nested Git repositories (`llama.cpp`, `GLiNER2`) and `coref-probe/data/` holds
another clone. A `git add -A` produced "adding embedded git repository" warnings.
`.openchamber/` was untracked and not ignored.

**One module held a quarter of the source.** `lorebook.ts` was 17,046 lines,
27% of 62,621, with 228 exports across 15 hand-marked sections.

---

## What changed

### Repository root

18 logs moved to `testing/logs/` — already covered by the existing `testing/*`
rule, so no new ignore entry was needed. `SESSION-REPORT-2026-10-30.md` moved into
`docs/` before being folded into `REPORTS.md`. Root went from 30+ entries to 11.

### Ignore rules

`.openchamber/` added. The trials re-inclusion changed from `**/` to `*/`, which
permits `testing/trials/<topic>/<script>` and nothing deeper. Verified: all 133
tracked trial files still tracked, `git add -n` on `valve-bench/` and
`coref-probe/data/` now reports them fully ignored.

### Reports

13 dated reports merged into `docs/REPORTS.md` — 2,059 lines, 22,666 words, in
date order, with a table of contents and one anchor per report.

The merge was a **relocation, not a summary**. The project's own rule is that
measurements are never rewritten; collapsing them into prose would have destroyed
the evidence they exist to preserve.

Verified mechanically:

| check | result |
|---|---|
| content lines byte-identical | 1,134 of 1,136 |
| fences balanced | 6 in, 6 out |
| tables with consistent columns | 38 of 38 |
| TOC anchors resolving | 13 of 13 |
| broken file links in `docs/` | 0 |

The two differing lines are deliberate: two reports pointed at sibling files that
no longer exist as files, so those pointers were repointed at the sections inside
`REPORTS.md`. No measurement, count or claim was touched.

Heading demotion was fence-aware. `SESSION-REPORT-2026-10-30.md` contains five
lines beginning with `#` that are shell comments inside a bash block
(`# web on a copy`, `# benchmark`, …). A naive demotion would have corrupted the
reproduction commands.

### New documents

`docs/CODE-MAP.md` — the section map of `lorebook.ts` with line numbers, modules
by folder, the ten modules reachable only from tests, the test-runner's
non-recursive glob warning, and the measured split analysis below.

`docs/README.md` rewritten to index every document (14 at the time), grouped into live docs,
design records and dated reports, with the verified test count.

`testing/trials/README.md` rewritten to map all 43 folders (was 30) and to state
that scripts commit one level deep only.

### The one code move

The 745-line rulings section became `fanfable/src/lorebook/rulings.ts`, with a
re-export of the same 11-name surface left in `lorebook.ts` so the 19 modules and
96 test files that import from it are unaffected.

Two dependencies surfaced, both handled rather than papered over:

- `compareText` lived in the rulings block but was used by five call sites
  elsewhere in `lorebook.ts`. It moved to `core/text.ts` rather than being
  duplicated. Its body is character-identical.
- `claim-transition-architecture.test.ts` scans `fanfable/src` recursively and
  enforces that every direct writer of relation status is named with an exact
  count. It failed with *"new direct writer lorebook/rulings.ts replayRulings (3)
  is not in the named grandfather list"*. The entries followed the writes to the
  new file with identical counts; the check was not weakened.

Verified: a diff of the moved code against the previous revision is identical
apart from the extracted helper (708 of 711 significant lines byte-identical).

`lorebook.ts`: 17,046 → 16,320 lines.

---

## The split analysis, and why it stopped

The original plan was to extract the low-coupling sections first. Measuring it
showed the plan was wrong, so the plan changed.

Section-to-section references are not the question. The question is whether a
section's **transitive closure** reaches back into `lorebook.ts` — a module that
imports from its old parent re-creates the coupling it was meant to remove.

| seed section | closure needs | lines | verdict |
|---|---|---|---|
| `rulings` | mostly external | 3,889 | done |
| `brief` + `retrieval` | + bank-answer, models, timeline | 6,907 | too entangled |
| `extraction` | + bank-answer, bank-aware ranking, window scoring | 7,923 | too entangled |
| `tie-note relabeling` | 5 sections | 11,230 | too entangled |
| `relabel claims` | private `canonicalKind`, `pairClause` | 145 | needs internals exported |

`brief` and `relabel claims` had been recommended as the easy cuts. Neither is a
clean cut.

### Why not continue

The standard arguments for splitting a large file do not hold in this repository:

- **Tooling:** typecheck 3 s, tests 15 s. No pressure.
- **Merge conflicts:** zero merge commits, zero multi-parent commits in the last
  50, one active branch. Work is sequential.
- **Change rate:** 17 of the last 30 commits touched `lorebook.ts`. It is the
  project's active workspace, not legacy awaiting reorganization.
- **Edit spread:** recent commits touch 12 of 15 sections, heaviest in
  *bank-answer* (8) and *attested tier* (7) — the two least separable.

The next genuine boundary is `loadOrderedChunks` (with `ChunkRow`), which would
let `rulings.ts` drop its last import back into `lorebook.ts`. Past that, progress
requires partitioning the two ~5,000-line sections, which is a design decision
about how bank reasoning should be organized, not a relocation.

---

## Deliberately not done

| item | why |
|---|---|
| test renames (`relations-*`, `relationship-*` → `relation-*`) | cosmetic; the four files are clearly distinct subjects |
| splitting the remaining `lorebook.ts` sections | measured not separable; see above |
| `cli.ts` (3,521 lines, 46 flat subcommands) | real readability issue, but a structural refactor with regression risk in the command surface — needs its own plan |
| delete the 10 test-only modules | needs `git log` review per module to separate deliberate unwired experiments from leftovers |
| index the 29 unlisted `testing/scripts/` entries | one-off report generators; a single index would help, deletion needs judgement |
| edit `docs/RESEARCH.md` provenance | it lists reports deleted before this pass; it is a historical statement, not a live link |

---

## What remains uncommitted

Three scripts in `testing/scripts/` were already modified or untracked before this
pass and were left alone: `resolve-nominal-clusters.ts` (modified, 60+/32−),
`family-pass.ts`, `repair-explicit-name-links.ts`, `resolve-local-clusters.ts`
(untracked). They are the user's in-progress work.

---

## Starting point for the refactor work

Facts worth having before optimizing:

- The bank's proof and promotion logic lives in two sections of `lorebook.ts`:
  *bank-answer cue and inverse rules* (4,972 lines) and *attested tier*
  (3,016). These are the highest-churn, most entangled parts of the codebase.
- 148 of `lorebook.ts`'s 228 exports are not referenced by any other source
  module — there is no honest public boundary to preserve, only the tests'.
- A circular import already exists: `lorebook.ts` imports `noteFromExtraction`
  from `web/note-ingest.ts`, which imports four functions back. Node tolerates
  it because neither module runs code at top level.
- `docs/REPORT-2026-11-04-consolidated-code-audit.md` (now §2026-11-04 in
  `REPORTS.md`) lists 48 code findings, 11 marked HIGH. That is the most
  substantive known-defect inventory in the repository and the natural input to
  a refactor plan.
