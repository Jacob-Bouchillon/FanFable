# FanFable — full system report

**Date:** 2026-10-29
**Branch:** `experiment/evidence-scan` (one commit ahead of `main`; later work uncommitted)
**Tests:** 519 passing, `tsc` clean
**Purpose of this document:** the whole system as it stands — every subsystem, how evidence is decided, what was measured, what is broken, and what comes next. It supersedes the two session reports for orientation; those remain for the detailed experiment logs.

---

## 1. What the system is

FanFable turns a book into a **bank of proven claims** and writes fanfiction from it. The bank, not the raw text, is what the story pipeline treats as canon.

Three rules shape everything:

1. **Canon is evidence.** A tie between two people is banked only when text from the source proves it. Everything else is parked and visible to a human.
2. **The model proposes; the system decides.** No model can set a keeper status. Models produce candidates; deterministic code decides.
3. **Local by default.** A user's book never leaves the machine unless they explicitly configure a cloud provider.

### Constraints

| Constraint | Value | Consequence |
|---|---|---|
| Ship VRAM | 8GB | reader must fit with headroom; 6.1GB is the current high-water mark |
| Ship concurrency | 1 | one model slot on user hardware |
| Dev box | 16GB VRAM, 30GB RAM | two parallel decode slots, measured |
| Runtime dependencies | none | Node built-ins plus SQLite |
| Universality | no book terms in `fanfable/src` or `testing/tests` | book knowledge lives in data, fixtures and `testing/trials/` |

---

## 2. Architecture

```
CLI / web UI
     │
     ▼
controller.ts   the only component that opens the database, reads sources, calls a model
     │
     ├── lore.ts / lorebook.ts        canon: import, extraction, verification, bank
     ├── graph.ts / retrieval.ts      knowledge graph, PPR, passages, receipts
     ├── planner.ts                   premise, divergence, outline
     ├── writer.ts                    chapter prose
     ├── continuity.ts                prose against canon and state
     └── memory.ts                    AU state, chapters, character knowledge
     │
     ▼
llm.ts          one interface: Ollama │ llama.cpp │ OpenAI-compatible
```

The controller being the single gate is what makes the evidence rules enforceable in one place and the pipeline testable.

### Module inventory

| Module | Lines | Role |
|---|---:|---|
| `lorebook.ts` | ~7,900 | extraction, quote verification, tiers, promotion guard, roster, scan, notes |
| `graph.ts` | 2,594 | graph, PPR, passage trails, graph checks |
| `cli.ts` | ~1,930 | every capability, scriptable |
| `memory.ts` | 1,440 | AU state, chapters, knowledge |
| `controller.ts` | 1,075 | orchestration, single DB/model gate |
| `server.ts` | 1,020 | local UI over the same controller |
| `continuity.ts` | 625 | contradiction and denial checks |
| `lore-ask.ts` | 606 | canon answers with citations and a guard |
| `writer.ts` | 584 | sequential writing with context requests |
| `text.ts` | 540 | chunking, windows, text utilities |
| `schema.ts` | 525 | canonical schema |
| `llm.ts` | 503 | providers, JSON mode, keys |
| `planner.ts` | 482 | outline and divergence |
| `retrieval.ts` | 454 | unified retrieval |
| `migrations.ts` | ~450 | forward-only migrations |
| `embeddings.ts` | 333 | local embeddings for dense seeds |
| `graph-checks.ts` | 359 | contradictions only a graph sees |
| `rule-checker.ts` | 303 | ~20 deterministic rules, flags only |
| `state-conflicts.ts` | 296 | chapter-vs-state conflicts |
| `importer.ts` | 290 | PDF/EPUB/DOCX to text with page markers |
| `dev-summary.ts` | 276 | read-only dev data |
| `recognition.ts` | 183 | dense seeds without lexical backing |
| `names.ts` | 182 | one canonicaliser, two name policies |
| `json.ts` | 176 | tolerant JSON extraction |
| `chain-handoff.ts` | 140 | logbook JSON: windows, thin names, pairs |
| `search-policy.ts`, `edge-rank.ts`, `continuity-settings.ts`, `premise-check.ts`, `lore-*` | 100–400 each | shared policy and lore splits |

