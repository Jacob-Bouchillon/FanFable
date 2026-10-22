# Evaluation

Everything here is measured, offline, and repeatable. The scripts do not need a
judge model: they count what is in the context, check quotations against the
source, and compare against fixed expected answers.

```bash
node scripts/evaluate.ts <db> <project> scripts/questions/hp.json   # retrieval
node scripts/evaluate.ts x --story                                    # the story side
node scripts/evaluate-continuity.ts                                   # the checks
node scripts/evaluate-writing.ts <db> <project>                      # the prose
```

The fixture is a real book: *Harry Potter and the Sorcerer's Stone*, 250
pages, imported as a PDF.

> **These figures predate the model benchmark.** The benchmark found two
> defects in the plumbing that change the extraction numbers: a truncated
> answer used to lose the whole window, and the default context window was
> too small for the planner's prompt. Both are fixed now, and the newer
> measurements are in [RESULTS.md](RESULTS.md). The retrieval figures below
> are unaffected — the retrieval path did not change.

## The three variants

| | what it assembles |
| --- | --- |
| **A — FTS5 only** | the passages a text search returns |
| **B — FTS5 + fact sheet** | passages plus the name-filtered lore brief (the system before the graph) |
| **C — graph enhanced** | passages plus graph traversal, the connections they hang from, and the evidence behind them |

| column | meaning |
| --- | --- |
| **answer** | share of expected answer terms present in the context |
| **relation** | share of expected *relationship types* present (synonyms count) |
| **2-hop** | the same, for questions whose answer is two connections away |
| **story** | share of expected terms for questions about what the story knows and wants |
| **evidence** | share of claims that are backed by a quotation or a source location |
| **quoted** | share of claims that carry a verbatim quotation |
| **correct** | quotations that really appear in the passage they point at |
| **gaps** | claims the context marks as unbacked rather than passing off as fact |
| **words / ms** | size of the context, and time to build it |

## Before and after

The same index, before and after this round of work:

| | before | after |
| --- | --- | --- |
| evidence coverage | 55% | **94%** |
| claims with a verbatim quotation | 22% | **45%** |
| quotations that check out | 95% | **99%** |
| relation recall | 66% | 90% |
| two-hop recall | 73% | 90% |
| context size | 1,437 words | 1,457 words |

The evidence figure moved for three separate reasons, and it is worth being
precise about which is which:

1. **Participation edges were flooding the context.** A character in twenty
   events produced twenty identical lines. They are now summarised — "Aunt
   Petunia is in 14 scenes: …" — which freed the budget for the relationships
   that matter.
2. **Truncated quotations lost their closing mark**, so a quotation could not be
   told apart from a description. `quoted()` now always closes the quotation.
3. **Claims that had no evidence were presented as if they had some.** They now
   carry the passage they came from, or an explicit `[unbacked claim]` /
   `[no quotation]` marker.

## Retrieval

```
variant                 answer   relation  2-hop    story   evidence   quoted  correct  gaps  words    ms
-------------------------------------------------------------------------------------------
A fts5 only              100%       43%      47%    100%       100%     100%     100%     0%     936     1
B fts5 + fact sheet      100%       88%      87%    100%        20%       0%     100%     0%    1574    14
C graph enhanced         100%       90%      90%    100%        94%      45%      99%     0%    1457    17
```

- **A text search finds the words but not the relationships.** It reaches 100%
  of the answer terms — the book mentions its own characters on every page —
  but under half of the relationship types, and nothing at all about the
  story's own knowledge.
- **The graph matches the fact sheet on canon relations and beats it on
  two-hop reach**, with twice the evidence coverage, in a slightly smaller
  context.
- **The story side is where the difference is not a difference** (below).

## The story side

A project with the sample book as canon and a story written on top of it:
characters who know things, want things, and keep secrets.

```
variant                 answer   relation  2-hop    story   evidence   quoted  correct  gaps  words    ms
-------------------------------------------------------------------------------------------
A fts5 only               33%      100%     100%     33%       100%     100%     100%     0%     629     0
B fts5 + fact sheet       50%      100%     100%     50%        50%       0%     100%     0%     734     1
C graph enhanced         100%      100%     100%    100%        87%      51%     100%    37%    1030     1
```

A text search cannot answer "what does Serena know about the third lantern"
(33%): that knowledge exists only in the story's memory. The fact sheet helps a
little (50%) because it knows about the canon entities called Serena. The graph
finds all of it (100%) — the knowledge, the motive, the secret, the open thread
and the cause of the crossing, each with the chapter it came from.

## Extraction quality

The lore index is what limits the graph, so the extraction was measured
directly: how many of the recorded relations and people carry a quotation that
was verified against the source.

| | relations with a verified quote | people with a verified quote |
| --- | --- | --- |
| before | 75 / 230 (33%) | 40 / 178 (22%) |
| after | **139 / 220 (63%)** | **101 / 161 (63%)** |

