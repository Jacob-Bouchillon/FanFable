# How it works — the standing design

Merged 2026-10-29 from the four specs, the kinds checkpoint, and the handoff. A section marked *(shipped)* is in the code; *(built, not wired)* runs but nothing calls it. Numbers are dated evidence, not promises.

## 1. Guard: the code certifies citations, nothing more

A row banks only when all hold: the quote is verbatim in the cited passage; both entities exist in the roster; they are not the same person; a confidence threshold the author sets is cleared (default 0.7). A quote that hides a preceding "perhaps" or "not" in its holding sentence is refused — misquotation, not grammar.

Everything else is the model's judgement, recorded with the claim: whether the sentence says it, whether "him" is Ron, which concept fits, how sure it is. Nothing in the code enumerates English words for a relationship — the closed label list, synonym lists, `KIN_GROUPS`, the head-word test, the possessive/of-phrase/SVO assertion matcher, reverse-direction enforcement as a promotion condition, the concept set as a promotion gate (it stays for labelling and querying), the `kind_source` substitution loophole, and the `open-vocab` rejection were all deleted, not disabled. Before them, three attempts failed the same way: the label list banked 30 rows with 7 genuine, then 3 with 3 — precision bought by throwing away 90%; the assertion matcher rejected scenes correctly and most real relationships too (only 9.1% of sweep quotes name both people); the vocab gate owned just 5 of 258 queue notes and was never the bottleneck. Two definitions of truth in one codebase is how the last month happened.

Fabrications never bank: a claim whose quote is not in the source is stored as `unsupported-citation`, unresolved names are reported never guessed, author confirmation banks as `user_confirmed` regardless of score. Tests pin this: below-threshold stays queued, confirmed banks anyway, anchored pronoun claims bank at score with anchor stored, calibration fixtures map predicted bands to corrections, and no grammar rule can veto a threshold-clearing claim while no threshold rescues a fabricated quote. *(shipped)*

## 2. Kinds are concepts, not words

A label names a concept; its description explains it and how it differs from its neighbours. The model reads descriptions and maps the passage's wording onto one — `disliked` is proven by "loathed", because the model mapped it, not because a list contains "loathed". Semantic fidelity is the model's: the system guarantees a real citation bound to the pair, never that the label is apt. *(shipped)*

| Concept | Is | Differs from |
|---|---|---|
| disliked | personal aversion | **enemy**: no open conflict; **distrust**: about the person, not reliability |
| enemy | active opposition, harm intended | **disliked**: conflict is open |
| trusted | confidence in someone's conduct | **loyal**: confidence held by the truster, allegiance given by the other |
| loyal to | allegiance given to someone | **trusted**: allegiance, not an assessment |
| protected by / protective of | safeguarding from harm | **mentor**: safety, not development |
| feared | emotional response to threat | **distrusted**: fear, not doubt about intentions |

Each concept declares itself **directional** (`enemy`, `mentor`, `teacher`, `bullied`, `protective of`, `obeyed`, `loyal to`, family set — direction checked, reversals refused) or **symmetric** (`disliked`, `admired`, `trusted`, `distrusted`, `feared`, `friend`, `sibling`, `cousin`, `colleague`, `partner` — stored once, either order).

The guard's checkable conditions: the label is one of the concepts (the set stays closed so the bank stays queryable); the model's `kind_source` appears verbatim in the quote or anchor; the anchor's sentence links it to *both* endpoints; direction resolves or is left unknown, enforced only where directional. The label itself need not appear in the quote.

Judged on a fixed hand-written set: same concept in different wording maps together; near-miss concepts don't cross (`disliked` vs `enemy`); co-occurrence and three-character passages yield no false proposals (measured 6/6 stable across 3 runs, 0 false, 0 wrong pairs); negation never banks the positive; uncertainty never banks as asserted; change over time wants time-scoped claims (not stored — see §8). One earlier run emitted `loathed` as a label: it parked rather than banked, the failure mode the concept set exists to catch.

