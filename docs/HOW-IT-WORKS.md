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

## 7. Rules future work must obey

- No automatic `accepted` from a pronoun binding — even the best binders err one time in five, silently. Confirmed bindings become `user_confirmed`.
- Free recall, gated banking: prompts stay exhaustive; only proven rows bank.
- Precision of any guard change is measured on rows the new rules alone admit, adjudicated blind — never the historical accepted set.
- Titles strip from both sides and match as a contiguous run containing the surname; "Aunt Petunia" never proves a tie to whoever stands next to her, and a title alone leaves direction unknowable.
- Scene → event is schema, not pipeline; context notes are a separate index, never evidence.
- No book terms in `fanfable/src` or `testing/tests`; no runtime dependencies; ship ceiling 8GB VRAM, one model slot.
- Never relax proof to raise counts; never add kinds for a yield of two rows; never build tiers on weak sampling; never treat a relationship word as proof; never let a model set a status; never splice quotes to fit.

## 8. Key measurements behind the design

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
