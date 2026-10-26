# Frozen pairs v1 — Plagueis probe (20)

Source: `RESOURCES/Novels/Darth Plagueis - James Luceno.pdf` (local-only, not tracked).
Extractive build: 12-window selective extract, seed 42, then capped probe mining.
Each row: pair class + expected behavior. Full verdicts in `scores-v1.md`.

## Stable (5) — label holds wherever asked

| ID | A | B | Expected |
|----|---|---|----------|
| S1 | Pax Teem | Kim | peer/colleague (NOT assistant). Old bank `assistant of` was misattachment. |
| S2 | Aks Moe | Pax Teem | `aide of` — banked, cited (p. 172). |
| S3 | Ranulph Tarkin | Bor Gracus | `aide of` — true per text; recall miss in rebuild (see scores). |
| S4 | Darth Maul | Darth Plagueis | no master tie — operative/pawn at most; silent `master of` must stay pending. |
| S5 | Hego Damask | Darth Plagueis | association only — no lasting formal tie asserted. |

## Changing across boundary (5) — ask pinned, label depends on chapter

| ID | A | B | Asked as of | Expected |
|----|---|---|-------------|----------|
| C1 | Plagueis | Tenebrous | early Part Three | `apprentice of` — "I call you apprentice" (p. 18-19). |
| C2 | Plagueis | Tenebrous | late (p. 440+) | terminal event (`killed`) — event, never a tie. |
| C3 | Plagueis | Palpatine | early | `encourager of` behavior only — NOT a bankable tie (pending). |
| C4 | Darth Plagueis | Darth Sidious | early | master→apprentice arrow Plagueis→Sidious; reversed reading is wrong. |
| C5 | Jabba Desilijic Tiure | Darth Plagueis | late | `partner`/`partner with` — cited (p. 311-312), quote must name endpoints. |

## Alias traps (5) — must never merge, must abstain as ties

| ID | A | B | Expected |
|----|---|---|----------|
| T1 | Boss Cabra | Boss Darnada | distinct people (father/son); no tie asserted between these two spellings — abstain. |
| T2 | Darth Maul | Darth Sidious | distinct people sharing `Darth` — abstain. |
| T3 | Plagueis | Darth Plagueis | same person short form — co-speaker veto, abstain as tie. |
| T4 | Palpatine | Emperor Palpatine | same person — abstain as tie. |
| T5 | Scar | No Scar | distinct, same passage — abstain as tie. |

## Absent controls (5) — must abstain with evidence

| ID | A | B | Expected |
|----|---|---|----------|
| A1 | Han Solo | Jocasta Nu | no tie in text — abstain. |
| A2 | Dooku | Toonbuck Toora | no tie in text — abstain. |
| A3 | 11-4D | Aurek-Bacta | no tie in text — abstain. |
| A4 | Count Vemec | Chatak | no tie in text — abstain. |
| A5 | Geonosian Archduke | Climber | no tie in text — abstain. |
