# The model benchmark

The question this answers is narrow and practical: **which local model writes
the best canon-aware fanfiction, per unit of generation time, and is it worth
routing different roles to different models?**

Everything here runs on this machine. The models are Ollama models; the book
never leaves the disk; there is no network call in any of the measurement
path.

```bash
node scripts/benchmark/corpus.ts          # build the fixed corpus (once)
node scripts/evaluate-models.ts --role all
node scripts/evaluate-report.ts <run-id>  # the numbers, as markdown tables
node scripts/evaluate-blind.ts <run-id>   # a packet for a human to rate
node scripts/evaluate-judge.ts <run-id>   # a screen, not a verdict
node scripts/evaluate-long-story.ts --models qwen2.5:7b --chapters 1-8
```

The results are in [RESULTS.md](RESULTS.md).

---

## The rules the harness follows

**The same input for everybody.** A model is measured against a fixed corpus:
the same imported passages, the same extracted lore, the same canon-event
index, the same approved outline, the same story state, the same target
length. Where the model could gather its own context — the canon brief, the
graph walk, the answers to the writer's context requests — that context is
assembled **once, by the baseline model, and handed to every candidate
unchanged**. A model that is slower at gathering material should not be
charged for it, and a model that is good at gathering material should not be
credited for it either: the benchmark measures the role, not the plumbing.

**The same prompt framing for everybody.** The system prompt is delivered the
same way to every candidate: folded into the first user turn. Two of the
candidate models do not act on a system-role message at all, and one of them
is a candidate *because* of that, so a uniform framing is the only way the
comparison means anything.

**A fixed seed.** Every run uses seed 42. Ollama honours the seed for the
models here, so the same prompt gives the same answer; where a runtime
ignores it, the repetitions show it in the spread.

**The same token budget.** The same `num_predict`, the same context window
(8192), the same temperature for every candidate, because the roles set their
own temperature in the production code and that is what is being measured.

**Everything is written down.** Every prompt, every output, every token count
and every duration is written to `benchmarks/runs/<run-id>/`, so the tables in
RESULTS.md can be checked against the runs they came from.

**A model that is not here is not in the table.** A candidate that cannot be
run — no weights, no template, not enough memory — is listed as unavailable
with the reason. It is never quietly dropped.

---

## The corpus

`node scripts/benchmark/corpus.ts` builds it, in `benchmarks/data/bench.db`:

| project | what it holds |
| --- | --- |
| `bench-hp` | the book and nothing else. The lore scenario runs here, so that no story is on top of the canon while it is being read. |
| `bench-story` | the same book, plus one extraction of its lore, one index of its canon events, an approved outline, an approved prologue, and the story state that prologue produced. |

The lore and the canon-event index are extracted **once, by the baseline
model**, and then frozen. That is a deliberate choice with a known cost: the
graph every model writes against is a 7B model's graph. A model with a better
extractor would get a better graph in production than it gets here. The
extraction quality is measured separately, in the lore scenario, and the
writing scenario is not allowed to contaminate it.

The story is *Green and Silver*: Harry Potter is sorted into **Slytherin**
instead of Gryffindin. The premise, the divergence point and the eight
chapter outlines are written by hand, in
`benchmarks/fixtures/story.json`, and are identical for every model. A model
that was also allowed to write the plan would be graded on its planning as
well as its prose, and the two would not be separable.

The prologue (chapter 0) is written once by the baseline model and approved,
so that every candidate starts from a story state that a real pipeline
produced, rather than from a hand-written summary of one.

---

## The four roles

There is a fifth scenario, `state`, that measures the state extraction on its
own: the same chapter, the same hand-written gold state, and the count of the
records each model got right. It was written while the long-story test was
being read, and it was **not run** — the long story's event counts are the
only evidence on state extraction in [RESULTS.md](RESULTS.md), and those are
counts, not accuracies.

### Lore extraction

The scenario runs the **production extraction path** — the same prompt, the
same quote verification, the same neighbour correction, the same entity
merging and relation de-duplication — over six fixed windows of eight
passages each.

The gold set is hand-written (`benchmarks/fixtures/lore-gold.json`): 50
relations, each with the exact quote from the window that supports it, and
the accepted names for each side of the relation. Before the benchmark runs,
every quote is checked against the corpus; if a quote does not verify, the
benchmark refuses to score rather than quietly penalising every model.

| measured | what it means |
| --- | --- |
| recall | the share of gold relations the extraction recorded, matching the pair and the kind |
| direction | among the gold relations whose direction the text fixes, the share that were written the right way round |
| fabricated quotes | extracted relations whose quote is not in the source at all |
| unbacked | extracted relations with no quote |
| duplicates | the same pair and the same kind, twice |
| conflicting | the same pair, two different kinds |
| name accuracy | the share of the extracted names that are one of the accepted names of a gold entity |
| canonical name rate | the share that use the entity's canonical name rather than an alias |
| time | the wall clock for the window |

Recall is measured against a hand-written set, so it is a statement about
these six windows and not about the book. A model that finds relations the
gold set does not have is not penalised for it — recall has no penalty for
extras, which is why the fabricated-quote and duplicate counts are reported
next to it.

