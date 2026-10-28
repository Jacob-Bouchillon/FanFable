# Next steps — working handoff

Date: 2026-10-28
Audience: whoever picks this up next (human or agent).
Scope: what is done, what is next, and exactly how to run each step. Counts only; no book text.

---

## 1. Where the project stands

### Code and tests
- Branch `main`, in sync with origin at the time of writing.
- Test suite: **474 passing**.
- Typecheck: no errors in `fanfable/src`.

### The bank (current production data)
| Measure | Value |
|---|---|
| Entities | 360 (182 characters) |
| Relations | 336 |
| Keepers | 34 (`user_confirmed`) |
| Provisional | 11 |
| Parked | 291 |
| Facts / timeline / events | 573 / 588 / 10 |
| `lore integrity` | exits 0 — every keeper quote is verbatim in a cited chunk |

Ten previously confirmed keepers were quarantined because their stored quotes could not be verified against the source (six were invented, one spliced, three had no chunk reference). Their human confirmation is preserved in `confirmed_by_user`; they remain provisional.

### What was proven in the last session
- A denial of a verified relationship in a chapter is caught, with the denial sentence, the keeper quote and its locator.
- A chapter that simply omits a relationship produces no issue.
- An unsupported claim is not treated as canon and is not reported as a contradiction.
- Denying a provisional tie produces a stored note, visible with `issues --all`.
- Model findings whose quote is absent from the chapter are dropped and counted.

---

## 2. Next task A — measure the unproposed character pairs

This is the largest unmeasured population: character pairs that share at least one passage but have **no relation row at all** (any status). Current count is roughly 3,100.

The question: does that population contain real, quotable relationships, or is it mostly co-occurrence?

### Build
1. Select character pairs with a shared passage and no relation row, either direction, any status.
2. Sample 80, stratified by co-occurrence frequency (1, 2–3, 4–9, 10+) and by the book position of the first shared passage (thirds), seed 42. Record stratum and population weight for each.
3. Build packets mechanically (no model choosing evidence): every passage naming both (cap 6, spread across the book), one sentence of context either side, exact locators. Nothing about bank status or stratum.
4. Two files of 40 packets, plus a CSV with id, pair, stratum, weight, locators.
5. Scoring scaffold that reads a verdicts CSV and computes weighted proportions with Wilson intervals, and prints PENDING when no verdicts exist.

### Judge
Ask an independent judge (long-context model) for one verdict per pair:
- **A** — supported and quotable in a single sentence.
- **B** — supported but needs multiple sentences.
- **C** — not a relationship (co-occurrence, moment, unrelated).
- **D** — indeterminate.

Require the quote and locator for A and B, and a short reason for every verdict.

### Decision rule
| Outcome | Next move |
|---|---|
| Mostly C | Do not build broader evidence machinery for this book; move to the second book |
| Meaningful A | Improve candidate discovery and evidence retrieval |
| Meaningful B | Prototype multi-sentence evidence on a small slice |
| Mostly D | Improve packet coverage before drawing conclusions |

Caveat: absence from the bank is not proof of extraction failure. The judge must decide from the source text alone, blind to bank status.

---

## 3. Next task B — audit and promote the rebuilt bank

The product still reads the old bank (1,448 chunks). The rebuilt bank (738 chunks) removes ~3× duplication but is thinner in content.

Do not swap blindly.

1. Compare: entity and relation counts, kind distribution, keeper set, facts, timeline, reference integrity.
2. Replay the rulings export into the rebuilt bank; report every keeper that resolves and every one that does not.
3. Run `lore integrity` on the rebuilt bank; it must exit 0.
4. Back up the current production bank; promote only if rulings survive and coverage is explained.
5. If any keeper fails to replay, stop and report — do not promote a thinner bank.

Acceptance: reproducible, backed-up promotion with rulings preserved and count differences explained.

---

## 4. Next task C — make planning canon-aware

The planner receives retrieved passages and graph context, not the keeper list. Its outline therefore cites nothing and cannot distinguish verified from unverified connections.

1. Pass keeper ties with kind, evidence and locator into plan drafting.
2. Mark provisional and parked claims separately.
3. Require a locator for any outline claim that depends on canon.
4. Report missing evidence as uncertainty — not as absence, not as contradiction.
5. Preserve intentional AU divergence: a premise that changes canon must be recorded, not rejected.

Acceptance: an outline whose canon claims are traceable, whose uncertainty is explicit, and whose intended divergences are recorded.

---

## 5. Next task D — second book

Run the same pipeline and the same probe types on a different book, keeping the current book as the baseline.

- ingestion and chunk counts;
- evidence integrity (keeper audit, reference integrity);
- answer guard behaviour (keeper-backed, unsupported, absent);
- continuity behaviour (keeper denial, omission, provisional note).

Acceptance: failures separated by stage — extraction, retrieval, planning, continuity — not a single pass rate.

---

## 6. Known issues, in priority order

