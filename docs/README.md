# FanFable docs — the whole picture

**The bet:** a book becomes a *bank of proven claims*, and stories are written from the bank, not the raw text. Three rules shape everything: canon is evidence (no verbatim quote, no bank); the model proposes but the system decides (no model sets a status); answers show provenance (*confirmed by you* vs *the model, 0.78*).

**Where it stood (2026-10-29, branch `experiment/evidence-scan`):** the bank holds 164 relations on the trial book; the judge scores 0.83 precision / 0.68 recall on 42 blind-labelled rows. Two systematic defects remain: alias pairs judged as two people (Plagueis/"The Muun", Palpatine/Sidious) and family titles refused as evidence ("Aunt Petunia" — six of six establishment misses). The numbers in this paragraph are the 2026-10-29 measurement and are not rewritten.

**Current snapshot (2026-11-04):** staged extraction recovery and cross-window alias continuity are implemented and covered by the offline suite; `npm run typecheck` and `npm test` pass (1,394 tests at the last full run). The 2026-11-04 report records what that does and does not establish; the judge identity/title defects above remain open measurements, not solved by the alias prompt change.

**What's next:** one prompt variant fixing identity + titles, measured on the same 42 rows; then majority-of-three stability; then apply the winner to candidate pairs. Longer track: recall (classifier E0–E4), bank re-measurement at threshold, canon-aware planner, second book.

**The trap that cost three hours:** `gpt-oss:20b` spends the output budget thinking and returns empty with `done_reason: length`. `think: false` is silently ignored by this Ollama build; `think: "low"` works. Always smoke-test one window before any full run, and `ps` after killing a run — orphaned processes compete for the GPU.

| file | answers |
|---|---|
| `HOW-IT-WORKS.md` | the standing design: guard, kinds, names, confidence, sweep, packets, and the rules future work must obey |
| `WHATS-NEXT.md` | ranked next steps, the classifier track, the broader roadmap, commands, and the traps |
| `RESEARCH.md` | the complete research record: methods, measurements, intake, judgments |
| `BENCHMARK.md` | the locked 20-pair probe that grades future extractors — read before changing extraction |
| `REQUIREMENTS.md` | what FanFable needs to run |
| `REPORT-2026-11-01.md` | the 2026-11-01 full working report, including failures |
| `REPORT-2026-11-02.md` | why the HP pilot banked almost nothing (counts only) |
| `REPORT-2026-11-03-relationship-extraction.md` | relationship-extraction investigation and the unfinished-work boundary |
| `REPORT-2026-11-03-staged-extraction-recovery.md` | staging-only recovery implementation, verification, and remaining safety limits |
| `REPORT-2026-11-04-extraction-and-alias-continuity.md` | cross-window alias continuity fix, synthetic evidence, and open validation |

**Specs vs reports, explained once:** the old folders are gone. A *design* section is a contract for code; a *measurement* next to it is the dated evidence for why. Measurements are never rewritten — a new number gets a dated note. Deleted drafts and session logs live on in git history, not in folders.
