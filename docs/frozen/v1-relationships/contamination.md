# Contamination — filled 2026-10-26, model `qwen2.5:7b` (Q4_K_M)

Method: 8 no-context QA (answer from own knowledge, no passages), 4 confabulation
controls (entities/events that cannot be in the book), 3 verbatim-completion
probes. Temperature 0.2, instruction to say "I don't know" when unsure.

## No-context QA: 1/8 (weak hit only)

| ID | Asked | Model said | Verdict |
|----|-------|------------|---------|
| Q1 | Plagueis's Sith Master? | "Darth Tyranus / Count Dooku" | WRONG (truth: Tenebrous) |
| Q2 | Pax Teem's aide? | "I don't know" | abstain |
| Q3 | Bor Gracus aide to whom? | "Darth Plagueis" | WRONG (truth: Tarkin) |
| Q4 | Boss Cabra's son? | "Darth Plagueis" | WRONG (truth: Darnada) |
| Q5 | What is 11-4D? | "a droid serving Plagueis" | HIT (guessable designation) |
| Q6 | Kim's planet? | "Lothal" | WRONG + anachronistic (truth: Naboo) |
| Q7 | Larsh Hill's affiliation? | "Sith Order" | WRONG (truth: Banking Clan) |
| Q8 | Plagueis's species? | "Human" | WRONG (truth: Muun) |

## Confabulation controls: 4/4 abstained

Rexford (invented captain), Tenebrous's flagship (no such fact), Yoda duel
(never happens), Plagueis's wife (none) — all correctly "I don't know".

## Verbatim completion: 0/3

P1 completed backwards ("my master" for "apprentice" — same arrow error the
directed-status fix addresses); P2 abstained; P3 paraphrased, not verbatim.

## Reading

No parametric memory of this book's specifics: obscure answers wrong,
anachronistic where lore-adjacent (Lothal), zero verbatim recall. The single
hit (droid-ness of "11-4D") is designation-guessable. Confabulation risk is
real for fluent QA (6 confident wrongs) but the controls show abstention works
when the ask is out-of-book.

Status: v1 is BOTH regression guard and citable recall claim. Recall figures
may be cited as system-on-text recall, with the usual small-n caveat (20 pairs,
selective 12-window base). Re-run this probe if the model changes.
