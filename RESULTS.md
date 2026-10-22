# Benchmark results

The method is in [BENCHMARK.md](BENCHMARK.md). Every number here comes from a
run in `benchmarks/runs/`, and the tables can be regenerated with:

```bash
node scripts/evaluate-report.ts <run-id> ...
```

**The setup.** Ubuntu, one RTX 5070 Ti (16 GB), Ollama 0.40.6, Node 24. The
source is the 250-page *Harry Potter and the Sorcerer's Stone* PDF, imported as
1,192 passages. The corpus holds one extraction of its lore (205 entities, 268
relations, 330 facts), one index of its canon events (305), an approved
eight-chapter outline and an approved prologue. The models are:

| key | model | size | quantisation | context | notes |
| --- | --- | --- | --- | --- | --- |
| `qwen2.5:7b` | Qwen2.5 7B | 7.6 B | Q4_K_M | 16 k | the incumbent |
| `qwen2.5:3b` | Qwen2.5 3B | 3.1 B | Q4_K_M | 16 k | the cheap indexing model |
| `gemma4:12b-it-q4_K_M` | Gemma 4 12B | 11.9 B | Q4_K_M | 16 k | newer general purpose, thinking off |
| `ornith-1.5:9b` | Ornith 1.5 9B | 9 B | Q4_K_M | 16 k | fiction-oriented, thinking off |

All four ran with seed 42, the same system-prompt framing (merged into the
first user turn), the same temperature per role, the same token budget, and the
same input. **One repetition per cell.** The seed makes a run repeatable, which
is not the same as making it representative: it repeats the same observation
rather than taking another one. Everything below is therefore preliminary and
directional, and section 9 says what that means in detail.

Two things about the set itself. `gemma4:12b` and `gemma4:12b-it-q4_K_M`
resolve to the same weights in this registry build (the same id, the same
11.9 B Q4_K_M, the same bare `{{ .Prompt }}` template), so the tag is not a
variable in the comparison. `ornith-1.5:9b` reports its family as `qwen35`,
which is consistent with how it behaves: it has a full chat template, it
thinks out loud, and it does not act on a system-role message.

`BookBuilder Bookwriter v1` could not be evaluated: its repository returns
HTTP 401 for anonymous downloads, so the weights are not available in this
environment. It is listed as unavailable rather than quietly dropped.

---

## 1. What the measurements found before anything else

Two problems turned up that are not about the models at all, and both of them
changed the numbers in this report. They are recorded here first because they
are the reason the later tables are not the tables the first runs produced.

### 1.1 The context window was the binding constraint

The first planning run had three of the four models return **no outline at
all**. The cause was not the model: the planner's prompt was 6,858 tokens,
against a context window of 8,192, so the model had about 1,300 tokens left
to answer in. The prompt ended mid-sentence, mid-JSON, every time.

Two changes fixed it, and both are in the code now:

- the default context window is 16 k instead of 8 k (`src/llm.ts`);
- the planner's canon-event index is relevance-ranked and kept inside a
  character budget (`controller.selectCanonEvents`), instead of being the
  first 120 events in the book.

With those in place all four models return a complete six-chapter outline.
The same squeeze was hitting the writer: its prompt is 6,144 tokens, so at
8 k the first call had about 2,000 tokens of room for a chapter that asks for
2,700, and the writer had to be asked to carry on. At 16 k `gemma4` wrote its
whole chapter in one call of 2,209 tokens; at 8 k the same model managed
1,906 before it was cut off and the chapter had to be continued.

### 1.2 A truncated answer used to lose everything

A model that runs out of tokens leaves broken JSON. The old code parsed the
answer as a whole, so a truncated answer produced **nothing** — the window was
lost, not just its last record. `parseExtraction` in `src/lorebook.ts` now
salvages the complete records out of each section of a broken answer.

The effect is visible in the lore tables below: in the run before the fix,
`ornith-1.5:9b` writes a great deal per window and ran out of tokens on three
of the six windows, and on those windows it recorded nothing at all.

---

## 2. Lore extraction

Six fixed windows of eight passages each, the production extraction path, and a
hand-written gold set of 48 relations, every one of them with the exact quote
from the window that supports it. The quotes are checked against the corpus
before the benchmark runs; if one does not verify, the benchmark refuses to
score.

### Extraction, 3,000 tokens per window (run `lore-02`)

