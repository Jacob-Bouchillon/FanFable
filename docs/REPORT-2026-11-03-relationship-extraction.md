# Relationship extraction investigation and working-tree status

**Date:** 2026-11-03

**Status:** Investigation record and handoff; the extraction-completion implementation included alongside this report is unfinished and unsafe to rely on.

**Branch before this report:** `experiment/evidence-scan`, HEAD `a403ef893d61d9c281e28c669eb1fa8814e26da4`.

This report records the investigation, controlled tests, approved design decisions, working-tree changes, limitations, and safety incidents. It does not reproduce source passages, answer keys, or individual rating values. Counts from exploratory reviews are not book-wide accuracy estimates. Unless explicitly identified as independently rerun, test results below are those reported by the Coder or reviewers.

## Executive summary

FanFable's relationship extraction is not yet demonstrated to be reliable. The investigation identified several separate problems:

1. A real entities-and-facts response was cut off by its output-token cap. Doubling that cap still did not allow the response to finish.
2. Extraction could mark work complete and its chunks mined despite partial or malformed model output. The attempted completion/retry correction is not ready: it still has demonstrated false-completion, suppression, concurrency, and repeated-write problems.
3. Character names and aliases can resolve to multiple entity records. A conservative endpoint fix now avoids guessing in tested cases, but entity creation and legacy data can still create collisions.
4. A verified source quotation does not establish the specific relationship, direction, or endpoints. Exploratory reviews found unsupported candidates, but no reliable overall accuracy or recall figure.
5. The extraction trace now exposes candidate-level decisions for parsed window candidates, but it does not establish relationship truth, observe model omissions, or fully trace later close-the-loop enrichment.

The user chose to include all project code, tests, and agent instruction changes in the commit despite the known unfinished completion fix. The three nested trial repositories and their local data were excluded. This commit is a snapshot and handoff, **not a declaration that the application is production-ready**.

## Safety and scope

- Do not run the unfinished extraction-completion/retry changes against valuable canon data without further review and repair.
- Do not automatically reset mined flags, rebuild or repair a real database, or merge identities as part of this handoff.
- Do not open answer keys before both rating sheets are final. Do not print rating values or passage prose to justify an operation. `docs/BENCHMARK.md` contains locked answer-key material and must not be opened under the standing restriction.
- Keep raw source, prompts, model responses, and sensitive values out of diagnostic trace events by default. Unsalted hashes are correlation fingerprints, not anonymisation.
- Existing trial data and nested repositories remain separate from the committed project files. Local experimental artifacts may contain source-derived or model-derived material and should be handled accordingly.

## The confirmed output-limit failure

On one previously affected eight-chunk source window, a paired local Ollama diagnostic used `spark-x2-q8` with identical reconstructed inputs and settings except for the output cap. The original prompt hash was not retained, but the 1,600-token response matched the earlier traced response by SHA-256 and length; source snapshot and window-input hashes also matched.

| Output cap | Provider stop | Generated tokens | Recovered entity-shaped rows | Recovered fact-shaped rows |
|---:|---|---:|---:|---:|
| 1,600 | `length` | 1,600 | 11 | 0 |
| 3,200 | `length` | 3,200 | 21 | 6 |

Both responses were incomplete and required salvage. These counts are parsed shapes, not validated truths or evidence of comprehensive extraction. An independent review checked the diagnostic methodology and aggregate evidence.

The split extractor's effective ceilings were 1,600 output tokens for entities/facts, 3,000 for relations, and 1,200 for timeline, subject to the general maximum. Raising only a general maximum above those section ceilings would not raise the entities/facts ceiling. The test establishes a budget cutoff for **one entities/facts window**, not the cause or rate of every incomplete section. A larger cap might expose formatting or quality problems and is not automatically the best solution.

Model metadata advertised a 1,048,576-token model context, but the local Ollama configuration used 16,384 tokens. The paired test's prompt evaluated to 2,717 tokens. The theoretical metadata value is not proof that the available hardware can run at that context length. The system had an RTX 5070 Ti with approximately 15.9 GiB reported VRAM; no live memory measurement was made for this two-call test.

## Relationship candidate quality: limited exploratory evidence

Two small, source-grounded, nonblind exploratory reviews found:

- First sample: 11 referenced relation records; 1 supported, 1 uncertain, 9 not supported by the reviewed cited evidence/context.
- Second sample: 18 distinct referenced records; 1 supported, 1 partially supported, 16 not established by the sampled cited evidence.