Two changes did that. A quotation that does not appear in the cited passage is
now looked for in the passages *around* it, and the reference is corrected to
where it actually is — most of the lost quotations were real, just cited to the
wrong passage. And a relation kind that was really the prompt's example list
(`serves | suspects | married to | leads | …`) is dropped instead of stored.

## Continuity detection

Six contradictions planted in a story, then the checker run over it.

```
checker                       found
-------------------------------------
text checks only              0
graph checks                  6
both together (unique)        6
```

| planted contradiction | found by |
| --- | --- |
| a character uses a fact before learning it | knowledge |
| an event happens before the event that caused it | chronology |
| a relationship changes with no cause recorded | relationship |
| a character is recorded in one place, the event is elsewhere | location |
| a divergence the story contradicts itself about | canon-mix |
| a plot thread marked resolved with no resolving event | thread |

Every one of them is a statement about a *connection* rather than about a
sentence, which is why text retrieval finds none of them. A deliberate AU
difference — the story is *meant* to differ from the canon — is not reported.

## The writing

Three things went wrong in the generated chapters, and all three can be counted
without a judge:

```
chapter   words/target   repetition   copied   outline   invented-names
------------------------------------------------------------
averages
  words as a share of target: 55%
  repeated paragraphs:       21%
  copied from the source:    0.0%
  names not in the canon:    0%
```

Before this round, on the same book and the same model:

| | before | after |
| --- | --- | --- |
| words as a share of the target | 65% | **106%** (A/B, three seeds) |
| repeated paragraphs | 30% | **11%** (A/B, three seeds) |
| copied from the source | 0.0% | 0.0% |

The length and repetition figures come from a seeded A/B on three seeds, so the
comparison is like for like. What changed:

- **The writer was told what has already happened.** When a chapter is written
  in parts, each part is shown the beats the earlier parts covered, so it does
  not write the same moment again in different words.
- **The writer was told not to restate.** The connected context is a set of
  constraints, not a summary to narrate.
- **A chapter that looped is now written again.** When the near-duplicate sweep
  removes more than a quarter of the text, the model is asked to carry on from
  what survived, so the material that was lost is written properly rather than
  deleted.

## The long story

A scripted five-chapter alternate universe, in the test suite
(`test/long-story.test.ts`): a significant divergence, its consequences, three
characters who know different subsets of the truth, a secret revealed in the
middle, a relationship that changes because of an event, a thread opened in
chapter one and closed in chapter five, a flashback that happens before
chapter one, and a motivation that chapter three depends on.

Because the chapters are scripted, what the memory holds after each approval is
known exactly, so the tests are about the system rather than about the model:

- each character's knowledge stays separate, and a belief that becomes knowledge
  is added rather than overwriting the old belief
- a relationship change is kept as history: the earlier state is closed, the
  new one opened
- a thread is introduced, developed and resolved
- the flashback is placed in the past
- a cause and its consequence are linked **across chapters** — which needed a
  fix, because links used to be resolvable only within one chapter
- the AU event is linked to the canon event it diverges from, and the canon
  itself is untouched
- re-approving a chapter replaces its records instead of adding to them
- the story survives a restart
- the writer is given the story as it stands at the scene being written

## What did not improve

- **The model is still the ceiling.** The prose is a 7B model's prose. The
  measurements show the *system* is no longer wasting what the model produces;
  they do not make the writing good.
- **Graph claims are still less evidenced than raw passages** (45% against
  100%). Passages are quotations, so every line of them is evidence by
  construction; an extracted relation is a claim, and it is only as good as the
  quote that could be verified for it.
- **A relation the extractor got wrong is still wrong.** The graph makes such
  errors visible and correctable — the lore gaps view and the correct/remove
  commands exist for that — but it does not detect them by itself.
- **One extraction pass still misses relationships.** The gaps view and
  `lore enrich` exist for that, and they work, but they need to be run.
- **The evidence coverage is measured on what the context contains**, not on
  whether the claim is true. A well-cited wrong claim scores well.

## The model benchmark

The questions above are about the system. The question this repository now also
answers is about the model behind it: which local model writes the best
canon-aware fanfiction, per unit of generation time, and is it worth sending
different roles to different models.

That measurement is in [BENCHMARK.md](BENCHMARK.md) — the method — and
[RESULTS.md](RESULTS.md) — the numbers. In short: four local models, the same
book, the same fixed lore and outline, the same context, the same seed, and
four roles (lore extraction, planning, chapter writing, continuity), plus an
eight-chapter story run through the whole lifecycle.

The two findings that were not about the models:

- **The planner's prompt was 6,858 tokens against an 8,192-token context
  window.** Three of the four models returned no outline at all, because there
  was no room left to write one in. The default context window is now 16 k,
  and the canon-event index the planner is given is relevance-ranked and
  budgeted.
- **A truncated answer used to lose everything.** A model that ran out of
  tokens mid-JSON produced no lore for that window at all. The extraction now
  salvages the records the model did finish, which roughly doubled the recall
  of two of the four models on the benchmark's gold set.
