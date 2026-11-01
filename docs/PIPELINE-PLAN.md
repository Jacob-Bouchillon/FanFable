# Pipeline plan — who owns which stage, and how a new part gets in

**Written 2026-10-31.** Companion to `RESOURCE-SHELF.md` (what we keep), `ASSESSOR-BENCH.md`
(what we measured and how it failed), and `RESEARCH.md` (the dated record).

This document exists so that research keeps arriving without the system turning into a pile of
parts nobody can explain. It states one rule, shows the assembly as measured today, and fixes the
gate each candidate part has to clear before it is allowed in.

---

## 1. What actually cleared the 70% bar

Worth writing down, because the thread of work since then has obscured it.

Live bank: 277 proof-grade relations. Names with at least one proof-grade tie: **136 of 182
(74.7%)**. That number was produced by two batches, not by fixing coreference:

| batch | what produced the rows | rows |
|---|---|---|
| ties factory | BookNLP clusters → our identity bridge → our gate | 90 (34 attested, 56 accepted) |
| coverage push | one Q8 pass over passages of each uncovered name | 74 (38 attested, 36 accepted) |

So BookNLP earned its place: its named clusters, quote attribution and co-mention/exchange signals
produced two thirds of the proof rows. Its measured failure is narrow and specific — it does not
join descriptions ("the captain") to named people, and its own README says that is deliberate
because doing so conflates characters.

The 70% was cleared *around* that failure, not by solving it.

---

## 2. The rule

**One owner per stage. No two parts vote on the same output.**

Combining is done by chaining stages, never by blending scores. If two models both decide "is this
pair related", the system stops being explainable, and a wrong answer can no longer be traced to a
part. Stage chaining keeps every part measurable, replaceable, and removable on its own.

Four supporting rules:

1. **Measured before adopted.** No part enters on a model card. Each enters on a number produced
   here, against gold annotations or the user's own confirmed rows.
2. **Fail safe.** No answer means "unknown". A part may abstain; it may not guess in a way that
   propagates into the bank.
3. **No part writes to the bank.** Parts produce candidates and scores. The gate and the user's
   word decide what becomes proof.
4. **Removable.** Pulling any part out must leave the pipeline running with fewer rows, not broken.

---

## 3. The assembly, as measured today

| stage | owner | measured | state |
|---|---|---|---|
| Ingest | our chunker | — | running |
| Names / roster | our roster + guarded identity | 84% of name-bearing BookNLP clusters map; never merges | running |
| Mentions, pronouns | BookNLP | 27,848 pronouns; 52% sit with a named person | running |
| Descriptions ("the captain") | **nobody** | 2,107 description-only clusters, 5,157 pronouns stranded there | **gap** |
| Speakers | BookNLP | 10,005/10,005 attributed; 66.8% to a named person, 15.8% to a description, 16.1% anonymous | running, weak |
| Relation candidates | our three passes + BookNLP signals | BookNLP signals ~0.108 precision; our passes ~0.12 | running |
| Judging | Q8 | 71–76% blind support on its rows; generous | running |
| Ordering | GLiClass v4 Edge | AUC 0.775 on 90 labelled rows | sort only |
| Proof / gate | ours | 277 proof rows, 74.7% coverage, ~75% supported | running |
| Web / threads | ours | — | running |

Two stages have no adequate owner: descriptions and speakers. Those are the only two where a new
part can add capability rather than volume.

---

## 4. The gates a candidate part must clear

**Coreference layer (descriptions → named people).** Admitted only if, on the whole book, it
resolves at least 40% of the 2,107 description-only clusters to a named character *and* a blind
check of 40 joins is at least 85% correct. Coverage alone is worthless: a wrong join fuses two
people, which is the one error that cannot be undone cheaply. Candidates: fastcoref (window-level),
pairwise model (judgement), BookNLP full coreference (measured: 56 joins of 3,279 clusters; fails).

**Speaker layer.** Admitted only if it raises the named-speaker share above 66.8% without
degrading the quotes it already gets right, and 40 sampled attributions (especially the changed
ones) are at least 85% correct blind. Candidate: ModernBookNLP's graph-based attribution
(reported 94.5% overall on PDNC; unproven here).

**Judge.** Used for ordering only, without exception, until it reaches AUC 0.85 against labelled
rows. GLiClass is at 0.775 and stays a sort key. Q8 stays the recall path.

**Proposer.** Admitted only with a precision number at a stated operating point. Volume is not a
qualification: BookNLP's relation signals already deliver 2,145 candidate pairs for 126 hits.

---

## 5. What we will not add

- **More relation proposers at ~10% precision.** That adds rows to judge, not ties. The bank's
  defect is 25% of rows being wrong, not a shortage of candidates.
- **Ensemble voting between models.** Two models agreeing is not evidence; it is two guesses.
- **Any component that writes statuses.** Only the gate and the user's word move a row to proof.
- **Cloud models on book text.** The long-context systems that beat BookNLP on recall require
  sending the manuscript out; that is out of scope.
- **A part that cannot be removed.**

---

## 6. Pending results and what they change

Three tests are queued or running. Each has a pre-registered bar; none may be relaxed after the
fact.

| test | question | changes |
|---|---|---|
| pairwise description resolution (running) | can our model pick the right person for a description, given the passage? | descriptions stage, speaker fallback |
| fastcoref (queued) | how many description joins, and are they right? | descriptions stage |
| ModernBookNLP (queued) | does named-speaker share rise above 66.8%? | speakers stage |

If all three fail their bars, both gap stages stay open and are closed as unsolved rather than
patched with something unmeasured. If one passes, it is adopted alone, measured end to end, and
the other two are dropped — not stacked.

---

## 7. Decisions that belong to the user

- Which chunker the second half of the book uses (blocks re-import of pp. 378+).
- Whether any passing part is wired into the product paths or kept as a trial tool.
- Whether doubtful proof rows (audit-flagged, ~zero coverage cost) are demoted.
- When to push.

---

## 8. Current state, in one line

Coverage target met with two thirds of it from BookNLP and one third from our own model; quality
measured at ~75%; two stages still unowned (descriptions, speakers); three tests in flight, each
with a fixed bar.