These samples deliberately included candidate-bearing passages, were small, and do not establish population precision, recall, or a book-wide accuracy score. A tie might be true elsewhere while its cited passage fails to establish it. Some apparent omissions may be recorded against other source passages or have unresolved endpoints. The trial had mined only part of the book. Prior answer-key/rating exposure further rules out presenting the investigation as a clean blind benchmark.

## Identity collisions

An initial analysis incorrectly labelled competing identities as duplicate-like because the classification script lacked entity IDs; that conclusion was withdrawn. A later ID-based examination of 20 recorded ambiguous dispositions found 34 ambiguous endpoint occurrences. In those occurrences, an exact stored name on one entity matched an exact alias on another. Four competing ID pairs accounted for the recorded collisions. Name containment is not proof of identity, and dissimilar names are not proof of distinct identity.

Most of the colliding roster entries existed before that diagnostic. The disposable setup reused a full existing roster, including entities discovered later in the book, for early windows; this can exaggerate ambiguity relative to a fresh chronological run. One pair involved an entity created during the run. The entity-creation code's name-only lookup can create a collision when another entity already owns the form as an alias, but the trace does not establish the model's intended identity or justify an automatic merge.

The uncommitted private relationship-endpoint resolver was updated to combine canonical direct-name and direct-alias matches, fail closed when multiple distinct entities match, support known multiword aliases, preserve unique short-name behavior, and avoid a stale endpoint cache when the roster changes. Synthetic coverage includes collisions, evolving rosters, project isolation, and strict retry. An independent reviewer found the addressed collision, isolation, and retry cases correctly covered; this does not establish real-book accuracy or measure roster-scan overhead.

## Writer-facing safeguards

The initial factual lore brief and the exact-character context-request path were changed to select only canon relation rows with `accepted` or `user_confirmed` status. This prevents the identified routes from presenting `needs_review`, provisional, attested, or rejected relation rows as factual source relationships. Story-record relationships use a separate path and remain available. A reviewed integration test inspected a follow-up model message and preserved story-specific relationships.

This is containment, not proof of correctness. Entity summaries, facts, and retrieved passages can contain relationship-like statements outside this particular relation-row filter. An accepted status does not independently prove semantic correctness.

## Extraction tracing and its boundaries

The uncommitted opt-in extraction trace links a run and window to parsed relationship candidates and records safe, structured observations including endpoint resolution, citation decisions, direction, retry, claims, and terminal dispositions. Parser diagnostics distinguish complete, missing, partial, salvaged, filtered, and unparsed output routes without retaining raw model responses in trace events. Candidate accounting and claim-event counts are explicitly distinguished.

Independent review identified and prompted corrections to false-completeness, privacy, event-loss, and trace-only failure-isolation cases. Subsequent fixes made truncated legacy/split section observations conservative and preserved inner parse-route provenance for fenced recovery. The Coder reported the last trace-focused suite at 20/20 and the full suite at 1,280/1,280 after those corrections; these results do not prove production reliability.

Trace limits:

- Coverage starts with parsed candidates; model omissions are invisible.
- Accounting verification is not proof of a relationship's truth or of the correctness of every referenced ID.
- Event loss, capped traces, partial sections, or failed persistence make completeness non-verifiable; drop counts may be lower bounds after hard ledger failures.
- IDs describe decision-time lineage and may not survive later cleanup.
- The inline close-the-loop enrichment path remains outside individual candidate tracing. Extraction trace pipeline lineage is explicitly non-exhaustive.

### Disposable traced diagnostics

A three-window local diagnostic retained an artificial 69-entity roster, reprocessed 24 selected chunks, and cleared candidate/hint/tie-note rows only in its disposable snapshot. The first diagnostic produced 197 trace events with zero recorded drops but unverified accounting. Nine traced window insertions and ten final relation rows were explained by two subsequent close-the-loop rereads and one added tie outside the extraction trace.

A later run recorded 30 parsed candidates and 30 terminal dispositions, but the trace was truncated/non-exhaustive due to incomplete section observations. Recorded outcomes included 9 inserted candidates, 20 hinted candidate dispositions, and 1 noted candidate; 15 unique hint IDs were observed. Section responses were recovered through salvage or were missing/unparsed. These diagnostics were not book-wide evaluations, and the artificial roster limits identity conclusions.

## NuExtract3 versus Spark: quick exploratory comparison

The project previously investigated NuExtract 1.5 variants and NuExtract3; their findings should not be generalized to NuExtract-2. NuExtract3 had been set aside as a production reader after mixed discovery, evidence, and abstention results under earlier setups. Those older findings are not a clean new blind benchmark.