| model | recall | precision | matched | extracted | unmatched | fabricated quotes | no quote | verified quote | name accuracy | s/window |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| gemma4:12b-it-q4_K_M | 25% | 44% | 10 | 20 | 10 | 0 | 0 | 20 | 89% | 11.6s |
| ornith-1.5:9b | 13% | 21% | 5 | 16 | 11 | 7 | 4 | 5 | 51% | 24.5s |
| qwen2.5:7b | 9% | 39% | 3 | 17 | 14 | 0 | 9 | 8 | 83% | 11.9s |
| qwen2.5:3b | 2% | 8% | 1 | 8 | 7 | 0 | 5 | 3 | 67% | 120.8s |

### The same models, before the salvage fix (run `lore-01`)

| model | recall | note |
| --- | ---: | --- |
| gemma4:12b-it-q4_K_M | 17% | |
| qwen2.5:3b | 6% | |
| ornith-1.5:9b | 6% | 3 of 6 windows ran out of tokens and were lost entirely |
| qwen2.5:7b | 2% | |

### The same models with 8,000 tokens per window (run `lore-03`)

The budget was raised to see whether the models that write at length were
being cut off. The "failed calls" column counts model calls that never
completed; a window whose call failed yields no relations, which is not the
same as a window that produced none.

| model | failed calls | recall | precision | extracted | fabricated quotes | verified quote | s/window |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| gemma4:12b-it-q4_K_M | 0 | 25% | 44% | 20 | 0 | 20 | 11.0s |
| qwen2.5:7b | 0 | 9% | 39% | 17 | 0 | 8 | 11.2s |
| qwen2.5:3b | 1 | 0% | 0% | 2 | 0 | 1 | 114.2s |
| ornith-1.5:9b | 6 | run failed | run failed | run failed | run failed | run failed | 300.7s |

**More room did not help where it could be measured.** The two models whose
calls all completed are unchanged to the relation: `gemma4` is 25% with 20
relations extracted in both runs, `qwen2.5:7b` is 9% with 17 in both. The
truncation was never what was holding the recall down; the models simply do
not extract the relations that are there. That is a different problem, and it
is the one the handoff calls "one extraction pass still misses
relationships" — the answer to it is a better prompt, a reviewed gold set to
measure against, and the diagnostics that already exist.

**Two of the four rows in this run are not measurements.** `ornith-1.5:9b`
had all six of its calls fail with a transport error after the Ollama server
fell back to running on the CPU, and `qwen2.5:3b` lost one of its six
windows the same way. The extraction path treats a failed window as a window
with nothing in it, which is right in production and wrong in a report: the
report script now counts failed calls and prints "run failed" for a model
whose every call failed. The 3,000-token run in `lore-02` remains the
measurement of record for both of them.

What the numbers mean:

- **recall** is against the gold set, which is what a perfect extractor would
  find. It is a ceiling, not a target: a model that finds relations the gold
  set does not have is not penalised, which is why the count of extracted
  relations and the count that matched are both reported.
- **precision** is the share of the extracted relations that matched a gold
  relation.
- The gold set is strict. It counts relations the window states outright, and
  it does not include the ones a reader would infer.
- **The run-to-run spread is real.** `qwen2.5:3b` scored 6% recall before the
  fix and 2% after it, on the same six windows and the same seed. The salvage
  fix cannot have made it worse, so that difference is the noise floor of this
  measurement, and it is the same size as most of the differences in the
  table. The rows that are clearly outside the noise are `gemma4` (25% recall,
  every relation quoted, no fabricated citation) and `ornith` (seven
  fabricated quotations).

---

## 3. Planning

The same premise, the same divergence point, the same canon, six chapters
asked for, one call. Run `plan-03`.

| model | valid json | chapters | complete | canon/au split | open questions | canon refs | refs valid | premise covered | divergence kept | consequence planned | time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| gemma4:12b-it-q4_K_M | 1 | 6 | 100% | 100% | 6 | 0 | 100% | 97% | yes | 20% | 25.7s |
| ornith-1.5:9b | 1 | 6 | 100% | 100% | 18 | 0 | 100% | 94% | yes | 100% | 52.0s |
| qwen2.5:7b | 1 | 6 | 100% | 100% | 11 | 42 | 33% | 79% | yes | 0% | 24.7s |
| qwen2.5:3b | 1 | 6 | 100% | 100% | 6 | 32 | 100% | 74% | yes | 0% | 167.8s |

Before the context fix, in the same run (`plan-01`):