---

## 3. The canon pipeline

### 3.1 Import and chunking

`importer.ts` turns a source into text with page markers. `text.ts` chunks it into passages with `seq` and a locator.

Two chunkers exist. The old one produced 1,448 passages for the test book by duplicating text; the rebuilt one produces 738 (and 527 for a shorter book). The live bank still uses the old chunker. Every experiment this session used the rebuilt one.

### 3.2 Windows and selection

Extraction reads windows of 8 consecutive passages (~1,500 words). A budgeted run picks windows by priority (`bridge×50, names×10, relations×10`), so a ten-window sample is the densest part of the book, not a representative slice.

### 3.3 Extraction calls

The split extractor makes three narrow calls per window — entities+facts, relations, events — rather than one large call. A 7–9B model handed four schemas answers the first and rushes the rest; three calls each produce a complete answer, and a failed section costs only that section.

The relations schema: `from`, `to`, `kind`, `description`, `chunk_index`, `evidence`, `modality`, and since this session `kind_source` (the words in the quote that express the relation).

### 3.4 Quote verification

Every quote is checked against the cited passage, locally and without a model:

| Counter | Meaning |
|---|---|
| verified | the quote is in the cited passage |
| repointed | found in a neighbouring passage; reference corrected |
| dropped | found nowhere |
| unresolved | endpoint not in the bank |
| unrelated | quote does not concern the endpoints |
| moment | one-off event presented as a tie |
| redundant | duplicate |
| unsupported | tie word absent |
| hinted | co-occurrence hint kept |
| retried | strict-mode both-name retry |

### 3.5 Promotion guard

`canPromote()` is the single gate. A row becomes a keeper only when all hold:

1. closed, relationship-grade kind;
2. no PARK ruling on the pair or its inverse class;
3. quote verbatim in its cited passage;
4. both endpoints named in the quote;
5. tie word present and direction not reversed;
6. **new this session:** the sentence grammatically links the two endpoints through the kind — possessive, of-phrase, subject-verb-object, or a returned anchor sentence — and the two are not the same identity.

Condition 6 is the biggest change of the session. Before it, "Aunt Petunia took Dudley to London" proved an aunt tie.

### 3.6 Tiers

| Tier | Meaning | Visible in answers |
|---|---|---|
| `accepted` | proven by the guard | yes |
| `user_confirmed` | a human ruled | yes |
| `provisional` | plausible, unproven | no |
| `needs_review` | parked with a reason | no |

`confirmed_by_user` survives status changes. Ten unprovable keepers are quarantined, not deleted.

### 3.7 Identity

Two deterministic checks:

- **Nested names.** Two character rows whose names nest ("X" inside "Captain X") are one person; ties between them are refused.
- **Suspect characters.** A character admitted from one mention, with no alias, whose name also occurs lowercase in the book, is quarantined (`review_status = 'quarantined'`) and excluded from scanning and promotion until a second mention or a real alias appears.

Not solved: the same person still appears as several rows, aliases are sometimes wrong, and titles are baked into names ("Aunt Petunia" is one entity name).

### 3.8 Notes

`canon_tie_note` stores parked claims with a reason. This session added span accumulation and `resolveAccumulatedNotes()`: a note holds every span found for its pair, and at the end of extraction it is promoted if the spans together name both people, one span states the tie, direction is not reversed, and no ruling applies.

Measured result: 0 of 125 notes promoted. The span carrying the tie word never contained both names; the spans with both names never carried the word.

### 3.9 Anchors and page evidence

- `pageEvidenceText()` widens the evidence area to the cited page. Alone it changed almost nothing (+0–1 eligible).
- `anchor_evidence` (migration 18) stores the sentence that asserts a tie when the quote is context only. The guard runs the assertion test on the anchor **or** the quote, never on the union, so an anchor that merely names both people proves nothing.

### 3.10 The sentence scan

`scanSentenceCandidates()` finds every sentence that names two characters and contains a relationship word, requiring the two names within 25 tokens and a tie phrase within 10 of that run. It cut 1,925 raw candidates to 62–126 per book.

`verifySentenceCandidates()` asks one narrow question per candidate and files accepted rows through the guard. Acceptance was 15–20 per book; a blind pass found **13 of 57 anchored acceptances supported (23%)**.

