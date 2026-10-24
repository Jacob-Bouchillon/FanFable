# The model benchmark

The question this answers is narrow and practical: **which local model writes
the best canon-aware fanfiction, per unit of generation time, and is it worth
routing different roles to different models?**

Everything here runs on this machine. The models are Ollama models; the book
never leaves the disk; there is no network call in any of the measurement
path.

```bash
node testing/scripts/benchmark/corpus.ts          # build the fixed corpus (once)
node testing/scripts/evaluate-models.ts --role all
node testing/scripts/evaluate-report.ts <run-id>  # the numbers, as markdown tables
node testing/scripts/evaluate-blind.ts <run-id>   # a packet for a human to rate
node testing/scripts/evaluate-judge.ts <run-id>   # a screen, not a verdict
node testing/scripts/evaluate-long-story.ts --models qwen2.5:7b --chapters 1-8
```

The results are in [RESULTS.md](RESULTS.md).

## Run archive

Archived, exploratory runs are kept for history and are not part of a controlled
corpus comparison: `write-04` and `write-gemma-corpus` (Gemma-built corpus; its
blind packet and ratings stay write-once), plus the `lore-gemma-vs-qwen` gold-set
test, which is a separate lore experiment. `bench.db` and `bench-gemma.db` are
archival; a new comparison gets a fresh database and run ID. The Qwen-baseline
rater-agreement pilot uses `bench-qwen7-rater-pilot.db` and run
`write-qwen7-rater-pilot-01`.

## Progress monitoring

A monitored run writes `progress.json` and an append-only `progress.jsonl` in
`testing/benchmarks/runs/<run-id>/`. Watch it live:

```bash
npm run bench:watch -- <run-id>
```

The watcher shows every lifecycle stage (corpus, each extraction arm, paired
writing, blind packet, both rating sheets, comparison/unblinding), completed and
total work, elapsed time and last update, and any errors. It is read-only. ETA
appears only for a running stage with a known total, at least two completed
items and at least ten seconds of measured work; it is labelled approximate.
`ollama ps` is sampled at most every 15 seconds, and its PROCESSOR column is
shown as CPU/GPU placement, not GPU utilization. Rating stages count nonblank
cells in `ratings.csv` and `ai-ratings.csv`; the watcher never reads `key.json`.

The progress files carry counts, stage names and short errors only: no prompts,
generated prose, answer-key data or rating values. Builds and rating steps opt
in with `--progress-run <id>`; a model run writes progress under its own run ID
by default, or under an overall ID when you want both arms and the packet on one
timeline:

```bash
node testing/scripts/benchmark/build-fresh-corpus.ts <new-db> --progress-run <overall-id>
node testing/scripts/evaluate-models.ts --role writing --run <arm-run> --progress-run <overall-id>
node testing/scripts/evaluate-blind.ts <arm-run> --progress-run <overall-id>
node testing/scripts/compare-blind-ratings.ts <arm-run> --progress-run <overall-id>
node testing/scripts/evaluate-blind.ts <arm-run> --analyze --progress-run <overall-id>
```

A progress monitor may create its run directory before the run starts; the run
store adopts a directory that contains only those progress files and still
refuses any other existing run directory.

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

**A reproducible seed schedule.** The first repetition uses the model's base
seed (42 in the registry); each later repetition adds its zero-based repetition
index. That keeps each run reproducible while avoiding accidental identical
seeds across repetitions.

**The same token budget.** The same `num_predict`, the same context window
(8192), the same temperature for every candidate, because the roles set their
own temperature in the production code and that is what is being measured.

**Everything is written down.** Every prompt, output, token count and duration
is written to `testing/benchmarks/runs/<run-id>/`. Model runs also record the effective
baseline model, corpus file hash, imported-source text hash, fixture hash, model
registry hash, candidate settings and run options in `run.json`.

