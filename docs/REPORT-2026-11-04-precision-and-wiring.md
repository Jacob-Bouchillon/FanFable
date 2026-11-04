# Precision and wiring report — 2026-11-04

**Branch:** `experiment/evidence-scan`
**Base commit:** `54db56a` (Improve extraction recovery and alias continuity)
**Status:** implementation record and handoff; not a production-readiness declaration.
**Data boundary:** synthetic databases and disposable copies only, except read-only sampling of local trial banks (`hp3`, `plagueis-half`). No live-bank writes. No valuable canon data processed.
**Counts only.** No passage prose, no per-row verdicts, no rating values.

## Executive summary

Ten phases landed on one tree, verified green at the end: `npm run typecheck` exit 0, `npm test` **1,467/1,467 pass, 0 fail**, `git diff --check` clean. Promotion-path corruption (inverted/denied/third-party ties banked as proven), guard bypasses, roster denominator defects, keeper-predicate disagreement, unsafe recovery/sweep paths, product-memory corruption, temporal misordering, and six unwired-but-complete subsystems were each closed or wired in dependency order. Two blind automated judges (dissimilar families) converge: pre-fix user-confirmed rows lack sentence-proof in their citations (Spark 2/34, NuExtract3 5/34, agreement 31/34). That measures proof coverage of old rows, not tie truth, and must not become a demotion list. The valid 70% denominator — rows the new rules alone admit — does not exist yet; building it is the queued evidence-regather work.

## Objective and acceptance

Keeper-grade ties (`accepted` + `user_confirmed` only) at blind precision >= 0.70 with lower Wilson bound >= 0.60, integrity exit 0, zero gate violations on surfaced answers, no regressions on the 42-row judge floor. **Acceptance not met on any measured denominator** (see §Measurement). Per standing law the output is therefore further work, never a threshold change, a demotion of user-confirmed rows, or a relaxed proof rule.

## Phases

| # | Scope | Files | Tests | Verdict |
|---|---|---|---|---|
| 2 | Stop false banking: direction ownership + passive inversion (B1), drop bare-family-term disjunct (B2), family-anchored denials (B3), claim-scoped guard + all-spans + per-quote Lore exemption (A1), gate-local proof normaliser (B6), confidence defaults 0 (B10) | `gates/gates.ts`, `answer/lore-ask.ts`, `identity/relation-proof.ts` | `keeper-precision-gates.test.ts` (17) | PASS with limitations (scan parks on missing confidence by design; B2 title breadth to watch) |
| 0 | Measurement lock: keeper predicate pinned, relId on every row, sheet carries id/pair/sentence only, PENDING until verdicts, Wilson 95% pinned | `trials/claim-confidence/measure-precision.ts`, `tests/measure-precision.test.ts` (8) | 8/8 | PASS |
| 1 | Roster Stage A: one shared `TITLE_TOKENS` in `identity/names.ts`, bare titles resolve to nobody, resolver/merge agreement, curly folding, surname separation, check idempotence | `identity/{names,identity,identity-check,roster-rules}.ts` | `roster-stage-a.test.ts` (7) | PASS (`lorebook.ts NAME_TITLE_WORDS` left as known drift) |
| 3a | Event upsert dedup (A11), modality clauses removed + hashes re-pinned (D4), one keeper predicate in sweep/brief/lookup/retrieval (A5/D3/A8) | `answer/lore.ts`, `extract/{extract-prompts,sweep}.ts`, `plan/brief.ts`, `answer/retrieval.ts`, `lorebook.ts` | `canon-event-dedup.test.ts`, sweep matrix, brief test | PASS |
| 4 | Safe runs: sweep any-status duplicate + transaction + ruling (D2/D5), lease-before-reopen + mined clear (D1), fenced deferStage (D8), full-table migration recovery + version docs (B8/B11) | `extract/{sweep,recovery}.ts`, `core/{migrations,db}.ts` | sweep/recovery/migrations suites | PASS (one transient `database is locked` in pre-existing concurrent test; isolated + final full runs green) |
| C | Product truth: edits draft + clear extraction (C1), deletes clear + close conflicts (C2), canon-change loop un-nested (C3), knownBy alias (C4), closed-filter + story-order current (C6) | `plan/controller.ts`, `product/{server,memory}.ts`, `cli.ts` | memory/workflow/server suites | PASS |
| W1 | Temporal: canon skips story filtering, edge event IDs resolved to story order at load, unresolvable fail closed | `support/graph.ts` | `graph-temporal.test.ts` (5) | PASS |
| W2 | Evidence packet flag in planner (default off = byte-identical), validate-or-fallback, gaps as uncertainty | `plan/controller.ts` | `evidence-packet-wiring.test.ts` (5) | PASS |
| W3 | First production writer (`assignAttestedTiers` keeper promotion) through `transitionClaim` with proof + ruling; 10 grandfathers remain | `lorebook.ts`, architecture test | adoption/refusal tests | PASS |
| W4 | Starved windows from extraction's `source_id,seq` order; opt-out exact | `web/note-ingest.ts`, `lorebook.ts` (export) | `starved-multisource.test.ts` (2) | PASS |
| J1 | Spark judge of 34-row sheet, majority-of-three | `trials/claim-confidence/precision-judge.ts` (trial-only) | output-only | PASS with limitations (zero discrimination: 34/34 unanimous, 2 stock reasons) |
| J2 | Second judge (smollm3 unusable 32/34 failed → NuExtract3 fallback) + agreement script | `precision-agreement.ts` (trial-only) | output-only | PASS |