Ontology decisions (2026-10-29): absorbed as same-concept wording — friend (`friendship`, `best friend`, `teammate`), enemy (`enmity`, `adversary`), spouse (`wife`, `husband`, `married`), sibling (`brother`, `sister`, older/younger/twin), parent (`mother`, `father`, `son`, `daughter`, `child`; specific kinds kept alongside generics because queries need them), relative (`family`, `kin`), teacher, student (`study partner`, `apprentice`), colleague (`coworker`), master (`servant`), ally (`companion`). Added: `rival of`, `acquaintance`, `guardian of`, `employer of`, `customer of`, `owner of`, plus `disliked`, `resented`, `feared`, `admired`, `trusted`, `distrusted`, `bullied`, `protective of`, `jealous of`, `loyal to`, `obeyed`. Removed as duplicates: `married to`, `partner with`, `assistant of`. Removed as non-relationships: `standing next to`, `blocked by`, `lamp-like eyes`, `host`, `enforcer`, and sentence-long pseudo-labels. Rule: usage in one book never deletes a concept.

## 3. Names resolve at match time, never stored

Stored `name` + `aliases` are explicit and unconditional. Everything else is derived once per command and filtered — never persisted, displayed, merged on, or written back:

1. Canonicalise (case, possessives, articles, punctuation).
2. Title-strip while the first token is a title: universal honorifics/kin titles, or any token carried by more entities than `NAME_DF_CAP`.
3. Emit full, stripped, surname (last token), given name (first token); single-token names emit only themselves. Deterministic order: explicit forms in stored order, then full, stripped, surname, given.
4. Filter derived forms only: shorter than 3 chars dropped; lowercase form occurring whole-word case-sensitive in the text dropped (same predicate as the suspect-character quarantine — one shared helper, and `entity-quarantine.test.ts` passes unmodified); roster collision (any *other* entity canonicalises the same — both lose it, ambiguity stays visible, places count as entities); duplicates of explicit forms dropped. A capitalised homograph ("Dean") passes the lowercase test — only collision sees it — and duplicate identity needs its own fix: this derives nothing for it.

Routed through: `mentionSpans`, `assertsRelationship`, `namesBothDistinctly`, endpoint/direction helpers, `scanSentenceCandidates` (full names only before), the name sweep (whose inline builder once made "The" a name form sweeping noise 334 times), and the answer guard. With no index every function takes the exact previous path. Measured on the test book: sentences naming two characters 84 → 208, guard accepts 0 → 13; 157 roster entities, 88 variants retained (164 dropped common-word, 51 collision, 1 too short); scan candidates 147 → 855. The regression that matters most: "Aunt Petunia looked over at Dudley" is still rejected with variants on; two same-named entities both keep full names; hygiene tests prove the database is byte-identical after a full pass and variant maps are run-identical. *(shipped)*

## 4. Confidence, tiers, and calibration

Per relation the model returns:

```json
{
  "from": "Harry", "to": "Ron", "kind": "friend",
  "kind_source": "the words that express it",
  "evidence": "the sentence",
  "anchor": "the sentence naming the other person, when the quote names only one",
  "names_both": false, "asserted": true,
  "other_person": "pronoun", "directness": "implied",
  "confidence": 0.7, "why": "one sentence of reasoning"
}
```

`other_person`: named | pronoun | role | absent. `directness`: stated | implied. `strength`/`confidence`: how strongly this quote supports *this concept* for *these two people* — "shared a dormitory" is 0.9 for `dormmate`, 0.4 for `friend`. `why` is stored for audit, never parsed. *(shipped)*

| tier | meaning |
|---|---|
| `user_confirmed` | you checked it. Proof-grade. |
| `model_asserted` | quote real, calibrated score cleared your threshold |
| `attested` | passage-proof and citable with passage scope: quote states the tie, verbatim in its cited chunk, both names in that chunk; below keeper, above provisional |
| `provisional` | below threshold, kept with score and evidence |
| `rejected` | fabricated quote, unknown entity, same person twice |

Answers show provenance: *confirmed by you*, *attested (passage-level)* with quote plus passage scope, or *the model, 0.78*, with the quote underneath. Keeper-grade is frozen: sentence-level proof or your word. Attested never promotes a row by itself — it only marks passage-proof rows citable.

