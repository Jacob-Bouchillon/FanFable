# Extraction recovery and cross-window alias continuity report

**Date:** 2026-11-04
**Branch:** `experiment/evidence-scan`
**Scope:** tracked FanFable extraction-recovery work in the current checkout, plus a synthetic cross-window alias continuity fix.
**Data boundary:** synthetic passages and disposable databases only; no real story/canon content was processed or published.

## Executive summary

This checkout contains extraction-recovery hardening and tests, plus a targeted fix for a demonstrated cross-window relationship failure. In the failing two-window test, an earlier window identified “Fox” as Etta Vale’s alias, but the later relation prompt listed only “Etta Vale.” The relationship resolver had staged alias information available, yet the model was not shown that alias while deciding the relation.

Relationship prompts now show known aliases beside the canonical entity name and explicitly say that aliases are alternate names for the same entity—not separate relationship endpoints. A deterministic synthetic two-window regression test checks that a later prompt contains the verified alias, that the trust relation is staged, and that stage-only extraction leaves canon rows and mined-chunk flags untouched.

The local-model cross-window run after the alias-display change produced the intended “Niko trusts Fox” claim in the later window. The first pass remained partial because an earlier relation snapshot became stale after the second window added an entity. Reprocessing that stale relation work completed the staging run with zero stale relation windows. The model also proposed a spurious tie between Etta and her own alias; the prompt has since been strengthened to explicitly prohibit treating an alias as a separate endpoint. That final wording has passed the automated suite, but has **not** yet been rerun against the local model. Therefore, cross-window alias presentation is fixed and covered; model-level precision against self-alias false ties remains to be confirmed.

All extraction output remained stage-only. The synthetic model run recorded zero canon entities, zero canon relations, and zero chunks marked mined. Staged output is not published and is not evidence of canon accuracy.

## Work included in the checkout

### Extraction recovery, staging, and safe operation

The tracked working-tree changes extend the existing extraction recovery implementation with bounded stage-only concurrency protection, safer reporting of server job errors, and additional recovery/fragment regression coverage. In particular:

- A process-local stage-only guard rejects a second overlapping extraction for the same project using the same `Db` object before the provider call. It releases after completion or failure. It does **not** serialize separate processes or separate `Db` connections to the same file; the operational rule remains one extraction process per project at a time.
- A known-safe busy rejection can be returned to the UI as a fixed message, while raw extraction errors remain server-side.
- Recovery tests cover interrupted/restarted stage work, sealed-batch reuse, idempotent contribution identity, roster invalidation, stage-only boundaries, and UTF-16 fragment offsets.
- The existing staged-extraction report was updated with these limitations and verification details.

The guard is deliberately process-local; it is not a durable database lock. Recovery and synthetic tests do not establish safety for overlapping multi-process extraction.

### Alias-aware relationship prompts

- `formatKnownEntities` can render canonical names with verified aliases from either array-valued entity records or the serialized alias fields used by recovery snapshots.
- Both standard and recovery relation prompts pass their entity records into that formatter.
- The prompt states that a parenthetical alias is the same entity and directs the model to use the canonical entity name for relation endpoints.
- A synthetic two-window regression test stages Etta Vale with alias “Fox,” then tests a later Niko Renn trust claim mentioning “Fox.” It asserts the later relation prompt contains the alias guidance and that no canon rows or mined flags are created.
- Prompt-byte tests were updated to pin both the new wording and alias rendering.

This makes alias evidence available to the model; it does not guarantee that every model will obey the instruction or that every extracted relationship is correct.

## Synthetic inference evidence

All local inference used the already-installed `spark-x2-q8:latest` through local Ollama, with JSON-constrained requests, sequential windows, and a disposable database. No model was downloaded.

| Check | Observed result | What it establishes / does not establish |
|---|---|---|
| Unconstrained single-window output | Malformed JSON was rejected; relation extraction did not proceed. | Parseability is a prerequisite; this did not measure relationship quality. |
| JSON-constrained single-window passage | Two positive ties were staged and one acquaintance claim was denied; static relationship statements were also classified as timeline entries. | JSON mode enables the pipeline to proceed, but does not ensure all extraction categories are accurate. No canon writes occurred. |
| JSON-constrained two-window passage before alias-aware prompt | Later “Fox” was treated as a separate character and a spurious relation was staged; relationship coverage was stale. | Confirmed the original cross-window failure. |
| Two-window run after aliases were shown in the prompt | The later relation output included Niko trusting “Fox.” The initial run had one stale relation window; a subsequent run revalidated it and completed with zero stale relation windows. The model also proposed a spurious self-alias tie. | Shows that exposing the alias allowed the intended relation to be expressed. It also shows that prompt alias semantics need validation; the final strengthened wording has not yet been live-model tested. |

For all listed local-model runs, the database remained isolated and stage-only: zero canon entity rows, zero canon relation rows, and zero mined chunks. The cross-window model response is experimental evidence, not a quality guarantee.

## Verification

- `TMPDIR=/dev/shm npm test` — **1,394 passed, 0 failed** after the final prompt wording and regression tests.
- Focused alias regression — **1 passed, 0 failed**.
- `git diff --check` — clean.
- No staged changes or database files were present in the tracked diff at the time of report preparation.
- The test suite uses synthetic databases and mock providers except for the explicitly described manual local-model experiments. It does not establish accuracy on real story text, production behavior across multiple processes, or a publication workflow.

## Files and repository boundaries

The current tracked changes cover:

- `docs/REPORT-2026-11-03-staged-extraction-recovery.md`
- `fanfable/src/extract/extract-prompts.ts`
- `fanfable/src/lorebook.ts`
- `fanfable/src/product/server.ts`
- `testing/tests/extract-prompts.test.ts`
- `testing/tests/extraction-recovery.test.ts`
- `testing/tests/server.test.ts`

Untracked trial-data paths under `testing/trials/coref-probe/data/` and `testing/trials/valve-bench/` are excluded. No database file is included in the commit.

## Remaining work

1. Rerun the two-window synthetic local-model check with the **final** prompt wording and tracing enabled.
2. Confirm the correct cross-window trust tie remains, while the Etta-to-“Fox” self-alias tie is absent or rejected.
3. Add a negative control for a genuinely separate character who shares an alias-like surface, to check that alias handling does not merge distinct entities.
4. Keep any eventual real-excerpt validation in a disposable database and stage-only until the synthetic accuracy checks pass and a separate publication/review policy exists.

The implementation remains experimental; the report does not claim that real story/canon validation or publication occurred.