---

## 4. Retrieval and answering

`retrieval.ts` assembles one context from passages (FTS5), the graph, story memory and character knowledge. `graph.ts` provides PPR, a recognition filter for dense seeds without lexical backing, and passage trails (six steps) that record *why* a passage was surfaced.

`lore-ask.ts` answers canon questions. It is the only path allowed to state a relationship, and it enforces: the tie must exist in the bank, citations are verified, and `FANFABLE_NO_GUARD=1` exists only for experiments.

---

## 5. Story pipeline

- **Planner** — premise, AU divergence, structure, chapters, arcs. Known defect: `selectCanonEvents` picks canon events by word overlap, so it can anchor to the wrong event; outlines cite nothing.
- **Writer** — sequential chapters from the plan, with structured mid-draft context requests, de-duplicated and capped.
- **Continuity** — checks prose against outline, previous chapters, canon and AU state; detects a chapter denying a banked tie; model findings without chapter evidence are dropped; default severity `warning`; notes stored and shown with `issues --all`.
- **Memory / state conflicts** — AU timeline, character knowledge; contradictions between a new chapter and established state are recorded, not resolved.

---

## 6. Model access

| Provider | Endpoint |
|---|---|
| `ollama` | `{base}/api/chat` (default) |
| `llamacpp` | `{base}/v1/chat/completions` |
| `openai` | `{base}/v1/chat/completions` |

JSON mode maps to `format: 'json'` or `response_format`; `seed` passed when configured; API keys withheld from loopback. An `openai` base URL must be `https://openrouter.ai/api` because the client appends `/v1/chat/completions`.

---

## 7. What was measured

### 7.1 Reader comparison, ten priority windows

| model | relations | closed | both named | tie word | guard-eligible | time |
|---|---:|---:|---:|---:|---:|---:|
| qwen2.5:7b Q4 | 28 | 14 | 1 | 16 | 0 | 3m50 |
| qwen2.5:7b Q8 | 15 | 2 | 3 | 12 | 0 | 6m06 |
| qwen3:8b | 15 | 8 | 3 | 9 | 0 | 6m41 |
| llama3.1:8b | 15 | 10 | 1 | 5 | 0 | 8m13 |
| qwen3.5:9b Q4 ×3 | 22/26/37 | 11/17/23 | 6/5/10 | 13/13/16 | 1/1/1 | 5m31–5m59 |
| qwen3.5:9b Q3 ×2 | 11/9 | 5/5 | 1/4 | 7/5 | 0/1 | 4m07–4m17 |
| NuExtract3 default | 83 | 11 | 12 | 43 | 0 | 7m12 |
| NuExtract3 strict | 99 | 95 | 10 | 11 | 2 | 5m17 |
| NuExtract 1.5 | 8 | 0 | 1 | 5 | 0 | 6m58 |

Verdict: qwen3.5:9b Q4 is the reader; Q4 is the quantization floor; NuExtract is a span-copier with poor schema and identity discipline.

### 7.2 Full books

| run | relations | closed | both named | eligible | time |
|---|---:|---:|---:|---:|---:|
| book A, before fixes | 221 | 101 | 63 | 2 | 47m44 |
| book A, second model | 759 | 709 | 167 | 7–9 | 42m05 |
| book B, before notes | 125 | 124 | 21 | 3 | 34m31 |
| book B, with kind_source | 116 | 110 | 3 | 1 | 32m46 |
| book B, second model | 344 | 323 | 12 | 8 | 24m05 |
| book B, with notes | 113 | 108 | 14 | 2 | 33m52 |

Variance is large: same model, same book, 21 versus 3 both-named quotes.

### 7.3 Gold set (226 rows, blind)

| group | n | supported | context | rate |
|---|---:|---:|---:|---:|
| accepted | 42 | 8 | 2 | 19% |
| candidates | 184 | 18 | 11 | 9.8% |

Independently confirmed by the 30-row human labels (5/30 = 17%) and a separate blind judge (7/42 = 16.7%).

### 7.4 Assertion guard