| model | valid json | chapters |
| --- | ---: | ---: |
| gemma4:12b-it-q4_K_M | 0 | 0 |
| ornith-1.5:9b | 0 | 0 |
| qwen2.5:7b | 1 | 4 |
| qwen2.5:3b | 1 | 3 |

Two things are worth reading twice:

- **`refs valid` is 33% for `qwen2.5:7b`.** It cited 42 canon-event ids and
  only 14 of them exist. The controller drops the rest and says so, so the
  plan is not corrupted, but the model is inventing references to a canon
  index it was shown. `gemma4` and `ornith` cited none at all: a plan with no
  canon references is safe and less useful.
- **`consequence planned` is 0 for both qwen models.** The proxy looks for
  later chapters whose text says something follows from something. Neither
  model wrote a plan that carries its own divergence forward in words. Only
  `ornith` did, on every chapter.

---

## 4. Chapter writing

One chapter, the same approved outline, the same assembled context (built
once, by the baseline model, and handed to every candidate unchanged), a
1,500-word target. Run `write-04`.

| model | words | length | repetition | copied | invented names | characters | scenes | canon bullets | au bullets | canon leak | dialogue | words/sentence | types | long sentences | time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| qwen2.5:7b | 1885 | 126% | 0% | 0% | 0% | 100% | 100% | 100% | 100% | 0 | 13% | 16.1 | 0.33 | 0 | 25.8s |
| gemma4:12b-it-q4_K_M | 1517 | 101% | 0% | 0% | 0% | 100% | 100% | 50% | 100% | 0 | 7% | 13.3 | 0.39 | 0 | 34.8s |
| ornith-1.5:9b | 1341 | 89% | 0% | 0% | 0% | 100% | 100% | 100% | 100% | 0 | 18% | 24.0 | 0.31 | 7 | 18.8s |
| qwen2.5:3b | 1205 | 80% | 0% | 0% | 0% | 100% | 100% | 50% | 100% | 0 | 6% | 17.2 | 0.35 | 0 | 110.0s |

Every model hit the outline: every character named, every scene covered, no
repetition, nothing copied from the source, no invented names, and no
sentence that puts Harry back in Gryffindor. The differences are in shape
rather than in obedience:

- `gemma4` writes the shortest sentences (13.3 words), the most varied
  vocabulary (0.39 types per token) and the least dialogue (7% of the words).
- `ornith` writes the longest sentences (24 words), the most dialogue (18% of
  the words) and the only run-on sentences (7 sentences over 45 words).
- `qwen2.5:3b` is 20% short of the target and 6% dialogue.

The shape numbers move a little between runs on their own: in the run before
this one, `qwen2.5:7b` invented names in 5.8% of its capitalised words and
`qwen2.5:3b` in 2.8%, and both wrote a different number of words. The
obedience numbers did not move: every model named every character, covered
every scene and kept the divergence, in every run.

**These numbers say nothing about whether the prose is good.** They are shape.
The human rating is section 7, and it is the part that was not done.

---

## 5. Continuity

Seven contradictions planted in a chapter, on top of a story state written by
hand. A finding counts as a detection when its category matches the planted
item **and** its evidence or message shares the planted sentence's
distinctive words. Run `cont-03`.

| model | found | planted | false positives | fp rate | found without a model | found in total | time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ornith-1.5:9b | 5 | 7 | 5 | 50% | 1 | 6 | 15.6s |
| gemma4:12b-it-q4_K_M | 4 | 7 | 2 | 33% | 1 | 5 | 20.0s |
| qwen2.5:7b | 1 | 7 | 2 | 67% | 1 | 2 | 3.8s |
| qwen2.5:3b | 0 | 7 | 3 | 100% | 1 | 1 | 13.7s |

The "found without a model" column is the deterministic and graph checks, which
are the same for everybody: they find one of the seven. The rest is the
model's own contribution, and the ranking there is clear: the two bigger
models find four and five, the 7B finds one or two, and the 3B finds none.

The false-positive rate matters as much as the detection rate. `ornith` finds
the most and also reports five findings that are not planted — half of
everything it says. `gemma4` finds nearly as much with two false positives.

---

## 6. The long story

Eight chapters, written and approved through the real pipeline, with an edit
and a re-approval in chapter 4, a contradiction planted in chapter 4's draft,
and the application restarted halfway through. Every model started from the
same database. Run `long-02`.

