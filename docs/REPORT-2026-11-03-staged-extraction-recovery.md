# Staging-only extraction recovery — implementation report

**Date:** 2026-11-03
**Branch:** `experiment/evidence-scan`
**Implementation commit:** `454764370c4e05cb9135f46f05674c2d19a38d7e`
**Status:** experimental; staged results are not published to canon or writing.

## Executive summary

This change adds a durable SQLite recovery controller for relationship extraction and a bounded-fragment path for long passages. It is designed to prevent truncated or interrupted model responses from being reported as completed extraction, and to keep new results in a staging ledger instead of making them usable as canon.

The standard CLI and server extraction paths explicitly request stage-only operation. They do not write extracted claims to canon, mark passages mined, create legacy extraction-run provenance, ingest notes, or generate embeddings. There is no publication workflow, and retrieval and the writer do not consume the staged claims.

The current working-tree implementation has passed the offline test suite as reported below. That establishes synthetic code-path behavior, not relationship accuracy, live-model compatibility, or production-data safety. Do not use this as a publication-ready pipeline or run it against valuable project data without a separate backup and review.

## What changed

### Recovery and replay

- Added `fanfable/src/extract/recovery.ts` and SQLite migrations 31–32 for generation-scoped work, attempts, leases, fencing, staged batches, coverage, and contribution identities.
- Work identity incorporates the source/config generation and the relevant chunk or fragment boundaries. A source or configuration change fails closed rather than reusing incompatible completed work.
- Recovery uses bounded attempts, visible deferral, explicit retry, and replay of sealed results. Exact repeated contributions are idempotent; distinct claims are kept distinct.
- A parent is reported partial when relation coverage is stale against the final staged roster. The next run can revalidate stale work without deleting sealed attempts or contributions.
- Older experimental staged rows with the earlier unprefixed identity are retained but not automatically migrated or reused; they require manual review.

### Long-passage coverage

- In stage-only `extractLore`, chunks longer than 1,400 JavaScript string characters are represented as recovery fragments. Each request contains at most 1,400 source characters, fragments overlap by 256 characters, and the planner covers the entire canonical chunk text, including its final character.
- Evidence metadata stores `chunk_start` and `chunk_end` as half-open UTF-16 offsets into the canonical chunk text. These are **not** offsets into the raw imported file. Invalid offsets and ambiguous repeated evidence fail closed rather than being guessed.
- Fragment budgets can leave a chunk partial. CLI, server results, and UI distinguish complete, partial, and no-coverage states; partial or empty coverage is not described as successful extraction.
- Same-generation bounded work can resume. Relationship results made stale by later staged entities are marked partial and selected for revalidation on a later run.

### User-facing and safety boundaries

- Real providers use recovery/staging by default; CLI and server requests explicitly enforce stage-only behavior even when the mock provider is selected.
- Stage-only extraction has a process-local guard keyed by the same **`Db` object instance + project ID**. A second overlapping stage-only request on that key is rejected with a clear busy error before any provider call or write; a different project is unaffected, and the guard releases on success or failure. A second `Db` connection to the same file, another process, and legacy/recovery-disabled extraction bypass this process-local stage-only guard. The guard is intentionally process-local, not a durable lock; **operationally run only one extraction process per project at a time**.
- `lore extract --trace` now fails fast in stage-only mode instead of silently suppressing tracing. `--legacy --trace` is the trace-capable path and writes through the legacy canon path; the CLI help warns to use it only on a disposable database.
- Browser job responses remove raw extraction diagnostic details and replace terminal error text with a generic message. The known extraction progress callback also uses a fixed safe message rather than an exception string.
- The recovery API and CLI expose coverage, failure, retry, and stale-relation counts. No model output or passage text is added to browser-facing failure notices.

## Verification

The post-push full suite was run against the pushed code and report commits, with temporary databases under `/dev/shm` and a watchdog that stopped the run if free space fell below 4 GiB. No cleanup was performed.

| Check | Result |
|---|---|
| `npm test` | **1,383 passed, 0 failed** after push; independently rerun on the pushed state |
| `npm run typecheck` | Passed after push |
| `node --check fanfable/src/ui/app.js` | Passed after push |
| `git diff --check` | Clean after push |
| Focused extraction-recovery + extraction-trace tests | 102/102 passed in the final CLI/test correction run |

Before the last CLI/test correction, I independently ran the suite on the preceding code state: 1,382/1,382 passed. After the two commits were pushed, I reran the suite and independently observed 1,383/1,383 passing, exit 0, in 9.8 seconds; `/dev/shm` ended with 5.6 GiB free, above the 4 GiB reserve. The suite uses synthetic databases and mock providers. It does not establish model extraction quality, exercise a live browser, or test a real canon database.

