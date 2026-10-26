# Close the loop — findings record (2026-10-26, UNVERIFIED build)

Status: implemented per instruction WITHOUT running tests or typecheck.
The suite was 276-green before this change; it is UNVERIFIED after it. The
Tarkin pinned-window recovery stands as behavioral evidence for the mechanism,
but the wired loop itself has no green run. Do not cite this increment as
green. Next step is a test run, then this file gets a verification line.

## What was built

`closeTheLoop` in `fanfable/src/lorebook.ts`, called inline at the end of
`extractLore` before the report/audit: gap scan → tight gate → capped enrich →
dedupe, never throws the extraction. No new machinery, no prompt rewording, no
gate loosening. Deferred `import('./lore-diagnostics.ts')` avoids the
lorebook↔diagnostics import cycle (resolved at runtime, long after init).

## Measurements behind the design (probe DB, read-only scripts)

- Gap load: 124 gap entities (0 ties, or 1 tie with mentions > 3), 122 with
  already-mined passages.
- Loose gate (any cue anywhere in passage, extended list): 75 hits — barely
  filters; political/business words (`assistant`, `partner`, `master`) are
  everywhere in this book.
- Kin-only loose: 66 hits — still too many.
- Tight gate (same-sentence name-plus-cue, mined passages only): **14 hits**,
  Tarkin among them. Non-person junk included (Banking Clan, Sojourn, Theed —
  kinship words near place names); bounded waste, returns nothing.
- Per-call costs (measured wall-clock, qwen2.5:7b, concurrency 1): extract
  window (3 calls) ≈ 17s; enrich call (4 passages) ≈ 5s.
- Cost table: blind re-extract 36 calls ≈ 210s (missed Tarkin 3×); uncapped
  loop ≤246 calls ≈ 20+ min (never viable); cap-A top-5 × 4 passages = 5 calls
  ≈ 30s (blind to evidence rank — Tarkin has 2 mentions, might not rank);
  tight gate ≤5 entities × 1 call ≈ 25–30s (+~12–15%), evidence-directed by
  construction.

## Emission vs coverage (the distinction this settles)

- "His aide, Bor Gracus" sat inside already-mined chunks across three
  extracts; the model never emitted it. Pinned single-window re-read banked it
  accepted with the exact quote on the first try. Verdict: emission failure,
  not coverage — narrowing scope fixed what broad windows missed.
- Dropped-quote flavor (emitted but unverifiable, 59 dropped this bank) leaves
  no trace by design; the pinned test banked with a verifying quote, so this
  instance was never-emitted, not dropped-quote. The two flavors want
  different fixes; only the first is wired here.

## Honest limits

- Recall variance dominates: the same 20 asks bank different ties run to run
  (unresolved 0–10). The loop raises emission chances; it cannot make the
  model deterministic.
- Tight-gate junk hits burn bounded calls and return nothing — priced in, not
  eliminated.
- No test run, no typecheck: syntax reviewed by eye only. The Tarkin-window
  regression test for the loop is still to be written and run.