| # | Issue | Impact |
|---|---|---|
| 1 | Production bank uses the old duplicated chunker | Retrieval context carries repeats; timings not comparable |
| 2 | Rebuilt bank thinner and unmerged | Promoting it would reduce counts; needs audit first |
| 3 | Planner has no keeper list | Outline cannot distinguish canon from invention |
| 4 | Continuity cannot separate canon / AU timeline / intentional divergence | Only canon contradictions are detected |
| 5 | 10 quarantined keepers unprovable from the text | Stay provisional; confirmation preserved |
| 6 | No entity-category checks in prose | A character type can be misstated and pass |
| 7 | No secrecy/context constraints | Public use of a hidden title goes unflagged |
| 8 | 18 parked rows remain unquotable | Unreviewable |

---

## 7. Things not to do

- Do not add relationship kinds for a yield of a couple of rows.
- Do not relax the proof standard to raise keeper counts.
- Do not build the attested tier on the current weak sampling evidence.
- Do not treat a relationship word as proof.
- Do not let a model set a keeper status; only the rule or the user may.
- Do not multiply or reorder sentence text to make a quote fit; spliced quotes fail by design.

---

## 8. Useful commands

```
# bank state
lore status
lore integrity
lore diagnose

# review and promotion
lore notes --prioritise
lore promote --dry-run
lore promote --find-evidence --dry-run

# rulings across a rescan
lore rulings export --out <path>
lore rulings replay --in <path> --dry-run

# product loop
plan draft --premise "..." --divergence "..." --chapters 3
plan approve 1
write chapter 1
check 1
issues --all

# tests
node --no-warnings --test testing/tests/*.test.ts
npx tsc --noEmit
```

---

## 9. The one distinction to keep straight

A claim can be wrong in three different ways, and they are not interchangeable:

1. **Contradicts canon** — a verified tie is denied. Error, with keeper quote and locator.
2. **Contradicts the AU timeline** — something recorded earlier in this story is denied. Error against story state.
3. **Intentional divergence** — the premise deliberately changes canon after its divergence point. Recorded, not rejected.

The system currently implements the first. The other two are the next correctness gap after the bank promotion.

---

## Appendix — paste-ready prompt for Task A

```
# Coder task: measure the unproposed character pairs (packet build + scoring scaffold)

## Objective
Find out whether the largest unmeasured population — character pairs that share passages but have no relation row — contains real, quotable relationships. Build the evidence packets and the scoring scaffold. Do not judge anything; verdicts come from an independent judge later.

## Population
Character entities only. A pair qualifies when:
- both are kind='character' in the live bank;
- they share at least one passage (name or alias, exact token);
- there is no canon_relation row between them in either direction, at any status.
Report the actual count (expected around 3,100).

## Sample
- 80 pairs, stratified by co-occurrence frequency (1, 2–3, 4–9, 10+) and by book position of first shared passage (thirds).
- Deterministic seed 42. Record each pair's stratum and its population size so weighted estimates are possible.

## Packets (mechanical, no model)
For each sampled pair, in a stable order:
- list every passage where both appear, capped at 6, chosen to spread across the book (earliest, latest, and evenly between);
- for each, include one sentence of context either side where available;
- include exact locators;
- include nothing about the bank's status, sampling stratum, or that the pair lacks a relation.
Write two files of 40 packets each under testing/trials/unproposed/, plus a CSV with id, pair, stratum, population weight, locators.

## Packet instructions (exact wording to include at the top)
Judge each pair from the passages only. Give one verdict:
- A — Supported and quotable: a lasting relationship is established by a single identifiable sentence.
- B — Supported, needs multiple sentences: the relationship is clear, but no single sentence establishes it.
- C — Not a relationship: co-occurrence, a moment, or unrelated.
- D — Indeterminate: the packet does not support a reliable verdict.
For A and B quote the sentence(s) and locator. Give a reason of 12 words or fewer for every verdict. Do not use outside knowledge.

## Scoring scaffold (no verdicts yet)
Write a scoring script that reads a verdicts CSV (id,verdict,quote,locator,reason) and computes:
- counts per verdict;
- weighted percentages for A, B, C, D using stratum weights;
- Wilson 95% intervals on the weighted A+B estimate;
- estimated recoverable pairs among the full population;
- a table of A and B pairs with quotes and locators for review.
If the verdicts file is missing or has unfilled verdicts, print PENDING and exit 0. Never invent verdicts.

## Boundaries
MUST NOT: call a model, write to either bank, change statuses, change prompts/ranking, commit/push.
All files under testing/trials/unproposed/. Zero book terms in code; packets are data.

## Acceptance
1. Population count reconciles; sample is 80 with strata and weights; selection reproducible from seed 42.
2. Two packet files exist, 40 packets each; no packet mentions bank status or stratum.
3. The CSV has weights; the scorer prints PENDING with no verdicts present.
4. Spot-check three packets: every passage listed genuinely names both characters; locators correct.
5. No files outside testing/trials/unproposed/ changed; suite unchanged and green; git status clean apart from ignored files.
6. Report counts, packet sizes, and the exact judge instruction block.
```