Pre-existing uncommitted work preserved untouched in intent: `.opencode/` agent/command rewrites, `cli.ts` serve-project precedence + help dedup, `core/db.ts` + `core/llm.ts` hardening, `product/server.ts` hardening, `answer/lore.ts` import cleanup, `docs/README.md` + `docs/WHATS-NEXT.md` (plus a 2-line command addition for the sampler). Untracked trial-data paths `testing/trials/coref-probe/data/` and `testing/trials/valve-bench/` excluded from this commit, as before.

## Measurement (all counts-only, disposable copies)

- `hp3` (`ab`, 1 accepted + 23 user_confirmed): 24/24 sampled with relId, PENDING, integrity exit **1** (20 unverified keepers: 3 quote-not-verbatim + 17 no-ref). Disqualified as a precision denominator: quoteless rows cannot support sentence-proof verdicts.
- `plagueis-half` (`halfbook`, 34 user_confirmed, 0 accepted): 34/34 sampled, PENDING, integrity exit **0**. Valid denominator, judged.
- Spark (`spark-x2-q8`, temp 0, think:false, native chat, seeds 42/43/44): **2/34, precision 0.058824, Wilson 0.016283–0.190936.** 34/34 unanimous 3-0, 2 unique reasons, 0 failed calls.
- NuExtract3 (`nuextract3-q8` fallback): **5/34, precision 0.147059, Wilson 0.064494–0.301281.** Agreement with Spark 31/34 (29 jointly rejected, 2 jointly supported, 3 NuExtract-only, 0 Spark-only), both judges 34/34 unanimous with 2 reasons each.
- Rescore of both verdict files reproduces both lines exactly.

Interpretation limits (binding): single-run judges with zero rationale discrimination; labels answer truth while the judges answer proof (same circularity struck in the assessor bench); all 34 rows are pre-fix user-confirmed rows the new gates never touched, banked on word alone by design. The result is replicated proof-coverage evidence (upper bound 0.30 < 0.70), not a truth measurement and not a demotion list.

## Verification

- `npm run typecheck` → exit 0 (final full-tree run).
- `TMPDIR=/tmp/opencode npm test` → 1,467/1,467 pass, 0 fail (~14 s).
- `git diff --check` → clean.
- Targeted re-runs during review: keeper-precision 17/17, scan+promote 23/23, measure-precision 8/8, roster 7/7, sweep+recovery+migrations 116/116, memory+workflow 28/28, graph-temporal 5/5, evidence-wiring 5/5, starved 2/2, affected prompt/sweep/brief/dedup suites 27/27.
- Model runs used only cached local models (`spark-x2-q8`, `nuextract3-q8`) with concurrency 1; no pulls, no extraction on valuable data, no bank writes outside `/tmp` copies.

## Remaining work

1. Evidence regather Stages B+C on disposable copies (whole-text alias search per relation, attach stating passage or park to `needs_review`) — builds the only valid 70% denominator: rows the new rules alone admit.
2. Re-judge newly admitted rows with two dissimilar judges + the locked harness; human spot-checks stay out of the verdict loop by operator order.
3. Remaining grandfathers (10) through `transitionClaim` one writer at a time; combine/veto/map wire-or-remove verdicts once their inputs exist; small polish (premise lint, masking, continuity filter, Unicode sweep names, fifth title list).
4. Push cadence and second-book decisions per PIPELINE-PLAN §7.

## Rollback

Pre-commit HEAD `54db56a0fbcebeb988a5d011411707bf0e5d8d57`. All changes are in the single commit on `experiment/evidence-scan`; revert it to restore. No migrations ran against real banks; no production data was written at any point.
