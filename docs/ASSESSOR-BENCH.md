# Assessor bench — what it measured, what it did not

**Written 2026-10-31.** Companion to `RESOURCE-SHELF.md` §1 (judges) and `RESEARCH.md`
(the dated entry for this run). This is the detailed record of the first judge bench: the
frozen set, the three contestants, the numbers as delivered, the five defects found in those
numbers, and the one small run that would settle the question.

**Reading rule.** *Measured* means we ran it here and the count is ours. *Reported* means the
model card's own figure. Counts only in this document: no passage prose, no per-row verdicts,
no entity names.

**Status at writing.** Bank untouched by this bench (read-only, stat-proofed each step). Nothing
banked, nothing promoted, nothing demoted. All commits local at the time of writing.

---

## 1. The question the bench was meant to answer

Our assess step is Spark-X2.6-4B-Q8 ("Q8") at roughly 6.4 s per call. It is generous: on the
coverage push it scored 204 notes above the 0.7 bar where the qwen baseline scored 95, and the
two false-positive audits measured blind support for its rows at 0.711 and 0.756. Generous is
survivable; slow and uncalibrated is what costs.

So the bench asked: **can a small, cheap judge replace or supplement Q8 on the assess chair,
scoring the same candidate pairs against the same evidence, without losing the true ties?**

The decision it was meant to inform: swap the assess step, add a second opinion, or leave it
alone. A swap would have to beat Q8 on precision *at acceptable recall* and be cheaper per item.

---

## 2. The frozen set