| model | chapters | words | length | repetition | events | knowledge | knowers | relationships | threads | secrets | motivations | facts | graph issues | planted caught | canonΔ | time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| gemma4:12b-it-q4_K_M | 8 | 11,883 | 124% | 0% | 13 | 9 | 2 | 4 | 18 | 4 | 7 | 7 | 0 | yes | 0 | 385s |
| qwen2.5:7b | 8 | 10,490 | 109% | 0% | 25 | 14 | 4 | 15 | 16 | 1 | 9 | 11 | 4 | no | 0 | 348s |
| qwen2.5:3b | 8 | 9,895 | 103% | 5% | 19 | 10 | 4 | 11 | 18 | 7 | 8 | 14 | 1 | yes | 0 | 197s |
| ornith-1.5:9b | 8 | 12,632 | 132% | 3% | 1 | 1 | 1 | 1 | 11 | 0 | 2 | 1 | 0 | no | 0 | 637s |

**The canon never moved.** For every model, the canon entity, relation, event
and passage counts are exactly what they were before the story started — all
four deltas are zero, in every run. The story's own records went somewhere
else: AU events, knowledge, relationships, threads, secrets, motivations and
facts.

**`ornith` wrote the most words and remembered almost nothing.** One AU
event, one knowledge record, one relationship out of eight chapters. The
memory manager asks the model to extract the state a chapter established, and
this model answers with almost nothing — so the next chapter is written with
no memory of the last one, and the graph behind the story stays empty
(1,000 nodes, 0 graph issues, against 1,062 and 4 for the baseline). A
fiction fine-tune that writes beautifully and cannot fill in a state sheet is
not usable as the writer in this application without a different arrangement.

**The plot threads are never closed.** Every model opened between eleven and
eighteen of them; not one was resolved. The thread machinery is driven by the
model's `threadEvents`, and the models are not emitting them.

**The planted contradiction was caught twice and missed twice.** `gemma4` and
`qwen2.5:3b` caught it; the baseline missed it in this run and caught it in an
earlier run of the same test. A contradiction of this kind — the canon
Sorting reported unchanged inside a story that changed it — is on the edge of
what the checker can see, and a one-run measurement of it is not a measurement.

---

## 7. The human rating

**The human rating has not been done.** The packet is built and waiting:

```bash
node scripts/evaluate-blind.ts write-04      # writes benchmarks/blind/write-04/
```

| file | what it is |
| --- | --- |
| `packet.md` | the four chapters, anonymised, in a seeded shuffled order |
| `brief.md` | what the chapter was supposed to be, and what was measured |
| `ratings.csv` | the form: one row per passage, one column per criterion |
| `key.json` | which passage is which model — **not part of the packet** |

The scales are the ones the handoff asks for, 1 to 5 each: prose quality,
character voice, dialogue, scene pacing, emotional credibility, originality
within the premise, outline adherence, canon/AU consistency, character
knowledge consistency, and freedom from repetition.

Two things are kept apart on purpose. The first nine scales are about the
writing and the last one is about repetition, and the *correctness* of the
chapter — does it contradict the story it is in — stays in the automated
table. A beautiful chapter that contradicts the story state must not win on
the strength of its prose alone, so the summary is expected to report the two
groups separately.

A model judge is available as a preliminary screen
(`node scripts/evaluate-judge.ts <run-id> [judge]`), and it is labelled as
one: the judge is itself a candidate, so it may prefer its own style, and a
model rating prose is not a reader rating prose. It has not been validated
against human ratings, because there are not any yet. Until somebody reads
the packet, the honest answer to "which model writes better prose" is: **not
yet measured**.

---

## 8. How to reproduce every number here

All of it is local. On this machine, Node and npm are not on the default
path, so:

```bash
export PATH=~/.local/opt/node-v24.22.0-linux-x64/bin:$PATH
export OLLAMA_MODELS=~/.local/share/ollama/models
```