**A window whose call failed is not a window that produced nothing.** The
extraction path treats a failed call as a window with nothing in it, which is
right in production and wrong in a report. The report script counts the
failed calls in each run and prints "run failed" for a model whose every call
failed, so a transport failure is never mistaken for a score of zero.

### Planning

The model is asked for an outline from the fixed premise, with the fixed canon
context. The context contains no model calls at all, so every candidate is
given exactly the same material.

| measured | what it means |
| --- | --- |
| json valid | did the model return an outline at all |
| chapter count | did it produce the number of chapters it was asked for |
| completeness | the share of chapters with a goal, a synopsis and at least one scene |
| canon/au split | the share of chapters that say what the canon establishes *and* what this story changes |
| canon refs | the share of the canon event ids it cites that exist |
| premise coverage | the share of the premise's content words that reach the plan |
| divergence honoured | does the plan keep the divergence |
| consequence planning | the share of later chapters whose text says something follows from something — a proxy, and labelled as one |

### Chapter writing

The model writes chapter 1 against the fixed context, the fixed outline and
the fixed target length.

| measured | what it means |
| --- | --- |
| length ratio | the words it wrote against the words it was asked for |
| repetition | the share of paragraphs that are near-duplicates of another paragraph (similarity above 0.55) |
| copied | the share of the chapter's eight-word sequences that also appear in the source |
| invented names | the share of the chapter's capitalised words that appear nowhere in the source |
| characters present | the share of the outline's characters the chapter names |
| scene coverage | the share of the outline's scenes the chapter actually covers |
| canon / au coverage | the share of the outline's canon and AU bullets the chapter reflects |
| canon leak | sentences that put Harry in Gryffindor, which this story does not do |
| dialogue share | the share of words inside quotation marks |
| type/token ratio | the share of distinct words: lexical variety, not quality |
| context requests | how many times the writer asked the controller for more |

The repetition and copying definitions are the ones the writing evaluation
already used; they now live in one place
(`scripts/benchmark/measure.ts`) that both scripts import, so "repeated
paragraphs" means the same thing in both.

None of these measure whether the prose is good. That is what the human
rating is for.

### Continuity

A story state is built by hand, and a chapter is written with seven
contradictions planted in it: a character using a fact before learning it, a
canon event reported unchanged, a person somewhere they cannot be, a
relationship asserted where the story says otherwise, an injury that has not
happened, an event the story has already done, and a scene the plan forbids.
The checker is run over it.

A finding counts as a detection when its category matches the planted item
**and** its evidence or message shares the planted sentence's distinctive
words. Requiring both keeps a vague finding from being counted as a hit. A
finding that matches no planted item is a false positive and is counted as
one.

---

## Reading the results

```bash
node scripts/evaluate-report.ts <run-id> [<run-id> ...]
```

regenerates every table from the run files. The numbers in [RESULTS.md] come
from that script, so they can be checked against the runs they came from.

## The human rating

Automated measurements cannot tell whether a chapter is any good, and the
handoff is right that an LLM judge is not a substitute for a person. So the
harness builds a packet:

```bash
node scripts/evaluate-blind.ts <run-id>
```

which writes `benchmarks/blind/<run-id>/`:

| file | what it is |
| --- | --- |
| `packet.md` | the passages, anonymised, in a seeded shuffled order |
| `brief.md` | what the chapter was supposed to be, and what was measured |
| `ratings.csv` | the form: one row per passage, one column per criterion |
| `key.json` | which passage is which model — **not part of the packet** |

The scales are the ones the handoff asks for, each 1 to 5: prose quality,
character voice, dialogue, scene pacing, emotional credibility, originality
within the premise, outline adherence, canon/AU consistency, character
knowledge consistency, and freedom from repetition.

Two things are kept apart on purpose. The first nine scales are about the
writing; the last one is about repetition; and the *correctness* of the
chapter — does it contradict the story — is kept in the automated table, so a
beautiful chapter that contradicts the story state does not win on the
strength of its prose alone. The packet says which is which, and the summary
reports the two groups separately.

---

## The long story

`node scripts/evaluate-long-story.ts --models <keys> --chapters 1-8` runs the
whole lifecycle for a model: write, approve, and the memory that follows;
an edit and a re-approval in one chapter; a contradiction planted in one
draft; a restart of the application halfway through; and the canon, which
must not have moved by the end.

The database is copied before each model runs and put back afterwards, so no
model inherits another model's story.

What is checked at the end:

- the canon tables are exactly as they were (`canonΔ` must be zero)
- the story has its own records: events, knowledge, relationships, threads,
  secrets, motivations, facts
- different characters know different things
- the graph is there, and the graph checks over the finished story
- the planted contradiction was caught

---

## What the harness does not do

- It does not judge prose quality. That needs a person.
- It does not measure a model's knowledge of the book. The canon is in the
  context, not in the weights; that is a different question.
- It does not compare a model against itself on a different prompt, except
  where the prompt difference is the thing being measured.
- It does not use the network. The only thing that leaves the machine is
  nothing at all.