| | count | source |
|---|---|---|
| positives | 34 | every row with `review_status = 'user_confirmed'` (the user's word is the truth standard) |
| negatives | 24 | rows the two false-positive audits judged `co-presence-only`, `wrong-kind` or `wrong-direction` (never `cannot-tell`) |
| **total** | **58** | below the 60 the prompt asked for; stated and proceeded |

Each packet carried pair, kind, quote and the citing passage — and nothing else. No status,
no stored assessment, no confidence, no source. That part was built correctly and is the
reusable asset: `testing/trials/assessor-bench/packets.json` (gitignored).

An honest note on the size: 58 rows cannot separate two models that differ by less than about
15 points. The bench was designed to find a large win, not to rank near-ties.

---

## 3. Results as delivered

| model | N scored | acc | precision | recall | AUC | setup |
|---|---|---|---|---|---|---|
| Q8 (incumbent, stored) | 58 | 0.500 | 0.547 | 0.853 | — | none, no new calls |
| GLiClass v4 Edge | 58 | 0.655 @0.5 | 0.938 @0.5 | 0.441 @0.5 | 0.727 | pip, 0.4B, CPU |
| GLiDRE multi | 18 | 0.833 | 1.000 | 0.571 | 0.714 | source install, 300M, CPU |
| relweave-4b | 0 | — | — | — | — | blocked |

Two of the four columns are not what they appear. The sections below take them in order of how
much they change the reading.

---

## 4. Defect 1 — the question asked was malformed

The harness builds the claim as `"{A} is {kind} of {B}"`. The bank stores kinds as complete
prepositional phrases:

| kinds in the frozen set | count |
|---|---|
| ending in " of" (`ally of`, `aide of`, `master of`, …) | 8 of 10 distinct |
| not ending in " of" (`appears_with`, …) | 2 of 10 |
| empty | 19 of 58 packets |

So for the large majority of packets the model was asked, literally, whether the passage states
that **"X is ally of of Y"** — a doubled preposition — and for the 19 blank-kind packets it was
asked whether the passage states that "X is ␣ of Y", which is not a claim at all but a
co-occurrence question.

This matters because GLiClass is a 0.4B instruction-conditional classifier: the wording *is*
the interface. Feeding it ungrammatical claims is not a neutral test of its ability. The
measured 0.441 recall is therefore a **floor produced by our own harness**, not the model's
ceiling — the same class of mistake as the 41 unparsable responses in the first audit, caught
that time before it was reported as a finding.

## 5. Defect 2 — the Q8 column is circular

`compare.ts` recomputes Q8 from stored assessments: `strength >= 0.7` predicts true. The
negatives in this set are, by construction, rows that **were banked through a gate requiring a
positive assessment at that same threshold**. So Q8 predicting "true" for all 24 of them is not
a measurement of Q8's false-positive rate; it is the definition of the negative set.

The consequence is a one-sided scoreboard:

- Q8's precision (0.547) is depressed by 24 rows it was guaranteed to accept.
- The reported "+0.39 precision margin for GLiClass over Q8" compares a judge measured on
  adversarial negatives against an incumbent measured on the same rows it was chosen from.
- Q8's recall of 0.853 is real but only mildly informative: 29 of 34 user-confirmed rows sit
  above the bar, 5 do not — and user-confirmed rows bank on the user's word regardless of what
  any assessor said.

None of this means Q8 is good. It means **this set cannot rank Q8 against anything.** The
audits already measured Q8's rows at 0.711 and 0.756 blind support; that number stands on its
own sample and does not need this bench.

## 6. Defect 3 — most of the "hard negatives" are not hard

Of the 24 negatives, **19 have an empty kind**. All 34 positives have a kind. So the bench's
real semantic test — "can this judge tell a wrong-kind or wrong-direction claim from a right
one?" — rests on **5 rows**, which is too few to distinguish a 0.9 judge from a 0.7 one.

Reported separately, on the 5 kinded negatives only:

| threshold | kept rows | positives kept | precision | false-positive rate on kinded negs |
|---|---|---|---|---|
| 0.20 | 31/39 | 28/34 (R 0.82) | 0.90 | 0.60 |
| 0.35 | 23/39 | 21/34 (R 0.62) | 0.91 | 0.40 |
| 0.45 | 20/39 | 19/34 (R 0.56) | 0.95 | 0.20 |
| 0.50 | 15/39 | 15/34 (R 0.44) | 1.00 | 0.00 |

AUC on that restriction is 0.694, essentially unchanged from the 0.727 on the full set — which
tells us the blank-kind rows were not inflating the score, they were simply easy.

## 7. Defect 4 — the labels answer a different question than the judge

The positives are **true ties**. The question put to every judge is **"does this passage state
that claim?"** Those diverge exactly where a tie is real but the cited chunk does not carry the
proof — a user-confirmed relation established from other parts of the book, or a tie the gate
would call `coverage-only`.

Cross-referencing the mech audit: 26 of the 34 confirmed positives carry at least one
mechanical flag from audit 2 (mostly the strict endpoint-scope reading, which disagrees with the
alias-aware gate on 232/232 rows and is not a defect in the row). Their mean GLiClass score is
0.439 with 11 above 0.5; the 8 unflagged ones mean 0.573 with 4 above 0.5. Small numbers, same
direction: **the confirmed-but-unproved rows drag recall down for a reason that is about the
evidence packet, not the judge.**

Any future bench must either (a) use only rows whose proof is mechanically clean, or (b) label
two separate things — *true* and *proved here* — and score the judge against the second.

## 8. Defect 5 — the passage does not fit the model

GLiClass Edge is a DeBERTa-v2 with `max_position_embeddings = 512`. The packets carry passages
of median 1,883 characters (p25 1,193, p75 2,095, max 2,631), before the label instructions
are added. **More than half the packets exceed what the model can read**, so in many cases the
sentence that proves the claim was truncated away.

The length split is less dramatic than expected — short positives 8/17 accepted, long positives
7/17 — so truncation is not the dominant cause. But it is a real, fixable handicap and it
should not be present in a bench that is supposed to test judgment.

---

## 9. What survives all five defects

Three things are still true and worth keeping:

**1. GLiClass separates in the right direction, weakly.** Positives mean 0.470, negatives 0.276
overall; 0.470 vs 0.303 on the kinded subset. AUC 0.69–0.73. A weak-but-real signal, from a
model that was asked a broken question about a passage it could not fully read. That is a
promising floor, not a verdict.

**2. At 0.5 and above it is close to a pure precision filter.** 15 of 16 kept rows were
confirmed ties. The cost is brutal: it throws away 19 of 34 confirmed ties. As a hard gate that
is unacceptable. As a *routing* device — keep → straight to the bank queue, reject → human
queue — it is exactly the shape a valve wants, provided the rejected rows are parked, never
demoted.

**3. Its speed is not the win the card implies.** 281 s for 58 packets = **4.85 s per item on
CPU**, against Q8's 6.4 s per call on GPU. The card's 11 ms is a GPU, batched, short-input
figure. So the pitch "run it while you read" does not hold at 0.4B on this box; the pitch that
does hold is "it runs on CPU, so it can work while the GPU does something else."

**GLiDRE is unusable in its current form**: 40 of 58 packets were skipped because the supplied
names could not be located as spans in the passage. Its 1.000 precision and 0.571 recall rest on
7 positives and 11 negatives. The model may be fine; the integration is not, and it needs span
location before it can be scored. That is plumbing work, not a trial.

**relweave never ran**: its 4-bit path needs CUDA torch; this environment holds CPU torch
(installed deliberately, because BookNLP needs it). Installing CUDA torch into the same venv
would break the BookNLP lane. It needs its own environment, which is a separate, deliberate
decision rather than a bench step.

---

## 10. Verdict

**No swap. No adoption. One cheap re-run before the judge slot is judged.**

The bench as delivered does not support "GLiClass wins" — it supports "GLiClass produced a
signal worth measuring properly". The +0.39 precision margin over Q8 must not be quoted: the
comparison is circular, and `RESEARCH.md`'s entry for this run is corrected by this document to
that effect.

What we learned that changes decisions:

- The judge slot is not settled by a 58-row set; a 58-row set finds big wins only. Future
  benches need ≥150 rows with mechanically clean proof, or they will keep producing
  intervals too wide to act on.
- Precision measuring is worthless if the negatives are chosen by the incumbent's own gate.
  Negatives must be drawn blind — unsupported rows from an independent judge, plus ARF's 35,230
  no-relation chunks for the invention-rate question.
- Asking "is this passage proof" is the right question for a gate, and it is *not* the same as
  "is this tie true". The bank's tiers already encode that distinction; the bench did not.

---

## 11. The next run — Phase 1b, fully specified

Cheap: CPU only, no downloads, same frozen 58 plus a phrasal fix. ~6 minutes of compute.

**Fixes, in order:**

1. **Claim string.** Build the predicate from a phrase table, never by concatenation:
   `kind` → `"{A} is {phrase}"` where `ally of` becomes `A is an ally of B`, `appears_with`
   becomes `A appears with B`, and blank kinds are excluded from the run and reported
   separately (19 packets).
2. **Passage window.** Trim each passage to the quote's sentence ±1 sentence, hard-capped at
   1,200 characters. State the trim rule in the manifest; report how many packets were trimmed.
3. **Labels.** Two labels that do not share a prefix: `supported` and `not supported`, with
   one-sentence descriptions each. No `threshold=0.0` parse dance.
4. **Two metrics sets.** (a) all kinded packets; (b) kinded packets whose rows are mechanically
   clean. Report both. Report the 19 blank-kind negatives as their own line, never folded in.
5. **No Q8 column.** The stored assessment is not a competitor on this set; if a comparison to
   the current assessor is wanted, it must come from fresh Q8 calls on the same trimmed
   passages — which costs 58 × 6.4 s ≈ 6 minutes of GPU and should be a separate, explicitly
   approved run.

**Decision rule, stated before the run:**

| outcome | decision |
|---|---|
| kinded AUC ≥ 0.85 and recall ≥ 0.75 at precision ≥ 0.85 | GLiClass earns the veto slot; draft the integration |
| kinded AUC 0.75–0.85 | veto slot with a human queue behind it; no gate change |
| kinded AUC < 0.75 | the judge slot stays with Q8; move to the mapper |

**What this run does not test:** whether *any* of these models can replace the assessor on real
candidate floods. That needs the ARF negatives and a precision/recall curve on thousands of
rows, not dozens.

---

## 12. If GLiClass does earn the veto slot — the operating point

For a flood of new candidates, before any banking:

| operating point | keeps | of what it keeps, true | of all true ties, recovered |
|---|---|---|---|
| 0.45 | ~35% of rows | ~0.95 | ~56% |
| 0.50 | ~28% of rows | ~1.00 | ~44% |
| 0.60 | ~19% of rows | 1.00 | ~32% |

Rules that must accompany it, whichever point is chosen:

- Applies to **new, unbanked candidates only**. Never to existing accepted, attested or
  user-confirmed rows — the set proves it would discard more than half of them.
- Rejections go to the human queue with the reason recorded. Never demote, never delete.
- The threshold is re-derived from our own curve after Phase 1b, not copied from the card.
- Every run writes a manifest with model, threshold, packet count, keep count, and commit.

---

## 13. Environment notes (reproducibility)

- GLiClass v4 Edge: `pip install gliclass`, model from HF cache, CPU. Harmless
  model-type warning on load. 281 s / 58 packets.
- GLiDRE: source install; **downgraded transformers 5.22 → 4.51 inside the bench venv**. This
  is disclosed because order mattered — GLiClass had already scored. Any future run that
  installs both must keep them in separate venvs.
- GLiDRE root causes fixed mid-run: list-typed entity refs produced all-zero scores; passage-only
  documents produced empty entity lists. Both fixed; 40 skips remained, all span-location.
- relweave: `peft` + `bitsandbytes` installed to prove the block; 4-bit inference refuses to
  initialise without CUDA, and the box has CPU torch by design.
- Bank read-only throughout; stat checked before and after each phase.
- Typecheck clean, tree clean at commit.

---

## 14. Limits of this document

- n = 58, and 19 negatives are degenerate. Nothing here can rank judges that differ by less
  than about 15 points, and nothing here establishes a false-positive rate for the bank.
- The Q8 column is definitional, not measured. Do not quote it as a model comparison.
- The positive labels are the user's word about *truth*, while the judge answers *proof*. The
  measured recall mixes the two, in an unknown proportion.
- One run per model; no threshold tuning beyond a reported sweep; no batching, so the latency
  figures are single-item CPU numbers.

---

## 15. Addendum — what happened after this bench (same day)

The Phase 1b re-run proposed in §11 was superseded, and the judge question was answered a
different way. Recorded here so this document is not read as the last word on judging.

**Entailment ranking over the real queue.** With the claim string and passage window fixed, GLiClass
scored 364 of the 578 queue rows and reached **AUC 0.775** on the 90 rows the two audits had
labelled (32 positives, 5 negatives that survived the kind join). At 0.5 it kept 15 rows, all true,
for 19 of 34 confirmed ties lost. That is the 0.70–0.80 band: **sort order only**, no flags, no
gate. Full record: `PIPELINE-PLAN.md` §6.

**A strict quote check of all 277 proof rows.** A second model, given each row's quote, names,
relation and direction, rejected **130 of 277** — 109 of the 151 rows that carry a relation word.
Failure classes: the arrow reversed, the wrong actor credited, one endpoint never named, or a
relation word outside any fixed vocabulary. The two audits had measured ~75% support on samples;
this check is harsher because it demands the *sentence* prove the claim, not merely the passage.

**What that changes for this document.** The judge slot was never the bottleneck. Even a perfect
judge cannot see that `Maul — master of — Sidious` contradicts its own evidence, because that is a
structural fact about direction, not a semantic score. The correction belongs in the pipeline, not
in a better assessor: fixed relation vocabulary with known inverses, actor and endpoint checks,
and evidence regathered per relation after the roster is de-duplicated. See `PIPELINE-PLAN.md` §6a.