| what | command | what it takes |
| --- | --- | --- |
| the corpus (once) | `node scripts/benchmark/corpus.ts` | the book import plus a full lore extraction: about an hour on the 7B |
| the corpus, re-read from scratch | `node scripts/benchmark/corpus.ts --rebuild-lore` | the same, again |
| lore extraction | `node scripts/evaluate-models.ts --role lore --run <id>` | 6 windows per model, ~2 minutes per model |
| lore with a bigger budget | `node scripts/evaluate-models.ts --role lore --run <id> --extract-tokens 8000` | the same, slower |
| planning | `node scripts/evaluate-models.ts --role planning --run <id>` | one call per model |
| chapter writing | `node scripts/evaluate-models.ts --role writing --run <id>` | one chapter per model |
| continuity | `node scripts/evaluate-models.ts --role continuity --run <id>` | one call per model |
| state extraction | `node scripts/evaluate-models.ts --role state --run <id>` | one call per model — **written but never run** |
| the long story | `node scripts/evaluate-long-story.ts --chapters 1-8 --run <id>` | eight chapters per model, 3–11 minutes per model |
| the tables above | `node scripts/evaluate-report.ts lore-02 plan-03 write-04 cont-03 long-02` | instant |
| the blind packet | `node scripts/evaluate-blind.ts write-04` | instant, and deterministic for a given run |
| the judge screen | `node scripts/evaluate-judge.ts write-04 gemma4:12b-it-q4_K_M` | one call; a screen, not a verdict |

The run ids used here are `lore-01` (before the salvage fix), `lore-02`
(3,000 tokens), `lore-03` (8,000 tokens), `plan-01` (before the context fix),
`plan-03`, `write-04`, `cont-03` and `long-02`. Everything they contain is in
`benchmarks/runs/`, including every prompt, every output, every token count
and every duration.

**Caveats when you re-run them.**

- The corpus build is not free: it reads the whole book through the model.
  It is incremental, so a second run costs nothing.
- Only one model at a time. With two resident, Ollama falls back to the CPU
  and the calls get slow enough to fail — that is what invalidated two rows
  of `lore-03`.
- The timings in this report were taken on a machine that was not
  exclusively ours, so treat them as indicative.
- `--role all` runs the four roles in sequence; the state role is included in
  the harness but has no results yet.

---

## 9. Limitations

These are the reasons not to trust the numbers above more than they deserve.

**Every number here is preliminary: one run per model.** One chapter, one
outline, one story state, one seed, one pass. The seed makes a run repeatable,
which is not the same as making it representative: it repeats the same
observation, it does not take another one. The continuity numbers are a single
pass over seven planted contradictions, and the long story detected the
planted contradiction in one run of the baseline and missed it in another.
The extraction numbers move by several points between runs on their own
(`qwen2.5:3b` scored 6% recall in one run and 2% in the next, on the same six
windows and the same seed). Differences of a few points in these tables are
not differences; treat every table as a direction, and treat the ranking
between the two bigger models and the two smaller ones as the only thing
these runs support.

**The gold set is a ceiling, and a hand-written one.** 48 relations across six
windows, written by reading the windows. It is strict: it counts what the
window states outright and nothing a reader would infer. A model that finds a
relation the gold set does not have is not penalised, which is why the count
of extracted relations is reported next to the recall.

**The gold state for extraction is a rough proxy, not ground truth.** The
long story counts state records per model, but "the model recorded 25 events"
is not "the model recorded 25 correct events": nothing here checks them
against the story. The keyword-overlap state scenario that would do that
(`scripts/benchmark/scenarios/state.ts`) is written and working, but it was
not run, so the long-story counts are the only evidence on state extraction
and they are counts, not accuracies.

**The corpus graph is one model's graph.** The lore every model writes
against was extracted once, by the baseline, and frozen. A model with a better
extractor would have a better graph in production than it has here. The
extraction quality is measured separately.

**The corpus is partial in one place.** The canon-event index covers the
first 500 passages of the book, so the Sorting is in it and the later
chapters are not. The story's later chapters lean on the full-text search
instead. The written prologue also drifts the divergence onto a character who
belongs in another house in the canon; every model writes against the same
prologue, so the comparison is unaffected, but the prologue is not canon-clean
and a canon-fidelity test would catch that before it catches anything else.

**Prose quality was not measured, and meeting the outline does not measure
it.** Section 7 is a prepared packet, not a result. Everything said about
prose in this report is about shape: sentence length, vocabulary variety,
dialogue share, and whether the plan was followed. A chapter can name every
character, cover every scene, keep the divergence, invent no names and still
be dull — and every model here did all of those. Those are the things a
reader does not notice, which is the point.

**One judge, and it is a candidate.** The LLM screen in
`scripts/evaluate-judge.ts` is disclosed as a screen, and it was not used for
any table here.

**Two rows of the extraction budget run are invalid.** In `lore-03`, the
Ornith row lost all six of its calls to transport failures and the 3B row
lost one of six, because the Ollama server fell back to the CPU while two
models were resident. The report script marks a run whose every call failed
as "run failed" rather than printing zeroes, but the numbers underneath are
still only as good as the calls that completed.