A model's confidence is an opinion until checked. Labelled rows to check against: 226 gold rows, 30 human labels, 30 delta rows, 78 shared pairs. Group by predicted band (0.5–0.6, 0.6–0.7, …), compute observed support per band, and where a band lies apply a fixed correction table — measured once, tested once, stored in one place. Same procedure judges the combination formula: independent evidence accumulates as `score = 1 − Π(1 − sᵢ)` — one thin 0.4 mention scores 0.40 (no bank); two same-scene 0.4+0.35 score 0.61 (no bank); two independent 0.4+0.8 score 0.88 (banks); one explicit 0.95 banks; three damped weak 0.2s score 0.49 (no bank). A sentence cited for more than three distinct pairs gets each contribution halved — the measured catch-all failure. If the formula doesn't beat raw confidence on the same rows, it earns nothing. **Outstanding: published calibration table, full-bank re-measurement at threshold.**

## 5. Sweep and views

`lore sweep` walks each character's mentions in reading order, asks for line numbers, fetches quotes by index, and files derived pairs as proposals — never `canon_relation`, never overwrites, skips keeper pairs. 77 characters → 133 proposals (122 distinct pairs), 132 verbatim, but nine in ten quotes name one person: a queue filler, not proof. Run-to-run agreement is 59% on *who* is connected, 25% on *what* the connection is — the label is the unstable part. Of 78 shared pairs adjudicated blind: 13 supported, 37 context, 19 identity failures, 9 unsupported; same-citation and different-citation pairs scored alike, so a shared sentence is no evidence of correctness. `lore relationships` / `lore proposals` collapse inverses and duplicate roster names into one pair line. `lore assess` scores existing rows in place (dry run by default). *(shipped)*

## 6. Evidence packets (built, not wired)

Scene requirements in (characters, required claims, constraints, timeline against canon event ids — ordering, not dates), deterministic selector, packet out. Three layers so ranking tests without a database: retrieval loads candidate events + entities + references; pure `selectEvidence(requirements, records)` normalises (lowercase, possessives stripped, stopwords dropped, small explicit stem table — `sorted`/`placed`→`sort`), filters, ranks, validates; `validatePacket` re-checks every id against the db because selector output is never trusted unwired.

Relevance and support are different axes: `support` entries need character overlap *plus* a non-name claim-token match; overlap alone reaches only `context` (background, never citable); failures become `gaps` (missing, never substituted). At most six support and six context entries per scene; reuse across scenes is allowed but one event supporting three-plus disjoint claims is flagged `suspiciousReuse`. The model contract: citations come from `support`, proposals get validated-or-rejected, gaps are not instructions to invent. Acceptance: the Sorting claim resolves to the Sorting event (never the Platform catch-all), divergence resolves to support or explicit gap, character-only matches never support, reuse rules hold, and nothing else in the system changes. Does not solve calendar chronology ("Halloween follows term start" needs its own representation) or entity duplication (the selector resolves through naming, never merges). Complete and tested; the planner still picks its own events, so scene grounding is unchanged — wire it before touching planner prompts.

## 7. Threads, notes and open ends *(shipped)*

The evidence web's first layer is structure only. Migration 20 adds `canon_thread` (one persistent investigation per person and per co-occurring pair, linked to its `canon_pair_thread`, carrying identity, type, status and nullable parentage reserved for later births), `canon_thread_passage` (ordered passage history), `canon_thread_note` (the immutable clue: passage, exact quote, claim, kind, strength 0–1, why, what is missing) and `canon_open_end` (question, origin, what would resolve it, status, and a resolution link). `lore threads --sync` builds the records mechanically with no model call: on the trial copy it created 182 person threads and 3,307 pair threads (3,489 total, 0 open ends), and a second run created none.

Notes are insert-only — no update or delete path exists. A correction is a new row whose `supersedes_note_id` points at the note it corrects, and the original keeps every byte it was written with. Resolving an open end records status, time and the resolving note without editing that note; it is idempotent, first resolution wins. An empty thread means "no evidence gathered yet", never "no relationship". `lore threads` orders by evidence richness (notes, then the longest-open question, then id) and `lore thread <id>` shows the detail view; `threadsForRead` is a read-only helper for a later reader and is deliberately not wired into extraction or retrieval. Sync writes nothing to `canon_relation`, `canon_tie_note` or `canon_tie_hint` (336 / 98 / 0 before and after). **Meetings, births, scoped sharing and the map are not built.**

### Meetings, scoped sharing and births *(shipped)*