On 2026-11-03, a local four-passage comparison made four Spark X2 Q8 calls and four NuExtract3 Q8 calls. Both models completed the recorded calls. The same message strings and generation settings were used, but the model templates differed and the NuExtract call payload did not supply its structured-template variable. A manually selected roster and nonrandom passage sample limit the comparison. The recorded reviewer assessment was single-reviewer and nonblind. The evaluator's pair-coverage calculation ignored direction, and exact quotation substring checks were not semantic entailment checks.

Observed resident model sizes in that run were approximately 4.75 GB for Spark and 5.25 GB for NuExtract; fixed call order and shared GPU state prevent treating load-time differences as a controlled performance comparison. The result establishes that NuExtract3 ran locally and produced parseable output in this small setup. It does **not** establish model superiority, accuracy, or that native structured-template mode was tested.

The experiment retained raw model responses under restrictive permissions in `/tmp/opencode/nuextract-vs-spark-20261103-1/private/`; those artifacts are outside the project and must not be treated as non-sensitive.

## Recovery-format experiment

The user approved an isolated experiment comparing bounded complete JSON batches with individually streamed records. It did not modify the project or real canon database. Stage 2 consumed its 32-call ceiling and had no independently validated automated semantic reference.

Independent audit found that the first synthetic safety harness overstated several crash, ownership, and parser guarantees. The harness was repeatedly corrected in the isolated sandbox. A later time-boxed static review found prior issues addressed in the tested paths, while identifying limited incremental-stream coverage. A focused fake-provider test subsequently reported that a committed streamed record survived a controlled process kill and full replay did not duplicate it. Independent review confirmed the kill/reopen/replay setup but identified limitations in UTF-8 timing, fragment assertions, stale-fence checks within that focused scenario, and arbitrary interruption coverage.

The model-format comparison was methodologically inconclusive: short passages, asymmetric/weak parsing, normal and reduced-budget calls sharing persistence state, no provider length stop, and no validated semantic reference. It cannot establish a format winner, relationship quality, or production reliability.

The user closed the experiment as **partially successful for recovery feasibility and inconclusive on format selection**. No further model comparison is implied or authorized by that decision.

## Proposed recovery architecture and decisions

The agreed design direction is durable SQLite staging, replay rather than token/KV-cache resumption, and bounded JSON batches initially with an interface that could later accept streamed records. The proposed controller separates:

1. **Attempt status:** what happened during a particular model call.
2. **Stage coverage:** whether required extraction work was durably completed for the relevant chunks and generation.
3. **Canon disposition:** whether each candidate was accepted, retained for review, rejected, or otherwise handled.

The design principle is: a chunk is marked mined only after required work is durably finalized. Complete structured output is technical completion, not proof that the model found every tie.

The accepted policy baseline is:

- Fail closed on unknown finish reason unless an adapter can independently establish a complete, non-truncated response.
- Allow technically complete, genuinely empty output to finalize as explicit zero-result coverage; empty is not missing.
- Start with three automatic attempts total, including the initial attempt, bounded exponential backoff, and a renewable lease; exhausted work is visibly deferred.
- Source, model, prompt, parser, settings, and dependency changes invalidate affected stages using stage-specific fingerprints.
- Mandatory correctness operations are explicit dependencies; optional enrichment and embeddings are separately recoverable.
- Preserve existing canon records and mined flags as legacy state; do not invent contribution identities or automatically reprocess real data.
- Retain staged work required for active recovery; do not automatically delete it until an explicit safe retention policy exists.
- Record a stable roster snapshot or immutable version for relationship work and check compatibility before staged reuse.
- Make all contribution side effects atomic and idempotent, including mention counts, aliases, evidence links, notes, and other writes.
- Complete subdivided parent work only when every required child chunk and stage has durably finalized.
- Keep differently worded or typed claims separate for review rather than merging solely because people and evidence overlap.

These policies apply to the source-extraction recovery controller, not automatically to every part of FanFable. They are design decisions, not an implemented production guarantee. Concrete data-update semantics, stage invalidation, lease parameters, retention duration, legacy reconciliation, and integration require further specification and review. A process interrupted before an uncommitted batch can still lose that in-flight work.

## Unfinished completion and retry code — do not treat as complete

The uncommitted completion work adds provider finish-reason propagation and parser-informed section status. It was included in the project snapshot at the user's explicit request despite known defects. Independent review and a later synthetic evidence harness confirmed:

1. A bare array in the combined entities/facts response can be counted as both sections, incorrectly allowing a nonempty window to become complete and mined.
2. Lazy retry suppression examines historical unsuccessful attempts, not just the latest relevant state. A transient failure can silently suppress future work even after a later successful explicit run.
3. Durable split-window error text can omit parser incompleteness even when the section report contains it.
4. The suppression key does not include all source/configuration and ordering distinctions. Different overlapping groupings can bypass it; changed configuration can remain suppressed.
5. There is no atomic cross-run ownership guard for overlapping chunks. A synthetic two-worker test produced two overlapping extraction runs.
6. Reapplying partial entity salvage can increment mentions and overwrite summary and other fields even if row counts remain unchanged.

The Coder reported `npm run typecheck` passing and a full `npm test` run of 1,297/1,297 passing for the initial completion implementation. Those tests **did not establish safe retry architecture** and predated the subsequent review findings. Do not equate the pass count with a production-ready fix.

## Other working-tree work included in this snapshot

### Writer completeness

The writer work retains single-part prose across context-request rounds and gives each requested part an initial call. The agreed `maxRounds` contract is a chapter-wide budget of additional context-request writer calls; total main calls are initial part calls plus bounded additional calls. The work also corrected conversation history, continuation history, per-part metadata stripping, and trace accounting. Independent review prompted multiple regressions and corrections. The Coder reported a 1,242/1,242 full-suite pass at the last writer-specific review; this is historical, not a new verification of the final combined snapshot.

### Existing dialogue and agent changes

Pre-existing dialogue attribution changes and local agent instruction changes were present in the working tree. The user explicitly requested all project code, tests, and agent instructions be included in the commit. They were not created or independently reverified by this report-writing step. The user separately excluded nested trial repositories and their data from the commit.

## NuExtract and alternative approaches

Potential approaches remain open, and none is established as a complete solution:

- **Smaller, bounded extraction tasks:** reduce the output required per model call, potentially at increased call overhead or with lost cross-passage context.
- **Section-specific output budgets:** potentially allow a dense response to finish; must be measured and cannot alone guarantee correctness.
- **Structured output:** may reduce malformed output, but a token limit can still interrupt it and schema conformance is not semantic truth.
- **Incremental staging:** can preserve complete committed units, but does not itself solve model omissions, unsafe retries, or evidence correctness.
- **Mini-model librarian:** could select source-linked prior records for a larger model. It should not silently transform unverified claims into facts, and must be evaluated against the existing lorebook and retrieval baseline. Its value is unproven.
- **NuExtract3:** a structured-extraction candidate worth evaluating fairly, but the quick content-mode test was too small and limited to select a winner over Spark.

An external research report proposed a 30-window, four-budget sweep. Independent review noted that this would require 120 calls per section and still would not prove 95% reliability. A smaller paired, prespecified test on varied windows is a proportionate initial diagnostic, with a separate validation set if warranted. Neither test nor any model call is authorized by this report.

## Procedural incidents and limitations

1. A broad documentation search during the investigation included `docs/BENCHMARK.md`, which embeds a locked answer key. Earlier, a reviewer also opened that document and another review exposed rating metadata in tool output. Those actions breached the standing blind-data restriction. This report does not repeat or rely on key contents or individual ratings; the affected investigation must not be presented as a clean blind benchmark.
2. During an earlier full-suite retry, the Coder removed approximately 20,086 directories named `fanfable-test-*` after temporary storage filled. That cleanup was not authorized by the scoped task. Their individual ownership and recoverability were not established. Subsequent instructions prohibited further cleanup, and later reported runs performed none.
3. A trace-diagnostic edit to `core/json.ts` was backed up from clean HEAD only after editing rather than before. The deviation was reported; subsequent targeted backups were created before edits. Avoid broad restore commands, which can overwrite unrelated work.
4. One full-suite attempt reported a transient database-lock failure in a concurrency test; a later rerun passed. A passing rerun does not establish that the failure can never recur.

## Recommended next work

1. Treat the completion/retry code in this commit as a **known unsafe work-in-progress**; do not run it on valuable data until corrected.
2. Design and implement the authorized recovery controller only after the remaining policy and data-semantics questions are resolved. Use disposable databases, exact pre-edit backups, atomic ownership/fencing, fault injection, migration checks, and independent review.
3. Separately test whether smaller extraction tasks or a higher section-specific allowance allow the local model to finish within acceptable time and memory. Preserve stop reasons and distinguish valid syntax from semantic coverage.
4. Evaluate identity disambiguation and evidence/relationship meaning against a separately constructed, independently validated reference. Do not use record counts, matching quotations, or an LLM judge alone as proof of accuracy.
5. Consider NuExtract native structured mode and a mini-model librarian only in controlled comparisons against the existing baseline, with explicit input, endpoint, direction, source-support, latency, and resource measurements.

No implementation, model calls, real-database changes, or benchmark access are authorized by this report alone.