### Current working-tree follow-up verification

The **1,383** result above is the historical pushed-code result. It does not include the later uncommitted guard, subprocess crash/restart, or supplementary-plane offset tests. The current working tree is based on pushed HEAD `5a0e4e7`; those follow-up changes remain uncommitted.

The working-tree guard changes were independently verified at **1,392/1,392** before the supplementary-plane offset test was added. **That 1,392 count does not include the new offset test.** After adding the subprocess crash/restart regression and the supplementary-plane offset regression, the final working-tree run passed **1,393/1,393**; the focused `testing/tests/extraction-recovery.test.ts` file passed **91/91**. `npm run typecheck`, `node --check fanfable/src/ui/app.js`, `git diff --check`, and `git diff --cached --check` passed. The full-suite log is `npm-test-final-gate-verified.log` (ignored by Git via `*.log`).

- **Subprocess crash/restart:** child 1 exited with code 73 after sealing entities/facts and before relation coverage. Child 2 resumed the same child ID and work key, did not re-call entities-facts, completed relation/timeline, and preserved the staged contribution UIDs, payload hashes, dispositions, and entities-facts batch unchanged. No canon, mined flags, or legacy extraction-run rows were written; only expired child leases were advanced.
- **Supplementary-plane offsets:** with `😀` before evidence in the second fragment, the persisted `chunk_start`/`chunk_end` were `1423`/`1454`, exactly the canonical chunk's JavaScript UTF-16 indices, and the half-open slice equals the evidence. The fixture's aggregate fragment status is partial under the existing stale-relation rule, so the test asserts fragment completion and offsets rather than aggregate completion.

## Known limitations and operational constraints

1. **Concurrent extraction is only guarded inside one process, for the same `Db` object instance + project ID.** The final audit refreshes compatible children, and the process-local guard rejects a second overlapping stage-only request on that key. A second `Db` connection to the same file, another process, and legacy/recovery-disabled extraction bypass this guard. Work that arrives after the final audit can still race it. The guard is intentionally process-local; no durable lock is implemented. Operationally run only one extraction process per project at a time.
2. **Not every entry point fragments long chunks.** The standard stage-only `extractLore` path does. Explicit `--legacy` remains window/prefix-based, and direct `ensureWindowsForChunks` remains window-based (although its stage-only stale-roster status is checked). The legacy route can write to canon; avoid it on valuable databases.
3. **Overlap is bounded.** The 256-character overlap preserves boundary-spanning evidence only when the full evidence span fits within the overlap. It cannot guarantee finding arbitrary-length cross-boundary relationships.
4. **Characters are not tokens.** The 1,400-character request limit is a bounded-input heuristic, not a guarantee that every model provider stays within its token budget.
5. **Offsets are canonical-chunk-relative and UTF-16 based.** Supplementary-plane characters occupy two UTF-16 code units, so these are not Unicode code-point indices. Import normalization also means the values do not map directly to raw-file byte or character offsets.
6. **No publication or accuracy result exists.** Staged claims are intentionally unavailable to retrieval and writing. There is no safe publication/review path in this implementation, and relationship accuracy was not measured here.
7. **Historical data is preserved, not repaired.** Incompatible experimental staged rows remain in the database and need an explicit manual policy before any later publication work.
8. **Verification is not a browser or live-model test.** UI code was syntax-checked and source-asserted, not run in a browser. No live model calls or valuable data were used.

## Repository and recovery notes

- The code commit is `454764370c4e05cb9135f46f05674c2d19a38d7e`; the report is a separate documentation change.
- Two pre-existing untracked trial-data paths, `testing/trials/coref-probe/data/` and `testing/trials/valve-bench/`, were intentionally excluded from the commit and left untouched.
- Temporary test databases and backup copies under `/dev/shm` were not deleted. `/dev/shm` is volatile temporary storage; those copies are not archival backups.
- Some earlier implementation turns recorded backup-process deviations. The latest source-index validation change had an exact pre-edit copy; the history of intermediate backups is documented in the Coder handoffs and should not be treated as a single pristine snapshot.

## Recommendation

Keep this branch experimental and run extraction serially on disposable data only. Before using valuable canon, resolve the generation-wide concurrency race, choose an explicit legacy/lazy coverage policy, create a separately reviewed publication path, and run the post-push suite. A passing test suite alone does not establish that extracted relationships are correct.