Migration 21 adds `canon_meeting`, `canon_meeting_exchange`, `canon_meeting_resolution`, `canon_birth`, `canon_thread_note_ref` and a `carried_from_open_end_id` column on open ends. It also scopes M1's identity key to root threads (`WHERE parent_a_thread IS NULL`) and gives born threads their own lineage key, because a child always shares its subject with a parent and could otherwise never exist; every pre-existing row is a root, so root protection is unchanged.

Matching is structural and deterministic: `person:<id>` gathers that person's thread with every pair thread naming them, and two pair threads sharing exactly one endpoint; `pair:<lo>:<hi>` gathers two threads about one unordered pair, which becomes reachable once a birth creates a child pair thread. Claim-meets-evidence is pair-scoped in this schema, so it arrives as `shared_pair`; there is no fuzzy identity, no name-string matching and no merge. Every meeting normalizes `thread_a < thread_b`.

Sharing is scoped by the thread's kind: person threads supply `identity` notes, pair threads `pair` notes, and the scope is stored on every exchange row. **Identity notes may resolve a want and inform a meeting but never contribute to a birth's score and never become pair evidence.** A want resolves on the spot when a note from the other thread shares at least two significant tokens with the open end's "what would resolve it"; the matched tokens are recorded, and this is a disclosed heuristic, not semantics.

A meeting births at most one child, first rule that fires: `resolved_want` (a want answered by pair-scope evidence), `pooled_evidence` (combined independent support `1 − Π(1 − sᵢ)` clears the project's `minConfidence` while each parent alone does not), or `shared_event` (both parents cite the same `canon_event` through their notes' chunks). Independence: same chunk counts once at max strength, an adjacent chunk counts at half, duplicates never inflate. Guards: at least one contributing note from each parent, one child per meeting, one birth per lineage and trigger, and below-threshold or one-sided evidence is refused and tallied. The child is a new thread with both parents recorded, references pooled notes through `canon_thread_note_ref` instead of copying them, carries both parents' wants with `carried_from_open_end_id`, and never merges entities or writes `canon_relation`. Reruns with the same evidence create nothing and leave `revision` alone; new evidence appends exchanges and bumps it once; a changed resolution appends a row and marks the earlier one `superseded_by`, preserved.

On the trial copy the matcher examined 209,097 candidate thread pairs. The copy holds no thread notes yet (notes are gathered by reading, not by sync), so the run recorded 0 meetings, 0 exchanges, 0 resolved wants and 0 births, and a second and third run added nothing; `canon_relation` / `canon_tie_note` / `canon_tie_hint` stayed at 336 / 98 / 0. Every trigger and guard is pinned by purpose-built tests. **Meetings, births, sharing and the map are now built as structure; the map is still not built.**

### Note ingestion *(shipped)*

Migration 22 gives `canon_thread_note` a `dedupe_key` — `sha256(normalised quote + '|' + normalised claim)` — with a partial unique index on `(thread_id, dedupe_key)`. Rows written before this milestone keep the empty key and are exempt, so the index never collides with history. Re-reading a passage adds nothing; a genuinely different claim about the same quote is a different key and is allowed, because one quote can support more than one observation.

`lore notes-ingest [--dry-run]` seeds notes from what the bank already holds: every `canon_relation` row at any status becomes a pair note with `strength = confidence` (provisional and needs_review keep the reason they are held in `missing`), and `canon_entity.evidence` becomes an identity note when it sits in the entity's first chunk. Held-aside clues are clues, so nothing is filtered by status. The **verbatim gate** is absolute: a note is written only when its quote is byte-for-byte inside the chunk it cites, so a fabricated or repaired quote never becomes a note — it is counted and skipped. A relation that does not settle its question opens one ("does the text establish `<kind>` between A and B?"), and any thread with no notes and no question gets "what evidence connects …?"; both are deduped by thread and question.

The same code sits behind `noteFromExtraction`, called after each extraction window commits, so future runs feed the web automatically. It is fenced in a try/catch that logs and continues: note ingestion can never fail an extraction. Ingestion creates the thread a clue needs when extraction has just produced the entity or pair, which is why a first extraction works without a separate sync.