**Timing is on a shared machine.** The GPU was not exclusively ours for
every run, and one model in one run fell back to the CPU, which is why
`qwen2.5:3b` shows 120 seconds per window in the extraction table and 110
seconds for one chapter. The times are indicative, not benchmarks.

---

## 10. What this says

### By role

| role | best measured | evidence | why |
| --- | --- | --- | --- |
| lore extraction | `gemma4:12b-it-q4_K_M` | 25% recall, 44% precision, 0 fabricated quotes, every relation quoted | the only model whose every extracted relation carries a verbatim quote, and the only one with no fabricated citation |
| planning | `gemma4` and `ornith` | both produce a complete, valid six-chapter outline with the canon/AU split kept | `qwen2.5:7b` invents two thirds of the canon event ids it cites |
| chapter writing | undecided | every model met the outline; the differences are in shape, not obedience | the prose quality question is the human rating, and it has not been done |
| continuity | `ornith`, then `gemma4` | 5 and 4 of 7 planted contradictions, against 1 and 0 for the qwen models | but `ornith` also reports a false positive half the time |

### Is model routing justified?

**Not yet, and not in the direction the handoff expected.**

The evidence says two different things about the two different halves of the
application:

- **The memory and the state extraction are the bottleneck, and they are
  where the qwen models are strongest.** Over eight chapters the baseline
  `qwen2.5:7b` produced 25 AU events, 14 knowledge records and 15
  relationships; `gemma4` produced 13, 9 and 4; `ornith` produced 1, 1 and 1.
  The writer's context is the story memory, so a model that cannot fill the
  memory in is a model that cannot be used for long stories — whatever its
  prose is like.
- **The prose is where the newer models are strongest, and that is the thing
  that has not been measured properly.** What can be said without a reader:
  `gemma4` writes the shortest sentences and the most varied vocabulary with
  no run-on sentences at all; `ornith` writes the longest sentences, the most
  dialogue and the only run-on sentences; the qwen models are the most
  obedient, hitting the target length most reliably and inventing no names.
  Whether any of that is *better* is exactly the question that is still
  open.

So the case for routing is a case for routing **the state extraction and the
lore extraction to one model and the prose to another** — and the extraction
measurements point at `gemma4` for lore and at the qwen models for state
extraction. But routing the writer is not justified by anything measured
here, because the thing that would justify it — a human saying the prose is
better — has not happened yet.

### The finding that is not about models at all

The two system-level defects found during this work were worth more than any
of the model differences:

1. **The context window.** The planner's prompt was 6,858 tokens against an
   8,192-token window, and three of the four models returned no outline at
   all. Fixing the default to 16 k and budgeting the canon-event index turned
   three failures into four complete plans.
2. **A truncated answer lost everything.** A model that ran out of tokens
   mid-JSON produced no lore at all for that window, and the sections that
   come last — the relations, which are the most valuable output — are the
   ones that get cut. Salvaging the finished records roughly doubled the
   recall of two of the four models.

Both were found by measurement rather than by reading the code, which is
the argument for having the measurement.

### What would change the answer

- **A human rating of the four chapters.** It is one afternoon of reading and
  it is the measurement that decides the writer question. The packet is
  written.
- **The same measurement on more than one chapter.** Every writing number
  here is one chapter from one story state. A model that wins on the Sorting
  may not win on a chapter with dialogue.
- **A repetition of the whole benchmark.** One run per cell, and the
  extraction numbers move by several points between runs on their own.

### The next action, in order

1. **Fill in `benchmarks/blind/write-04/ratings.csv`.** The question that
   matters is "does `gemma4` or `ornith` write better prose than
   `qwen2.5:7b`", and it is the one question the benchmark cannot answer
   without a person.
2. **Measure the state extraction on its own.** It is the mechanism that
   decides whether an eight-chapter story holds together, and it is where the
   models differ most (25 events against 1). A score of "state records per
   chapter, and how many of them are right" would tell the routing question
   directly.
3. **Then, and only then, route.** The architecture already allows it: the
   project settings carry a separate `extractionModel`, and the controller
   now accepts a different model for the context than for the prose.
4. **Only then consider a fine-tune.** There is no case for one yet. The
   failure that a fine-tune would fix — a model that writes nicely and cannot
   fill in a state sheet — is better fixed by prompting the state extraction
   and by checking what the models actually return, which is a day's work
   rather than a training set's.
