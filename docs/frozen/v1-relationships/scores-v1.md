# Scores v1 (frozen 2026-10-26, rebuilt DB, fixed build)

Extractive base: 12-window selective extract (seed 42) + capped probe mining.
Bank at probe time: 52 relations (23 accepted / 29 needs_review), 10 notes, 5 events.
Probe cost: ~476s wall for 20 asks (~24s/pair, concurrency 1).

## Correct-cited-scoped (3)

- S2 Aks Moe → Pax Teem `aide of` — quote + p. 172 resolve.
- C1 Plagueis → Tenebrous `apprentice of` — "Then for the last time, I call you apprentice." (p. 18-19).
- C5 Jabba → Plagueis `partner` — cited (p. 311-312); quote endpoint-thin, re-read trigger noted, label accepted.

## Correct-abstain-with-evidence (14)

- S1 Pax Teem / Kim — pending (misattachment gate), not `assistant of`. Peer/colleague vocab human-gated; relabel outstanding.
- S4 + Darth Plagueis / Maul — flagged masters invisible; both abstain.
- S5 Damask / Sidious — no tie banked this run; abstains.
- Boss Cabra / Darnada — pending, not inverted `son of`.
- T1–T5, A1–A5 — all 9 controls + all 5 alias traps abstain; zero false merges.

## Known failures (3) — each with mechanism + planned fix

- #3 Tarkin aide **recovered 2026-10-26 by pinned re-read** — was recall miss (6-passage enrich: 0 relations). Resetting seq 664–671 to unread and mining that single window banked `aide of` accepted with the exact verifying quote. Emission failure, not gate, not coverage — the words were in already-mined chunks. Narrow scope fixed what broad windows missed.
- #10 Jabba partner **recall miss, confirmed 2026-10-26** — true per text (partnership), neither bank nor probe mining nor targeted 6-passage enrich (relations:0, facts:1) emitted it. Zero Jabba ties banked. Mechanism: recall, not gate or ranking. Recorded as confirmed-miss; re-read on a wider window set is the honest next try, not a gate change.
- #7 `encourager of` **open verb** — behavior banked as tie. Mechanism: open vocabulary, no kin group. Fix: #7 closed role-noun gate (park unlisted kinds).
- #8 `responsibility to` **paraphrase-directionless** — new label, no arrow. Mechanism: open vocabulary + undirected reading. Fix: #7 gate + directed status (already built; caller opt-in outstanding).

No edits to verdicts without a procedure-change entry in `CHANGELOG.md`.