Identity and context notes are clues, not relationship evidence. Context notes (co-presence: two literal names in one passage, capped per window) carry `is_context = 1` and strength 0, and both are excluded from birth scoring — a meeting shares them and may let them answer a want, but they never pool into a birth. `starvedThreads` exposes threads with nothing gathered or a question older than a threshold; window selection is deliberately unchanged and nothing calls it yet.

On the trial copy: 471 notes written (269 pair, 202 identity, 0 context), 196 skipped as not verbatim and 29 as having no chunk, 3,598 open ends, and 243 pair threads created for relation pairs that never shared a passage. A second ingest added 0 notes and 0 open ends. The first `lore meet` then held 27,858 meetings and 44,021 exchanges from those notes; 23,294 meetings were skipped as one-sided and 2 as below threshold, 0 births fired (a single pair thread plus a person thread never supplies two sides of pair evidence), and further runs added nothing. `canon_relation` / `canon_tie_note` / `canon_tie_hint` stayed at 336 / 98 / 0, and every note audits as verbatim.

### Note wording, routing and strength provenance *(shipped)*

A note's `claim` states the assertion in words, never the wrapper `<From> and <To>: <kind>`. The rule, in order: the stored `why` when it reads as a sentence (four words or more), else the passage sentence that names both people, else a kind phrase — and that last form only when the kind is one of the closed concepts. When none of those produces anything, the note is skipped and counted as `no-assertable-claim`, so the information is never replaced by a template.

Attribute facts are routed to the person they are about. If either endpoint of a relation is not a `character` (a species, faction, item, location, rule, creature), no pair note is written: the observation lands on the character endpoint's person thread as an identity note with `non-person-endpoint` in `missing`. If neither endpoint is a character, nothing is written and `no-character-endpoint` is counted. A verb is never a kind — `was`, `had`, `is`, `has` and the empty kind write no pair note; the property is kept as an identity note on each person the quote names, and `verb-kind` is counted. The verbatim gate, the dedupe key and the attribute/verb rules above are unchanged by anything that follows.

`strength_source` records where a note's number came from: `assessed` when a stored model assessment set it, `derived` when the code inferred it from the evidence's shape, `context` for co-presence. Existing rows read `default`.



### Time-scoped pair threads and meeting admission *(shipped)*

Migration 23 adds `period_label`, `period_from_seq`, `period_to_seq` and `temporal_status` (`current` | `historical` | `unknown` | `uncertain`) to `canon_thread`, and replaces the root identity key with one that includes the period, so a pair can carry apprentice-early and enemy-later as two true investigations. Existing rows all hold `period_label = ''` and keep their guarantees; a duplicate root pair in the *same* period is still refused.

`syncThreads` derives periods from the pair's shared passage seqs, in code and with no model: sort them, cut wherever the gap to the next shared passage exceeds **`PERIOD_GAP_SEQS = 40`**, and label the runs `p1`, `p2`, … Everything before the last run is `historical`, the last is `current`. A pair with no such gap keeps the legacy single identity — empty label, `unknown` status — so old rows are not churned; a pair that later splits gains period threads and never loses the earlier one. `lore threads` shows the period and takes `--period p1` (bare `--period` selects the legacy single-stretch threads). Notes attach to the period whose `[period_from_seq, period_to_seq]` contains their passage, falling back to the nearest period; with one thread for the pair, behaviour is exactly as before.

Meetings now need something to cross. A candidate is recorded only when **both sides contribute a `pair`-scope note relevant to the subject**, or when one side's note resolves the other's want. Otherwise nothing is written — no meeting row, no exchanges — and the refusal is counted as `no-crossing-notes`, `one-sided` or `identity-only`. Identity-only meetings are off by default (`runMeetings({ includeIdentityOnly: true })` is the opt-in; the CLI never sets it). Because a refused candidate writes nothing, a later run with new evidence admits it once, and only once. `combineSupport`, the triggers and their guards are unchanged.

`lore meet --reconcile` reports how many already-recorded meetings the rule would now refuse, and `--reconcile --write` deletes those meetings with their exchanges and resolutions in one transaction. It refuses `--write` unless the database is under the OS temp directory, and it never touches a note, a relation or an open end.