**A model that is not here is not in the table.** A candidate that cannot be
run — no weights, no template, not enough memory — is listed as unavailable
with the reason. It is never quietly dropped.

---

## The corpus

`node testing/scripts/benchmark/corpus.ts` builds it, in `testing/benchmarks/data/bench.db`:

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
instead of Gryffindor. The premise, the divergence point and the eight
chapter outlines are written by hand, in
`testing/benchmarks/fixtures/story.json`, and are identical for every model. A model
that was also allowed to write the plan would be graded on its planning as
well as its prose, and the two would not be separable.

The prologue (chapter 0) is written once by the baseline model and approved,
so that every candidate starts from a story state that a real pipeline
produced, rather than from a hand-written summary of one.

For a new baseline run, use a new database and run ID rather than reusing an
old benchmark database:

```bash
FANFORGE_BASELINE_MODEL=qwen2.5:7b node testing/scripts/benchmark/build-fresh-corpus.ts testing/benchmarks/data/bench-qwen7-rater-pilot.db
FANFORGE_BASELINE_MODEL=qwen2.5:7b node testing/scripts/evaluate-models.ts --role writing --models qwen2.5:7b,qwen2.5:3b,gemma4:12b-it-q4_K_M,ornith-1.5:9b --db testing/benchmarks/data/bench-qwen7-rater-pilot.db --run write-qwen7-rater-pilot-01 --reps 1 --chapter 1 --target-words 1500
```

This one-sample run is a rater-agreement pilot, not a reliable writer-model
ranking. Increase `--reps` only when you want a broader model comparison; each
repetition uses a distinct deterministic seed. Aggregated model reports show
the mean, sample standard deviation, and valid sample count; one repetition is
reported as `n=1` without an uncertainty estimate.

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

The gold set is hand-written (`testing/benchmarks/fixtures/lore-gold.json`): 50
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
(`testing/scripts/benchmark/measure.ts`) that both scripts import, so "repeated
paragraphs" means the same thing in both.

None of these measure whether the prose is good. That is what the human
rating is for.

### Paired human and AI ratings

Create the blind packet once. It contains separate `ratings.csv` and
`ai-ratings.csv` templates. The human rater fills the first. A fresh AI-rater
session should receive only `ai-rater-input.md`; it must not see the human
ratings, run metadata, or `key.json`. Keep the two score sheets separate.

Compare the anonymous scores before unblinding:

```bash
node testing/scripts/compare-blind-ratings.ts <run-id>
```

This reports paired counts, exact agreement, agreement within one point, and
mean absolute difference. Blank cells are N/A and are excluded. The comparison
does not read `key.json` or identify a model winner. Only after both rating sets
are final should the run be unblinded:

```bash
node testing/scripts/evaluate-blind.ts <run-id> --analyze
```

Agreement for one chapter is a case-level check of two raters, not evidence
that either rater can rank writing models reliably across stories.

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
node testing/scripts/evaluate-report.ts <run-id> [<run-id> ...]
```

regenerates every table from the run files. The numbers in [RESULTS.md] come
from that script, so they can be checked against the runs they came from.

## The human rating

Automated measurements cannot tell whether a chapter is any good, and the
handoff is right that an LLM judge is not a substitute for a person. So the
harness builds a packet:

```bash
node testing/scripts/evaluate-blind.ts <run-id>
```

which writes `testing/benchmarks/blind/<run-id>/`:

| file | what it is |
| --- | --- |
| `packet.md` | the passages, anonymised, in a seeded shuffled order |
| `brief.md` | what the chapter was supposed to be, and what was measured |
| `ratings.csv` | the form: one row per passage, one column per criterion |
| `ai-ratings.csv` | a separate form for a fresh, independent AI rater |
| `ai-rater-input.md` | a self-contained anonymous packet and fixed AI-rating instructions |
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

`node testing/scripts/evaluate-long-story.ts --models <keys> --chapters 1-8` runs the
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