| rule | kept | true kept | precision | recall |
|---|---:|---:|---:|---:|
| before assertion | 42 | 8 | 19% | 100% |
| assertion + distinct mentions | 15 | 4 | 36% | 50% |
| strict (link always) | 1 | 1 | 100% (n=1) | 12.5% |

### 7.5 A strong reader, whole book (development only)

One 1M-context session read a 56,000-word novel in one pass (~$0.05):

- 34 characters, 28 relationships, 26 quotes verbatim;
- **1 of 28 named both people in the quote**;
- the rest use a pronoun or title ("his wife", "my best friend", "Gatsby's father").

A pair probe over 43 co-occurring pairs returned 13 ties and 30 "none" — a higher conversion than any generator, same evidence shape.

### 7.6 The local name sweep

Deterministic ledger per character, batched by 60 sentences, model returns **line numbers**, sentences retrieved by index.

- Ron: 525 mentions, 9 batches, 8 ties, **8 verbatim**, 46 notes.
- Ginny: 57 mentions, 1 batch, 1 tie, inherited from Ron's notes; she had no entity until created from them.
- Line references removed the paraphrase problem: before them, 26 of 53 note quotes were not in the book.

The sweep is the first local method that produces correct, quote-backed ties. Its weaknesses: ties fluctuate between runs (3/2/1/0 across earlier variants), notes can propagate errors, and coverage is limited by the roster (79 characters; one had to be invented).

### 7.7 Costs

| operation | cost | time |
|---|---|---|
| whole-book cloud read | ~$0.05 | ~10 min |
| 43-pair probe | ~$0.05 | ~8 min |
| local sweep, major character | $0 | ~40 s |
| local sweep, all 79 (estimate) | $0 | 20–40 min |

---

## 8. Current state of the bank

Live bank (`testing/trials/halfbook-run/plagueis-half.db`, old chunker, 1,448 passages):

| item | count |
|---|---:|
| entities | 360 |
| ties | 336 |
| facts | 573 |
| events | 588 |
| pending notes | 73 |

Passes `lore integrity`. Ten quarantined keepers stay provisional with confirmations preserved. Eighteen parked rows remain unquotable.

---

## 9. Open problems, ranked

1. **Ties are stated with pronouns.** Every measurement confirms it. Any rule requiring both names in one sentence caps recall at ~12%.
2. **The guard now accepts almost nothing.** Strict precision is 100% on a sample of one. The gap is anchor coverage, not evidence quality.
3. **Identity.** Duplicate characters, bad aliases, titles inside names, ordinary words as people. All of it corrupts both candidate generation and proof.
4. **Stability.** The sweep's tie list changes between runs; the extraction's both-named count swings 7×.
5. **Coverage.** The roster misses characters the text names, including one the sweep itself discovered.
6. **Notes propagate errors.** Transfer works; it is also a path for a wrong reading to spread.
7. **Ship headroom unmeasured.** 6.1GB on a 16GB card is not 6.1GB on an 8GB card with a compositor.

---

## 10. Next steps

1. Finish the two frozen sweeps and compare claim by claim (shared, run-only, same-sentence, different-sentence).
2. Blind-adjudicate the union: agreement is stability, not truth.
3. Fill the anchor gaps the strict rule exposed: pronoun possessives, kin-group nouns, wider "with" phrases.
4. Complete the roster: entity intake for names the extraction missed.
5. Only then consider a trained verifier, using the 226-row gold set.

---

## 11. Reproduction

```bash
# extraction, ten priority windows
npm run fanfable -- --db <db> --project ab lore extract --model qwen3.5:9b --max-windows 10

# evidence check
npm run fanfable -- --db <db> --project ab lore integrity

# sentence scan (both names, one sentence)
npm run fanfable -- --db <db> --project ab lore scan --max 100

# score and audit
node --experimental-strip-types testing/trials/model-ab/metrics.ts <db> ab
node --experimental-strip-types testing/trials/model-ab/guard-audit.ts <db> ab

# name sweep (trials)
node --experimental-strip-types testing/trials/adjudication/name-sweep.ts <db> qwen3.5:9b 1 60 Ron out.json
node --experimental-strip-types testing/trials/adjudication/compare-runs.ts <db> run-1.json run-2.json
```