On a fresh trial copy: `--sync` created 6,267 pair threads (4,200 of them later periods), note ingestion wrote the same 471 notes, and the first `lore meet` recorded **2,389 meetings and 6,687 exchanges** — against 27,858 and 44,021 before the rule, a 91% cut — refusing 1,171,902 candidates (`no-crossing-notes` 1,095,061, `one-sided` 76,841). Three meetings were skipped as below threshold, 0 births fired (accepted rows already clear the bar on one side, so the pooled trigger has nothing new to add), and a second run added 0 meetings and 0 exchanges. Reconcile on that copy reports 0 refusals, because everything in it was admitted under the rule; on the earlier over-dense copy it reports 26,248 of 27,858 meetings refused (`one-sided` 23,294, `identity-only` 2,954), which is the scale of the mesh the rule replaces.

### Identity normalisation, collisions and honest strength *(shipped)*

Both apostrophes are one character now. `canonicalName` (and the sweep's tokeniser) folds U+2018 and U+2019 to a straight quote before any filtering, so `Shi'ido` and `Shi’ido` canonicalise, relate and match identically. Previously the curly form fell through the punctuation filter and became two words, which is how one name became two entities. Stored rows are untouched.

`lore identity-check [--write]` groups every entity by canonical form across its name and aliases and flags any form held by more than one entity, whether the kinds agree or not. It sets `review_status = 'needs_review'` and `quarantine_reason = 'identity-collision: <other ids>'` and nothing else — never a merge, a rename, a kind change or a delete — and rows already `quarantined` are skipped. The pass is idempotent: a rerun flags nothing new and reports the rows it already marked. It is a dry run unless `--write` is given.

A note's strength now comes from its evidence, never from a default of one: an assessment's stored `strength` when there is one (`assessed`), otherwise the quote's own shape — a tie stated about both people 0.9, a one-sided mention 0.35 — and mere co-presence becomes a context note at 0.2 (`context`). Context notes stay in the web as clues but are excluded from pair evidence and birth scoring. An open end is created only for a non-context note below the project threshold, so context never manufactures a question. Identity notes take their claim from the entity's stored evidence (then its summary) and are skipped as `no-identity-evidence` when there is neither, which retires the old "is recorded as &lt;kind&gt;" template that only restated our own column.

## 8. Rules future work must obey

- No automatic `accepted` from a pronoun binding — even the best binders err one time in five, silently. Confirmed bindings become `user_confirmed`.
- Free recall, gated banking: prompts stay exhaustive; only proven rows bank.
- Precision of any guard change is measured on rows the new rules alone admit, adjudicated blind — never the historical accepted set.
- Titles strip from both sides and match as a contiguous run containing the surname; "Aunt Petunia" never proves a tie to whoever stands next to her, and a title alone leaves direction unknowable.
- Scene → event is schema, not pipeline; context notes are a separate index, never evidence.
- No book terms in `fanfable/src` or `testing/tests`; no runtime dependencies; ship ceiling 8GB VRAM, one model slot.
- Never relax proof to raise counts; never add kinds for a yield of two rows; never build tiers on weak sampling; never treat a relationship word as proof; never let a model set a status; never splice quotes to fit.

## 9. Key measurements behind the design

| what | result |
|---|---|
| guard, 855-candidate pool | 30 admitted → 3, all three adjudicated genuine; the 25 removed were all scenes (6 judge-called-lasting were wrong-kind: aunt/uncle banked where text states cohabitation) |
| kinds eval (qwen3.5:9b ×3) | 6/6 stable mappings, 0 false, 0 wrong pairs |
| no-relation control (ARF) | 50 negative chunks → 2 proposals (4%); 50 positive → 42% recall |
| 30-row blind adjudication | 7 supported (23%), 23 context; mechanism: action verbs + coordinated lists; zero false facts (pairs real, evidence not) |
| reader (10 priority windows ×9 models) | `qwen3.5:9b` Q4 only repeatable producer (~1 guard-eligible keeper/10 windows); Q4 is the quantization floor; NuExtract strict matched it once inside 4× rows |
| judge (42 blind rows) | 0.83 precision / 0.68 recall counting reinforcement; 14% run-to-run flip |
| bank (trial book) | 164 relations: 23 user_confirmed, 1 accepted, 122 provisional, 18 needs_review; queue 258 notes; 392 canon events |
| extraction (9B, partial 31/66 windows) | 91 relations, 48 facts |
