# Consolidated Code Audit — fanfable/src (2026-11-04)

Four independent read-only audit passes, one per subsystem slice. This file consolidates all 48 findings, ordered the way the auditors ranked them, with statuses re-checked against the working tree on the day of writing. Companion to `REPORT-2026-11-04-extraction-and-alias-continuity.md`.

## Method and caveats

- **How it was produced.** Four read-only audit subagents, each assigned a slice of `fanfable/src`, each reporting 12 findings: (A) answer/plan/support/trace, (B) core/identity/gates, (C) product/server/ui/cli, (D) extract/court. Method per agent: full reading of every module in the assigned slice plus its scoped tests; key claims verified live by calling exported functions against in-memory SQLite databases or local fake servers (never against trial data, never with model inference).
- **Evidence labels.** **[verified]** = demonstrated with a direct probe; **[code-verified]** = confirmed by precise line reading; **[inferred]** = failure consequence reasoned rather than demonstrated.
- **Snapshot context.** At audit time the full suite passed 1393/1393; on the day of this writing (after the interrupted repair session's partial fixes) it passes 1396/1396. Every finding below is a *gap the tests never cover or a latent risk*, not a currently-failing build. **11 findings are HIGH.**
- **Tree drift.** Audits ran against a moving tree (the repair session was mid-work). Untouched files match the audit exactly; changed files are flagged with current-tree status in place.

## Headline

The most consequential cluster is the **gates module (B1–B3)**: it can bank false or inverted relationships as confirmed fact, corrupting the bank that retrieval, continuity, and planning all read from. Independent auditors converged on the same defects twice from different angles (accepted-grade handling: A5 + D3; dead-but-documented production code: B9 + D6 + C12), which raises confidence that both are real and systemic.

---

## Section A — Answer, plan, support, trace (12 findings)

### A1. HIGH — Status-tie guard bypassable by ordinary wording `[verified]`

`fanfable/src/answer/lore-ask.ts:325-328, 453-468, 555-556`

The guard that enforces "no keeper ⇒ no confirmed tie" has three escape routes:

- `negated()` skips *any* sentence containing a negation word, so `"No doubt, Asha is Bram's sister."` yields zero asserted claims and the guard does nothing.
- Quoted spans shorter than six words are never checked (`"moon is cheese"` passes).
- A line containing `[Lore: …]` is entirely exempted even when it contains a fabricated passage quote.

Coverage: `guard-relationship.test.ts` and `guard-citations.test.ts` cover normal quotes and negations, not these shapes. Smallest fix: scope negation to an actual denial of the claimed tie, check all quoted spans (or require any claiming passage evidence to match), and attribute `[Lore:]` exemptions to the quote, not the whole line.

**Current-tree status: NOT FIXED** — the six-word minimum and whole-line `[Lore:]` skip are still in `quotedSpans()`; only a cosmetic signature change landed.

### A2. HIGH — Temporal graph filter mixes two incompatible orderings `[verified]`

`fanfable/src/support/graph.ts:1263-1285, 2055-2058, 2563-2566`; related data assignments `:367`, `:447`, `:949-951`, `:1150-1151`

The filter compares `atEventId`/`beforeOrder` against story order, but story relationship edges store *event IDs* in `validFrom`/`validTo`, and canon events are ordered by canon sequence, not story position. Probes:

- With an anchor event of story-order 1, a canon event with sequence 50 disappears from context as "future" — even though canon is whole-book source material.
- A story relationship whose `valid_from_event_id` is 2 but whose actual story order is 100 leaks in at anchor 5, because the filter compares ID 2 to order 5.

Net effect: context hides canon material *and* spoils future-chapter state. `graph.test.ts:465-535` covers only AU event nodes with matching IDs/orders. Smallest fix: never apply story `beforeOrder` to `node.scope === 'canon'`; resolve edge `valid_from_event_id` to the event's story order before filtering.

### A3. MEDIUM — Embedding timeout doesn't cover body reads `[verified]`

`fanfable/src/support/embeddings.ts:77-91`

The abort timer is cleared the moment `fetch()` resolves headers; `res.json()` sits outside it. A server that sends headers then stalls the body hangs the call forever, ignoring `timeoutMs` (probe: a 100 ms timeout was still pending at 1.5 s). Sits on `resolveDenseSeeds`, i.e. the relational retrieval path for chapter writes when embeddings are configured. Fix: keep the abort timer active until body parsing completes.

### A4. MEDIUM — `reviseOutline` doesn't enforce its own scope or validate canon IDs `[verified]`

`fanfable/src/plan/planner.ts:338-419`; saved via `fanfable/src/cli.ts:2309-2318` and `fanfable/src/product/server.ts:822-833`

The `focus` parameter only constrains the prompt; whatever the model returns replaces the old chapter of that number. Probe: a revision of chapter 2 returned chapter 1 too, and chapter 1's approved title/goal were silently replaced in the new draft. The revision path also parses `canon_event_ids` with bare `Number()` and saves them without the validation the draft path applies (`controller.ts:1594-1609`) — nonexistent canon-event references can be persisted. Fix: discard off-scope chapters, validate revised IDs against the canon table (or route revision through the controller validation).

### A5. MEDIUM — Web brief drops all `accepted` keeper ties `[verified]`

`fanfable/src/plan/brief.ts:164-172`

The grade ladder handles `user_confirmed`, `attested`, `provisional`, `needs_review` — then `if (!grade) continue`. `accepted`, which the codebase's own keeper definition (`lorebook.ts:5665-5670`) treats as keeper, falls through and is omitted entirely. The separate cast-relationship path in `controller.ts:1497-1501` *does* include it, so the two briefs disagree. Same root defect as **D3**, found independently through a different feature. Fix: treat `accepted` as proven (or add a documented `keeper` grade).

### A6. MEDIUM — Knowledge-continuity check matches generic words `[verified]`

`fanfable/src/support/graph-checks.ts:27-33, 71`

`distinctiveTerms()` filters chance words using capitalization, but the caller lowercases the claim first, killing the filter: every word over three characters counts. Probe: knowledge "Serena Marsh visited Voldemort" plus chapter text "Serena visited the market" is flagged as Serena *referring to* the fact — the only shared meaningful token is the verb "visited". Fix: call `distinctiveTerms` on the raw fact + topic, keep proper-noun handling intact, require word-boundary matches or at least two shared distinctive terms.

### A7. MEDIUM — `enrichEntity` doesn't verify fact quotes, misattributes provenance, ignores knowledge `[verified]`

`fanfable/src/answer/lore-diagnostics.ts:591-620`

- Facts are stored with the model's `quote` as evidence with no check it appears in the window.
- `source_refs` always points at `window[0]` even when the quote came from a later passage (probe: quote from passage 2 stored with refs to passage 1).
- The `knowledge` array the prompt asks for (`:428`) is read by nothing — initialized at `:510`, returned as 0 at `:620`.

Fix: use the same quote-to-passage lookup the relation path has (`:565-571`) for facts; reject or park facts whose quote is absent; either implement knowledge insertion or remove it from the prompt/contract.

### A8. MEDIUM — Two inconsistent eligibility filters for relations `[verified]`

`fanfable/src/support/graph.ts:1829-1840`; `fanfable/src/answer/retrieval.ts:290-296`

- Composed paths accept `accepted` rows without excluding `contested` conflicts (despite the adjacent comment saying otherwise): a contested accepted "A son-of M" + "M aunt-of B" yields "B cousin of A".
- The direct-relation check in the strangers verdict has *no* status filter at all: one rejected row suppresses the stranger verdict entirely, while rejected edges are excluded from the graph.

Fix: one shared eligibility predicate — `review_status IN ('accepted','user_confirmed')`, `conflict_status != 'contested'` — for both composed paths and the direct-verdict check.

### A9. MEDIUM — User instructions injected verbatim into retrieval focus `[verified]`

`fanfable/src/plan/controller.ts:262-269, 310, 401-403`

`assembleContext(..., { userInstructions: 'Keep Serena quiet and mention the bridge' })` produces `focus: ['Keep Serena quiet and mention the bridge']` — a whole sentence treated as a name-like retrieval term. With chapters lacking cast info, memory characters/states get filtered by whether *names appear inside the instruction prose*, and retrieval focus/coverage is distorted, including extra hops. No existing `assembleContext` test passes `userInstructions`. Fix: don't add instructions to focus; extract explicit names if retrieval should target them.

### A10. MEDIUM — Graph relations get wrong provenance; caps don't set `truncated` `[verified]`

`fanfable/src/support/graph.ts:2950-2954, 2977-2984, 3045-3048, 3039-3141`

- An unbacked edge prints the *target's* quote as if it supported the relation (probe: `"Bram was born in the north."` printed as evidence for an unrelated sister-of edge).
- Later refs with locators are ignored if the first ref has none; node citations omit locators.
- The section caps (40 edges, 20 people, 25 facts, 20 events, 10 motives, 4 passages) can silently omit items while `stats.truncated` stays false — only the word budget sets it.

Fix: always prefer the edge's own evidence/refs; emit `[unbacked claim]` when absent instead of borrowing the target's citation; append locators; set `truncated` when a section is sliced.

### A11. MEDIUM — Re-running canon-event extraction duplicates events `[verified]`

`fanfable/src/answer/lore.ts:328-344`

Every parsed event is inserted unconditionally; no upsert key or unique constraint on `(project_id, source_id, chunk_id, title)`. Probe: a second `extractCanonEvents` run on the same chunk/title doubled 1→2. Since `lore events --extract` is an exposed CLI command, duplications propagate into retrieval, evidence packets, and planning indexes. `workflow.test.ts:109-126` covers a single extraction only.

**Current-tree status: LIKELY FIXED, NOT RE-PROBED** — `lore.ts` shrank ~25 lines after the audit in the direction of this fix.

### A12. LOW/MEDIUM — PPR trails budget emits a cutoff the audit can't close `[verified]`

`fanfable/src/support/graph.ts:2854-2861`; `fanfable/src/trace/trace.ts:1553-1581`

With more than four graph passages, `buildPprGraphContext` emits `retrieval.budget.cutoff (budget:trails)` without the matching `trails:final` summary, so the audit reports `retrieval_budget_summary_missing` on exactly that path — and `audit.exhaustive` still returns `true` because exhaustiveness ignores violations (`trace.ts:3050-3056`). Fixtures never have enough passages to trigger it. Fix: emit a matching `trails:final` summary, or use a subject the audit does not treat as final trail accounting.

### A-slice clean report

`support/search-policy.ts`, `support/edge-rank.ts`: no defect found. `trace/extraction-trace.ts`: no independent high-confidence defect; `audit.exhaustive === false` behavior is by design. `trace/trace-readonly.ts`: read-only/WAL/invalid-schema paths look sound; one inferred race in `wal-snapshot` mode (writer commits between main-file copy and WAL copy) was not assessed. `answer/evidence.ts` / `evidence-retrieval.ts`: selector explicitly unwired in production (per `docs/HOW-IT-WORKS.md:81`); no production-visible defect. `support/importer.ts` / `support/lore-import.ts`: no high-confidence defect; lower-risk notes — PDF extraction can drop the last page when `pdftotext` output lacks a trailing form feed; ZIP inflation has no decompression-size cap. `plan/context-trace.ts`: nothing beyond A12. Association-web default-on behavior: unquantified O(n²) risk on large corpora, not a verified defect (no benchmark run).

---

## Section B — Core, identity, gates (12 findings) — the most damaging slice

### B1. HIGH — Asymmetric relations are read backwards `[verified]`

`fanfable/src/gates/gates.ts:311-328, 379-397, 577-599`; `fanfable/src/identity/relation-proof.ts:74-82, 168-176, 194-199, 249-251`

`verbOrderDirection()` unions the claimed family's word forms with the *inverse* family's, so a form belonging to the other side satisfies "forward". The family tables include inverse-side and passive forms as `keys` (`master.keys` contains `student`/`disciple`/`padawan`; `employer.keys` contains `employee`; parent/child contain `born to`).

Probes through `canPromote`, all against a matching chunk in an in-memory DB:

- `kind='master of'`, evidence `"Mara was trained by Tor."` → `{ok:true}`
- `kind='master of'`, evidence `"Mara was Tor's student."` → `{ok:true}`
- `kind='employer of'`, evidence `"Mara was Tor's employee."` → `{ok:true}`
- `kind='parent of'`, evidence `"Mara was born to Tor."` → `{ok:true}`
- Correctly directed `kind='servant of'` against `"Mara was Tor's student."` → `{ok:false, reason:'direction-mismatch'}` (false negative)

Result: **inverted relations banked as accepted/proven**, with retrieval and continuity checks then reasoning from the wrong fact. The last-ditch `directionOfSentence(...) === 'reverse'` check (`lorebook.ts:10197`) doesn't catch these because the constructions often return `none`. `inverseFamilyOf` is not an involution for `employer → servant → master`, so the gate and `directionOfSentence` disagree for the same sentence. No test coverage at all.

Smallest fix: separate forms used for *classification* (`keys`) from forms used for *direction* (`heads` + same-side verb keys); track which family a matched form belongs to and return `reverse` for inverse-family forms; treat passive forms (`trained by`, `born to`, `hired`) as inverted. If not immediately feasible, fail closed for asymmetric kinds unless `directionOfSentence` returns `forward`. Add the five fixtures above as regressions.

### B2. HIGH — Any family word anywhere proves a symmetric tie `[verified]`

`fanfable/src/gates/gates.ts:489-498, 602-610`

For symmetric families, the bare-co-mention-plus-any-family-term disjunct in `sameClauseWithBothEndpoints()` means the family word can belong to an unnamed third party. Probes: "Mara told Tor that **her friend** had arrived" banks `friend of` Mara↔Tor; "Mara protected Tor from his enemy" and "Mara admired Tor's enemy" bank `enemy of`. All `{ok:true}`. High false-positive rate on ordinary prose ("her friend/enemy", "the family", "his master"). Coverage gap: `proof-entailment.test.ts:86-91` only tests co-mention with no family word. Fix: drop the bare `familyTermPresent` disjunct; accept only the grammatical constructions already available (`familiesHeldByName` on both sides, `coordinatedSymmetric`, `possessiveDirection`); add the three fixtures as refusals.

### B3. HIGH — Denials missed when the relation word isn't the kind's head `[verified]`

`fanfable/src/gates/gates.ts:238-259`, called from `:637-651`

`leadingDenialOrHedge()` anchors on `row.kindSource` and `kindHeadWord(row.kind)` only. Probes:

- `kind='friend of'`, `"Mara did not trust Tor."` → `{ok:true}`
- `kind='ally of'`, `kindSource='trusted'`, same quote → `{ok:true}`
- `kind='friend of'`, `"Mara never trusted Tor."` → `{ok:true}`

The explicit denial banks as a positive tie — the "no denied clause" rule is bypassed by inflection or by a kind label whose head doesn't appear in the sentence. No test covers a kind-head/key mismatch fix: include the family's forms in the anchor set (`familyHeadForms(familyOfKind(row.kind))`), scan the four tokens before each matched form for negators/hedges, add the three fixtures.

### B4. HIGH — Ollama NDJSON streaming assumed whole lines per network chunk `[verified against a local fake server]`

`fanfable/src/core/llm.ts:336-364`

Each read was split on `\n` and parsed immediately with no carry-over buffer; when a TCP chunk split a JSON line, `JSON.parse` threw and every Ollama-backed operation failed as `LlmError("Malformed Ollama response line…")`. Reproduced with one valid line written in two halves 30 ms apart. `llm.test.ts:38-80` wrote complete lines only.

**Current-tree status: FIXED AND TESTED** — `pending` buffer, streamed decode, and an end-of-stream flush are in place. This was the interrupted repair session's last completed work.

### B5. MEDIUM — Identity resolver discards alias hits on any exact hit `[verified]`

`fanfable/src/identity/identity.ts:160-193`

`const direct = exact.length ? exact : alias` silently resolved a shared/aliased name to one entity where the module's own rule (and the correct resolver in `lorebook.ts:13948-13963`) demands collision handling. Probe: entity "Mara Voss" aliased "Captain Voss" + a second entity named "Captain Voss" → `resolveEntity('Captain Voss')` returned entity 2 at tier `exact` with zero ambiguity, while `identity-check` correctly flagged the pair. Callers: `booknlp-bridge.ts`, `plan/brief.ts`. `entity-resolve.test.ts:55-73` tested exact and alias separately; `identity-check.test.ts:92-103` created exactly this collision but never called the resolver.

**Current-tree status: FIXED** — the union `[...new Set([...exact, ...alias])]` is in place.

### B6. MEDIUM — Two incompatible "verbatim" definitions `[verified]`

`fanfable/src/core/text.ts:29-35`; `fanfable/src/gates/gates.ts:619-627` vs `fanfable/src/lorebook.ts:11402-11410, 11462-11470`

The gate's `normalise()` drops curly apostrophes and punctuation; the integrity audit's `auditNormalize()` folds them and preserves boundaries. Both consequences probed:

- Identical words differing only in quote style fail promotion (`quote-not-verbatim`) — legitimate claims refused.
- Punctuation-spliced text passes the gate and then fails the audit — promotion is non-reproducible; the same row is reported by `findUnverifiedKeepers` as not verbatim.

Fix: a gate-local `proofNormalise()` that folds curly quotes/dashes exactly like `auditNormalize` and compares with token boundaries. Do *not* change `core/text.normalise` directly — `court/claim-proof.ts:274,292` hashes with it, so fingerprints would change.

### B7. MEDIUM — Bare honorifics resolve as people; title lists are duplicated and incomplete `[verified]`

`fanfable/src/identity/identity.ts:251-261`, `identity-check.ts:56-66`, `roster-rules.ts:27-34`, `names.ts:29-34`

Four separate copies of the title list; the resolver's copy and `identity-check`'s copy lack `doctor`, `professor`, `prof`, `miss`. Probe: with entities "Doctor Who", "Miss Havisham", "Professor X" present, `resolveEntity('Doctor')`, `('Miss')`, `('Professor')` all resolve to someone by containment, while `mergeVerdict` correctly says "title only". "The Doctor"/"the Professor" can be attributed to a specific character; collision flags fire on prefixes the merger wouldn't merge. Fix: one shared `TITLE_TOKENS` set in `core/vocab.ts` or `identity/names.ts`, imported everywhere; tests for bare titles resolving to nobody and for resolver/merge agreement.

### B8. MEDIUM — Migration recovery skips later migrations and most tables `[verified]`

`fanfable/src/core/migrations.ts:1165-1195` (`BASE_TABLES` at `:1172-1186`, skip logic `:1190-1195`); `fanfable/src/core/db.ts:29-31`

The base-recovery check covers only 12 base tables, and if any is missing, migration 1 runs while the captured high version still suppresses everything after 2 — leaving `claim_proof`, `trace`, `quarantine_reason` etc. absent. Probes:

- A version-32 DB with no tables: `runMigrations` returned 1, left the later tables missing; the first `Db` open would fail when `identity.ts` selects `quarantine_reason`.
- A version-32 DB missing only `canon_thread`: returned 32 without recreating it.

`db.ts` also rewrites `schema_meta.version` to `SCHEMA_VERSION = 1` while `user_version` is 32 — two version stores that disagree (latent diagnostic/migration hazard, not read today). `migrations.test.ts:50-90` starts from version 1 or a fully migrated DB. Fix: when base tables are missing, set the effective version to 1 after applying the base schema (or run all subsequent idempotent migrations unconditionally); include all known tables in the recovery check; reconcile the version stores.

### B9. MEDIUM — Whole modules are dead code presented as production `[code-verified by import search]`

`fanfable/src/core/combine.ts`, `gates/veto.ts` / `veto-batch.ts` / `veto-bridge.ts`, `identity/booknlp-bridge.ts`: no non-test importer of the first two; no production caller of `applyVeto`, `applyVetoBatch`, `createPythonVetoScorer`, or `vetoEnabled`. `veto-bridge.ts:1-11` still describes a "product → bench-venv verifier" call path that doesn't exist. Tests give false confidence that the veto is part of promotion. Latent inside dead `combine.ts:105-113`: null-chunk notes each get their own independence share (three 0.4 notes → 0.784 clears the 0.7 bar), contradicting the module's own "one share per passage" rule. Fix: wire into intended call sites, or delete along with their tests; align the veto docs.

### B10. LOW — Missing confidence defaults to maximum `[verified]`

`fanfable/src/gates/gates.ts:1048-1059` (line 1056)

`claimTier(guarded.confidence ?? 1, min)` — a caller omitting `confidence` gets full marks, reintroducing exactly the "unjudged rows count freely" failure the module header warns about. Probe: `provenRelation` without confidence → `{ok:true}`; with `confidence: 0` → `{ok:false, reason:'below-threshold'}`. Latent today (the column is NOT NULL) but a fail-open trap for any new caller. Fix: `?? 0`, or make the field required and validated; add a test that an omitted confidence is `below-threshold`.

### B11. LOW — `Db.transaction` leaves `depth = 1` forever if `BEGIN` fails `[code-verified]`

`fanfable/src/core/db.ts:55-81`

Former behavior: `depth = 1` was set and `BEGIN` executed outside the `try/finally`, so a single busy/IO failure on `BEGIN` left the connection pseudo-nested — every later write ran silently outside a transaction for the connection's lifetime.

**Current-tree status: FIXED** — `BEGIN` now sits inside the `try`, so the `finally` resets depth even when `BEGIN` throws.

### B12. LOW/MEDIUM — JSON salvage can return a nested fragment of a truncated root object `[verified]`

`fanfable/src/core/json.ts:48-88` (embedded scan `:75-87`)

When the root is truncated, the embedded scan returns the first *balanced* inner value instead: `{"entities":[{"name":"A"}],"facts":[` yields the inner entity array with route `embedded`, and `extractJson()` hides the route — token-limit truncation looks like a successful parse of a different shape, producing silently empty extraction instead of a retry path. Callers (planner, extraction) do `extractJson<{entities?: …}>` and read properties, so the shape mismatch is silent. `text.test.ts:183-194` covers complete objects, fences, and prose noise; no truncated-root case. Fix: when the first opener is at the start of trimmed text and its balanced scan fails, stop (return `route:'none'` or a new `truncated` route) instead of falling back to nested openers.

### B-slice clean report

`core/schema.ts`: DDL clean beyond B8's version mismatch. `core/vocab.ts`: clean (duplicate `married`/`our` entries change nothing; the title-list duplication is B7). `identity/names.ts` core matchers (`canonicalName`, `nameRelation`, `withinOneEdit`, `deriveNameVariants`): behaved as documented. Two low-frequency observations not promoted: `nameRelation` treats any `X`/`Xs` pair as the same name (surname `Vos` vs `Voss`), and `canonicalName` doesn't strip trailing plural possessives (`Dursleys’`). `identity/relation-proof.ts`: inverse/direction problem is B1; bare forms of some heads (`son`, `boss`, `ward`, …) missing from `keys` park instead of bank — fail-closed, a coverage gap rather than corruption. `llm.ts` credential handling: correct (no keys to loopback endpoints, fails closed on invalid URLs). `core/db.ts` helpers (`fromJson`, `asArray`, `strList`): as documented. `core/text.ts` chunking/front-matter trimming: consistent with tests.

Not assessed: Python veto runtimes (`veto_runtime.py`, `veto_runtime_lite.py`) — outside the `*.ts` scope; real historical databases — B8 is based on in-memory simulation; live model providers — streaming was reproduced with a local HTTP server.

---

## Section C — Product, server, web, UI, CLI (12 findings)

### C1. HIGH — Editing an approved chapter leaves it approved `[verified]`

`fanfable/src/plan/controller.ts:160-211`; `fanfable/src/product/server.ts:913-925`; `fanfable/src/ui/app.js:748`; `fanfable/src/cli.ts:2398-2400`

`setChapterBody()` saves without a status; `saveChapter` defaults to the existing status. The UI says "The chapter returns to draft" and the CLI says "Saved chapter N as a draft" — both false. The edited chapter still counts as approved and its old story memory stays live, so the author may never re-approve it. The same route's `impactedMaterial(..., "chapter N")` (`server.ts:923`, `cli.ts:2399`) searches chapter bodies for the literal phrase "chapter N", so the impact report is meaningless. Coverage: `workflow.test.ts:292-310` edits and re-approves but never checks status; no server edit-route test. Fix: pass `status: 'draft'` in `setChapterBody()`, clear or stale-flag chapter-derived memory, and replace the synthetic "chapter N" impact subject with actual changed names/content.

**Current-tree status: UNVERIFIED** — `server.ts` was edited after the audit; not confirmed against the current file.

### C2. HIGH — Deleting a chapter orphan-scatters its derived memory `[verified]`

`fanfable/src/product/server.ts:928-937`; `fanfable/src/product/memory.ts:1011-1036`; `fanfable/src/ui/app.js:734`

The route does a bare `DELETE FROM chapter`. Most derived tables declare `ON DELETE SET NULL` (`au_event`, `character_state`, `character_knowledge`, `story_fact`, `relationship`, `motivation`, `secret`, `state_conflict`), so those rows survive as orphans while the UI promises "The text and its memory records are removed." The repo already has `memory.clearChapterExtraction()` — used on re-approval at `controller.ts:1245` — but never called here. Fix: in a transaction, clear extraction and close chapter-scoped `state_conflict` rows before deleting. No delete-route test exists.

### C3. HIGH — Canon changes written N×M, or zero `[verified]`

`fanfable/src/product/memory.ts:1237-1273`

The canon-change loop is nested *inside* the event loop: N events × M changes → N×M duplicate `canon_change` rows, each attributed to a different event; zero events → all canon changes silently dropped. Duplicates feed continuity evidence and conflicts. `workflow.test.ts:42-64` has exactly one event and one change; memory tests use `canonChanges: []`. Fix: move the canon-change loop outside the event loop; insert each change once, attached to one matching event or `NULL`.

### C4. MEDIUM — Secrets' `knownBy` read from the wrong key `[verified]`

`fanfable/src/product/memory.ts:1073, 1085, 1190, 1397`

The extraction prompt asks for `"knownBy"` and the `StateExtraction` type uses `knownBy`, but `extractState()` reads `x.known_by` (`:1190`); `applyStateExtraction()` reads `sec.knownBy` (`:1397`). A model following the prompt gets its who-knows-what list silently discarded, weakening every continuity check about knowledge. Fixtures bypass the parser by calling `applyStateExtraction()` directly. Fix: parse `x.knownBy ?? x.known_by`; add a prompt/parse round-trip test.

### C5. MEDIUM — Starvation windows order chunks differently than extraction `[code-verified]`

`fanfable/src/web/note-ingest.ts:1645-1648`; `fanfable/src/lorebook.ts:935-950, 3146-3156`

Starvation scoring orders chunks by `seq, id` (seq resets per source); extraction windows use `loadOrderedChunks()` ordered by `source_id, seq`. The reserved "starved" indices then point into the wrong windows in multi-source projects, so budgeted runs fail to rescue the threads they exist to rescue. `starved-and-conflicts.test.ts` uses a single source only. Fix: build starved windows from the same ordered chunk list/helper as extraction.

### C6. MEDIUM — Historical relationships and stale states presented as current `[verified]`

`fanfable/src/product/memory.ts:421-428, 462-485, 309-313, 829-833`; `fanfable/src/product/server.ts:976`

- `upsertRelationship()` closes an old relationship (`closed = 1`) and inserts a new one when the kind changes, but `listRelationships()` doesn't filter closed rows and the `Relationship` type has no validity field — old and new both print under `## RELATIONSHIPS` and in the Story State UI, contradictorily.
- `currentStates()` takes the highest state row id per character. Re-approving an *older* chapter after later ones (`applyStateExtraction` inserts states last at `:1301-1312`) makes that old chapter's states "current" again.

Fix: filter `closed = 0` (or expose history explicitly); order current states by story/chapter order, user overrides first.

### C7. MEDIUM — Temp-copy write guard bypassable via symlink `[code-verified]`

`fanfable/src/web/meetings.ts:1424-1460`

`isTempDatabasePath()` returns true if *any* of the candidates (resolved path, plus realpath if the file exists) is under temp. A symlink placed under `/tmp` pointing at a production database passes on the unresolved candidate, and `attestWriteGuard()` / `reconcileMeetings(..., { write: true })` then permit row-moving/deleting writes against the real database. `meetings.test.ts:989-995` and `attested-tier.test.ts:354-368` only test ordinary temp and nonexistent paths. Fix: when the path exists, require the realpath to be under temp; don't treat spellings as separate passes.

### C8. MEDIUM — Settings stores `contextTokens` as a string `[verified]`

`fanfable/src/product/server.ts:1089-1095`; `fanfable/src/ui/app.js:1544`; `fanfable/src/core/llm.ts:322, 526-538`

The UI sends the raw input string; only `temperature` is coerced server-side; `contextTokens`/`maxTokens` are stored unchanged and flow into `LlmSettings` and Ollama `num_ctx`, violating the `LlmSettings` number contract — and the wrong value persists globally for new projects. No `/api/settings` POST test. Fix: coerce with `Number()` and reject non-finite/out-of-range values.

**Current-tree status: UNVERIFIED** — `server.ts` was edited after the audit; not confirmed against the current file.

### C9. MEDIUM — Short API keys fully exposed by "masking"; sync route errors leaked raw `[verified]`

`fanfable/src/product/server.ts:30-35, 1129-1133`; `fanfable/src/cli.ts:2860-2864`

Mask = `slice(0, 6) + "…" + slice(-4)`, so any key ≤10 chars is printed in full (e.g. `test-key` → `test-k…-key`), breaking "never carry the whole API key"; `cloud-hardening.test.ts:110-114` only uses a long key. Separately, non-job routes return `{ error: err.message }` verbatim (SQLite internals, trigger text, filesystem paths) while job errors are properly redacted (`publicJobView`, `:139-152`, tested at `server.test.ts:245-284`). Fix: mask only when the key is longer than the mask budget; generic 500 for unexpected errors with server-side logging.

### C10. LOW/MEDIUM — Premise lint flags sentence-initial common words as unknown characters `[verified]`

`fanfable/src/product/premise-check.ts:117-134`; surfaced via `plan/controller.ts:1624` and the UI's "Some canon references were dropped" toast (`app.js:630`)

Any capitalized ≥3-letter token ("The", "She", "After") becomes an `unknown-character` note whenever the canon index has ≥3 entities and no known entity contains the token. `retrieval.test.ts:175-181` only tests a real unknown name. Fix: ignore sentence-initial/common-word candidates or require a person-name shape before reporting.

### C11. LOW — "Errors only" setting ignored in the Continuity UI `[verified]`

`fanfable/src/product/server.ts:1051-1058`; `fanfable/src/plan/controller.ts:1369-1373`; `fanfable/src/cli.ts:2527-2528`; `fanfable/src/ui/app.js:1498-1502`

Issues are persisted unfiltered; only the returned job result filters by severity. `/api/issues` calls `listIssues()` without `minSeverity`, so the Continuity tab and dashboard counts show everything regardless of the project setting — while the CLI *does* filter. Three surfaces, three behaviors. Fix: apply the project's `continuitySettings` on the server side too (or pass `minSeverity` to `listIssues`).

### C12. LOW — Dead/unwired product surface `[code-verified]`

`fanfable/src/web/threads.ts:777`; `fanfable/src/product/server.ts:507, 580`; `fanfable/src/product/writer.ts:696-697`; `fanfable/src/ui/fanfable-1024.png`

- `threadsForRead()` is documented as caller-less and is.
- `/api/sources/list-files` has no UI/CLI caller and 500s (instead of an empty list) when no project is selected.
- `/api/book-lore/embed` has no caller.
- `writeChapter()` parses `[[META]]` into `result.meta`, but nothing consumes it — the writer prompt advertises a discarded protocol.
- `fanfable-1024.png` is unreferenced.

Weak individually; they make behavior and tests harder to reason about. Fix: wire or remove each; add route tests; drop the asset.

### C-slice clean report

No verified XSS: `app.js` and `dev-viz.js` route data through `esc()`/`textContent`; `trail-html.ts` escapes quoted attributes; no static route reflects input as HTML. `/ui/` and import-filename handling not traversable modulo C7. Testing/scripts organization is low-severity debt (15 flat demo scripts, several duplicating temp-DB/fixture setup, none in `npm test`). Trial data intentionally untouched. Not assessable: browser runtime behavior (static analysis only); whether Ollama rejects or coerces a string `num_ctx` (C8's type defect is verified; provider behavior is inferred).

---

## Section D — Extract, court, recovery (12 findings)

### D1. HIGH — Reopening a completed recovery child can permanently block its windows `[verified code path; blocking consequence inferred]`

`fanfable/src/extract/recovery.ts:789-807, 844-858, 358-374, 1422-1437`; `fanfable/src/lorebook.ts:1427-1429, 1504-1512`

When a *complete* child's expected stage fingerprints go stale, `claimChild` flips it to `pending` and clears `completed_at` *before* checking chunk leases — if another child holds one, it returns `{ok:false, reason:'overlap'}` and the enclosing transaction commits. The child is no longer complete, so `recoveryPublishedChunkIds` stops counting its chunks — but in published (non-stage-only) recovery they were previously finalized with `lore_mined = 1`, so future runs classify the windows legacy-mined and skip them permanently: revalidation that fails, overlaps, crashes, or is deferred is no longer retryable through recovery. Coverage: `extraction-recovery.test.ts:952` uses pending children; roster-revalidation tests are staging-only. Fix: check leases before mutating (or throw/roll back on conflict after reopen), and clear `lore_mined` for the reopened child's chunks, mirroring `createRecoveryRuntime`.

### D2. HIGH — Sweep crashes on an existing resolved tie note, after partially committing proposals `[verified]`

`fanfable/src/extract/sweep.ts:378-401, 405-417`; schema `fanfable/src/core/migrations.ts:300-301`

Duplicate detection queries `canon_tie_note` only for `status = 'pending'`, but the unique index `canon_tie_note_pair` covers *all* notes for the directed pair + attempted kind. Any resolved/parked/dropped prior note — normal after merges or human resolutions without relation creation — makes the plain `INSERT` throw `SQLITE_CONSTRAINT` → the entire sweep aborts while earlier inserts are already committed (no transaction), and the CLI gets an exception instead of a result. `sweep-proposals.test.ts:154-164` tests only the pending-note duplicate path. Fix: treat any note with the same pair+kind as a duplicate (or `INSERT OR IGNORE`), wrapped in one transaction so failures don't leave a partial queue.

### D3. MEDIUM — Sweep's keeper predicate contradicts the rest of the bank `[verified]`

`fanfable/src/extract/sweep.ts:361-372, 378-395`; `fanfable/src/lorebook.ts:6094-6099, 16010-16017`

Sweep treats only `review_status = 'accepted'` as keeper; `lookupKeeperPair` treats `accepted` + `user_confirmed`; `listTieProposals` treats `user_confirmed OR confirmed_by_user = 1`. Sweep's keeper check is pair-wide while its duplicate check is kind-specific. So human-confirmed ties spawn redundant pending proposals that the review queue then hides — while an accepted `friend of` wrongly suppresses a genuinely different `enemy of` claim for the same pair. Same root defect as **A5**, found independently. Fix: one shared keeper predicate/helper; one explicit decision (pair-wide vs kind-specific) applied to both checks.

### D4. MEDIUM — Events prompt asks for a `modality` the schema can't store `[verified mismatch; consequence inferred]`

`fanfable/src/extract/extract-prompts.ts:151-159, 168`; `fanfable/src/lorebook.ts:7354-7368`

`EXTRACT_EVENTS_SYSTEM` instructs: "record the claim normally but set modality to denied/possible/suspected … never store a denial as a plain fact" — but `applyTimeline` reads no modality and `canon_timeline` has no modality column. A compliant model produces denied events banked as ordinary historical rows, plus an unparsed `modality` key. Fix now: delete the modality sentence and re-pin the prompt hash; add the field properly only if timeline modality semantics are designed deliberately.

### D5. MEDIUM — Sweep proposals bypass the court record `[verified; invariant violated]`

`fanfable/src/extract/sweep.ts:405-417`; `fanfable/src/court/ruling.ts:1-16, 213-218`; `fanfable/src/lorebook.ts:11512-11534`

Every other tie-note writer (`persistTieNote`, `replayRulings`) records a ruling; sweep inserts pending `canon_tie_note` rows directly and never calls `recordRuling`. The court module states every actor writes a ruling. Since the docket counts pending tie notes as objections, a sweep proposal appears on the docket with no history of who proposed it, on what standard, or why — and `backfillCharges` repairs relations, not notes. Fix: wrap the tie-note insert and a `recordRuling` call (`role: 'objection'`, `standard: 'sweep-proposal'`) in one transaction — or, if sweep is intentionally outside the court, document that and stop counting its notes as docket objections.

### D6. MEDIUM — The claimed court "owner" / proof ledger are dead; the architecture test grandfathers the legacy writers `[code-verified]`

`fanfable/src/court/claim-transition.ts:745, 806`; `fanfable/src/court/claim-proof.ts:453, 529`; `testing/tests/claim-transition-architecture.test.ts:26-40`

`transitionClaim`, `shadowTransitionClaim`, and `readRelationClaimState` have zero non-test importers; `claim-proof.ts` is production-reachable only through `newClaimUid`. Production still writes `review_status`/`confirmed_by_user` through eleven grandfathered `lorebook.ts` sites; no production claim gets proof rows; `readRelationClaimState` reports `not_evaluated` for every production relation. The architecture test pins write-site counts, not call-graph adoption, so it passes while the invariant it claims to enforce ("the owner is the only production writer") is false. Parallels **B9**: two auditors, independent slices, same systemic pattern. Fix: wire `transitionClaim` into promotion/correction/removal and remove the grandfathers — or mark the modules experimental, correct the claims, and keep the write-site guard as a future constraint.

### D7. MEDIUM-LOW — Pair-subject docket cases always show zero objections/zero open ends `[code-verified]`

`fanfable/src/court/ruling.ts:213-230, 251-258`; `fanfable/src/lorebook.ts:11525-11527`

Objection rulings without a relation are recorded under `pair:<min>:<max>` with `relation_id = NULL`; the docket's `objections` and `open_ends` subqueries both require a relation join. Objection-only cases — the docket's core purpose ("the latest ruling, current status, pending objections, open want") — display but undercount both to zero. `ruling.test.ts:374-394` checks `listRulings` only; `:223-237` tests docket objections with an existing relation. Fix: parse pair ids from the subject and count pending notes / open ends directly (or persist explicit pair ids on the ruling).

### D8. MEDIUM-LOW — `deferStage` can expire another process's leases without ownership `[verified API hole]`

`fanfable/src/extract/recovery.ts:1300-1306, 1357-1362, 1371-1375`

Ownership is verified only when both `owner` and `fencing` are supplied — but the method proceeds regardless: it defers the child and runs `UPDATE extraction_chunk_lease SET lease_until = ? WHERE child_id = ?` with no owner/fencing predicate. A stale process (or any caller using the optional form) can fence off a live owner's leases and change child state without proving ownership. `extraction-recovery.test.ts:1118-1210` tests stale deferral only *with* owner/fencing. Fix: require `owner` and `fencing` on this public path (production callers already have them) or restrict the lease update to the supplied fencing; keep the attempt-exhaustion path as a separate internal method.

### D9. LOW-MEDIUM — `importClaimProofs` accepts combinations the append path rejects `[verified]`

`fanfable/src/court/claim-proof.ts:465-467, 559-578, 606-644`

`appendClaimProof` rejects `outcome === 'verified' && standard === 'none'`; the importer validates only outcome/standard-vs-claim-type. A hand-edited or third-party export imports as `verified`, and `resolveClaimProof` then reports `sourceProof: 'verified'` with no unproven warning — for a row the system could never have written. `claim-proof.test.ts:602-631` imports only valid rows. Fix: apply the same validation in the import loop; count invalid rows as `skipped`.

### D10. LOW-MEDIUM — Wrong-shape-but-valid JSON throws in court fingerprinting and recovery `[verified hazard]`

`fanfable/src/court/claim-proof.ts:277-303, 343`; `fanfable/src/extract/recovery.ts:550-563`

`fromJson` returns any parsed value; callers `.map`/`.filter` `source_refs`, `aliases`, `chunk_ids` and assume plain objects for `stage_fingerprints`. One legacy row with `source_refs = '{}'` makes `computeClaimFingerprints`/`readRelationClaimState` throw a `TypeError` instead of surfacing "evidence unavailable"; a `chunk_ids = '{}'` recovery row makes every claim/renew/finalize on that child throw; `stage_fingerprints = []` silently round-trips as `[]`, losing evidence. Fix: `Array.isArray` / plain-object guards, mirroring the checks `citedEvidence` already applies to individual refs.

### D11. LOW — Two incompatible roster-snapshot formats share one table; `snapshotRoster` is called and discarded per relations stage `[verified]`

`fanfable/src/extract/recovery.ts:1563-1589, 1592-1613, 1615-1646`; `fanfable/src/lorebook.ts:8337-8340`

`snapshotRelationStage` persists `{promptNames, entities}`; `snapshotRoster` persists a bare rows array into the same `extraction_roster_snapshot` table keyed only by an opaque fingerprint. `relationSnapshot` can't parse the second format and returns `undefined` for its fingerprints. `snapshotRoster` also does a non-atomic SELECT-then-INSERT, so two concurrent processes computing the same new fingerprint can collide (`UNIQUE constraint failed`, aborting one window), and `runStage` calls it for every relations stage even when `spec.fingerprint` is already supplied, discarding the result. `recovery.status()` and `stagedBatchForAttempt()` are unused. Fix: one tagged snapshot payload/serializer or separate tables; `INSERT OR IGNORE`; call `snapshotRoster` only when no explicit fingerprint; remove the unused methods.

### D12. LOW — Sweep silently skips non-ASCII names `[verified]`

`fanfable/src/extract/sweep.ts:14-20, 278-286`

Normalization keeps only `[a-z0-9' ]` and `forms` filters to ASCII-capital-prefixed strings; a character like "Éowyn" with no ASCII alias leaves `forms` empty and is skipped entirely — no sweep, no unresolved-target diagnostic, no result entry. Accented vs unaccented variants also normalize differently, weakening alias resolution. Coverage-first defect, not corruption. Fix: Unicode-aware tokenization (`\p{L}\p{N}` / `\p{Lu}` with the `u` flag, NFKD normalization) while keeping the ASCII heuristic.

### D-slice clean report

`claim-proof.ts` core append/resolve logic is sound and well covered (latest-attempt selection, fingerprint/policy invalidation, deletion/recreation, import sequencing — D9/D10 are the exceptions). `ruling.ts` `recordRuling`/`listRulings` primitives correct and transactional with callers (D5/D7 concern integration, not the primitives). Recovery lease/fencing/attempt/staged-batch machinery is unusually well tested (cross-connection fencing, crash replay, renewal, finalize rollback) — D1/D8 are the real edges. `extract-prompts.formatKnownEntities` matches pinned tests; potential prompt-structure injection through newlines in names was noted but not elevated.

---

## Cross-cutting observations

1. **Independent convergence.** The same defect was found twice from two angles (accepted-grade handling: A5 + D3) and the same pattern three ways (dead-but-documented production code: B9 + D6 + C12). Two auditors converging from disjoint slices raises confidence that both are real and systemic.
2. **Risk concentrates in untested policy code.** The HIGH findings all live in richly-branched policy modules with little or no test coverage: the gates (B1–B3), the status-tie guard (A1), temporal filtering (A2), recovery reopen (D1). The simply-structured modules (rulings, leases) are clean — coverage is doing its job there, and its absence is visible in the complex ones.
3. **Fixed so far, confirmed by working-tree spot-checks on 2026-11-04:** B4 (Ollama streaming buffer), B5 (alias/exact resolver union), B11 (transaction `BEGIN`/depth safety). Verified against the current files.
4. **Likely fixed, not re-verified:** A11 (canon-event dedup, `lore.ts` shrank ~25 lines post-audit) and parts of C1/C8 near the changed `server.ts`/`cli.ts` lines (backed by 79 new lines in `server.test.ts`). Re-probe before striking these off the list.
5. **Everything else untouched** — including the three gate defects, the status-tie guard bypasses, the temporal graph filter, and the product-memory defects. The gate cluster is the highest-value remaining work.
6. **Snapshot suite status:** 1396/1396 passing on 2026-11-04, ~14 s runtime. All findings above are coverage gaps or latent risks under a green build.
7. **Missing verdicts.** Any of the following could change the assessment of the affected findings and none has been done: Python veto runtime review (B9 context), real historical database recovery (B8), browser-runtime behavior (C-slice), association-web O(n²) benchmark on a large corpus (A-slice), live-provider behavior for C8's string options and A3's stalled-body path in production configuration. Trial data under `testing/trials/` was deliberately excluded from all four audits.
