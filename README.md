# fanforge

A local, self-contained program for writing long-form fanfiction from your own
books and reference material.

It understands the canon you give it, plans a story with you, writes the
chapters one at a time, asks for more information while it writes, remembers
what happened, and tells you when the story contradicts itself.

Everything runs on your machine: a local LLM (Ollama or llama.cpp), a local
SQLite file, no network calls.

---

## What it does

**Five roles, one model.** The Planner decides what should happen, the Writer
writes the prose, the Lore Researcher finds evidence in the source material, the
Continuity Checker looks for contradictions, and the Memory Manager keeps the
story state. They are prompts, not separate agents, and a central controller
coordinates them. The model never touches the database or your files directly.

**Two sources of truth.** The canon you import is written once and never
modified. The story you write lives in its own database, in its own timeline,
and links back to canon events when it adapts them. An intentional change from
canon is recorded as a change, not as damage to the source.

**The writer can ask for more.** While writing, the writer can request
information — about a canon scene, about what a character knows, about what has
already happened in the story. The controller resolves the request, feeds the
answer back, and the writer continues. Requests are de-duplicated and capped so
a confused model cannot loop forever.

**You stay in control.** The outline is a proposal until you approve it. A
chapter is a draft until you approve it. Approved material is preserved when
you revise a plan, and the tool tells you which chapters a change touches
instead of silently rewriting them.

---

## Source formats

Import a book directly — the file is read on this machine, page by page, and
passages can cite a page (`p. 42`):

| format | how it is read |
| --- | --- |
| `.pdf` | poppler's `pdftotext` (`apt install poppler-utils` / `brew install poppler`) |
| `.epub` | read directly — the archive is unpacked and the spine is followed |
| `.docx` | read directly — the document body is extracted |
| `.txt`, `.md` | read directly |

A scanned PDF (images rather than text) has to be OCR-ed first; there is no text
to read.

**At book scale.** A 250-page PDF imports in under a second: 250 pages become
~1,200 passages, indexed for search and mined for lore. The lore extraction is
the slow part — it is the model reading the whole book — and it runs as a
background job with progress. It is incremental: passages already read are
skipped, so re-running it is free.

```bash
fanforge import book.pdf          # imported book (pdf, 250 pages, 1194 passages)
fanforge lore extract             # reads the book, records its lore
fanforge lore extract             # again: nothing left to read
```

Reading a book for lore is a job, not a writing job, so it can be done with a
smaller, faster model while the good one stays reserved for the prose:

```bash
fanforge lore extract --model qwen2.5:3b     # a 250-page book in ~18 minutes
```

The index is tidied as it is built: entries that are the same thing under two
names are merged ("Harry" and "Harry Potter"), one relationship is kept per
pair, and an evidence quote that is not actually in the source is dropped
rather than kept as a false citation.

## Requirements

- **Node.js 22.18+ or 24+** (uses the built-in `node:sqlite` and native
  TypeScript execution — no build step, no dependencies to install)
- **A local LLM server**: [Ollama](https://ollama.com) or
  [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`

### Already set up on this machine

| what | where |
| --- | --- |
| Node 24.22 | `~/.local/opt/node/bin` (added to `~/.bashrc`) |
| Ollama 0.40.6 | `~/.local/opt/ollama/bin/ollama` |
| model | `qwen2.5:7b`, already pulled into `~/.local/share/ollama/models` |
| fanforge | `~/.local/bin/fanforge` → `src/cli.ts` |

Start the model server before using it (it does not run as a service):

```bash
OLLAMA_MODELS=$HOME/.local/share/ollama/models \
  setsid ~/.local/opt/ollama/bin/ollama serve > /tmp/ollama.log 2>&1 < /dev/null &
```

Then `fanforge llm status` should say *server reachable*. The GPU on this
machine (RTX 5070 Ti) is used by Ollama, so generation is fast.

```bash
# with Ollama
ollama serve
ollama pull qwen2.5:7b        # or llama3.1:8b, gemma3:12b, ...

# with llama.cpp
llama-server -m model.gguf --port 8080
```

Point fanforge at it:

```bash
fanforge llm config --provider ollama --model qwen2.5:7b --base-url http://127.0.0.1:11434
# or
fanforge llm config --provider llamacpp --model local --base-url http://127.0.0.1:8080
fanforge llm status
```

Smaller models work but produce weaker prose and more unreliable JSON. 7B and
up is a reasonable floor for a 16 GB GPU.

---

## Install

```bash
cd fanforge
npm install          # only devDependencies (typescript, @types/node); not needed to run
chmod +x src/cli.ts

# run it directly
node src/cli.ts --help

# or put it on your PATH
ln -s "$PWD/src/cli.ts" ~/.local/bin/fanforge
```

The database lives in `~/.local/share/fanforge/fanforge.db` (override with
`--db <path>` or `FANFORGE_DB`). Configuration lives in
`~/.config/fanforge/config.json`.

---

## A complete session

```bash
# 1. a project, and the source material
fanforge project create ardenne
fanforge import ~/books/the-bridge.txt ~/books/notes-on-ardenne.md
fanforge sources

# 2. ask the canon questions before you write anything
fanforge lore search "the third lantern"
fanforge lore ask "Who is Kade and what does he know about the wardens?"
fanforge lore events --extract        # build the canon event index (optional but useful)
fanforge lore extract                 # extract the book's lore (people, places, rules, facts)
fanforge lore show                    # browse the extracted lore
fanforge lore diagnose                # what did the extraction probably miss?
fanforge lore enrich "Fluffy"         # re-read the passages about one character

# 3. plan, and argue about it
fanforge plan discuss "Should the crossing happen before dawn or at dusk?"
fanforge plan draft --premise "..." --divergence "..." --chapters 6
fanforge plan show
fanforge plan revise "make chapter two colder" --chapter 2
fanforge plan approve

# 4. write one chapter at a time
fanforge write next
fanforge write show 1
fanforge write edit 1 --file revised.txt        # your own edit
fanforge write regenerate 2 --notes "keep it shorter"
fanforge write approve 1                        # this is what updates memory

# 5. check and correct
fanforge check 1
fanforge issues
fanforge issues resolve 3 --accept
fanforge conflicts                    # chapters that disagree with the story
fanforge conflicts resolve 1 --status accepted
fanforge state
fanforge state characters
fanforge state timeline
fanforge state set-character Serena --location "the far bank" --condition "wet"
fanforge state set-event 3 --kind flashback --order 0.5
fanforge state add-fact --kind promise --content "Ilsa will not tell Kade"

# 6. look at it in a browser instead
fanforge serve          # http://127.0.0.1:8123
```

Everything persists. Close the terminal, come back, `fanforge state` — the
project is exactly where you left it.

---

## Conflicts with established state

A chapter that contradicts the story's own history is a different kind of
problem from a continuity issue inside the prose. When an approved chapter says
something the story has already established differently — a character who was
alive is suddenly dead, a relationship changes with nothing to explain it, a
fact flips, a character forgets what they knew — the conflict is **recorded
with the provenance of both sides** and shown in the **Conflicts** view.
Nothing established is overwritten quietly.

```bash
fanforge conflicts                    # what disagrees with the established story
fanforge conflicts resolve 3 --status accepted
```

## The knowledge graph

The canon index tells you *where* something was said. The graph says *what
connects to what* — and that is what the planner, the writer and the continuity
checker now use by default.

```
$ fanforge graph "Harry" --hops 1
Connections for "Harry"
40 nodes, 42 connections, 1 hop(s)
  Harry Potter --son of | child of--> Dudley Dursley  Dudley attacks Harry after the boa constrictor's escape.
  Harry Potter --serves--> Hagrid  Harry serves Hagrid in the story...
  Harry Potter --aunt of--> Aunt Petunia Dursley  Harry is Aunt Petunia's niece...
  ...
```

**It is a view over the existing tables, not a second copy of the data.** Canon
lives in `canon_entity` / `canon_relation` / `canon_fact` / `canon_event` /
`canon_timeline`; the story lives in `character` / `au_event` / `relationship` /
`plot_thread` / `story_fact` / `character_knowledge`. Migration 2 added the
edges that had no table of their own:

| table | what it holds |
| --- | --- |
| `canon_event_participant` | who took part in a canon event |
| `au_event_participant` | who took part in a story event |
| `au_event_link` | cause and consequence between story events |
| `secret` | something true that not everyone knows |
| `motivation` | why a character does what they do |
| `graph_write` | an audit trail of graph writes |

**Nodes have stable ids** (`canon:entity:12`, `story:character:5`) and every
edge points at nodes that exist. A relation is never just "true": it carries
the evidence it came from, a confidence, a review status, and — where it
matters — the range of story time it holds for. Canon entities carry a
`review_status`, so an extraction the author has not checked can be marked as
needing review.

**Traversal is configurable and bounded** (`src/graph.ts`):

- one or two hops by default, up to four
- edge-type filters, direction filters, scope filters (canon / story / both)
- temporal filters, so a scene only sees what is true at its point in the story
- cycle protection (a node is expanded once, so a circle of relationships
  cannot make the walk run away)
- relevance ranking, node and edge limits, and a word budget

### What it is used for

| subsystem | how it uses the graph |
| --- | --- |
| **Planner** | sees the connected canon and story context when developing a premise, and the premise is checked against the canon: a name that is not in the source, or a status that contradicts it, is flagged rather than silently accepted |
| **Writer** | gets the connections around the scene — relationships, motives, secrets, what a character knows, the events and their consequences — alongside the canon evidence, and can ask for more with a `graph` context request |
| **Continuity checker** | six new deterministic checks that text search cannot do (below) |
| **Memory manager** | on approval it resolves story characters to canon characters, records participation, cause and consequence, motives, secrets and thread development — transactionally, and it clears them when a chapter is re-approved |

### The checks only a graph can do

`src/graph-checks.ts` adds six deterministic checks:

- a character acting on something **before the event where they learn it**
- an event that happens **before the event that caused it**
- a relationship that **changed with nothing recorded to explain it**
- a character **recorded in one place** while the event they are in happens elsewhere
- an **AU event that ignores the consequences of an earlier divergence**
- a **plot thread** marked resolved with no resolving event, or resolved by an
  event while still marked open

None of them treats an intentional change from canon as a mistake.

### The new context request

The writer can ask for connected context mid-scene, with the same caching,
de-duplication and limits as the other kinds:

```
[[CONTEXT]]
{"kind": "graph", "query": "what is connected to the third lantern"}
[[END]]
```

## Retrieval: text and graph together

`src/retrieval.ts` is the unified service. For one scene it returns:

- the passages FTS5 found
- the graph nodes and connections within a hop or two of the scene's names
- the source passages that substantiate those graph claims
- the story's own approved events, knowledge and memory

ranked, de-duplicated and inside a word budget. The graph is used to *discover*
connections; the passages are used to *verify* them — a graph claim is never a
substitute for the text behind it. The interface is deliberately shaped so a
vector index can be added later without changing the callers.

## Measuring the difference

Two scripts, both offline and deterministic:

```bash
node scripts/evaluate.ts <db> <project> scripts/questions/hp.json   # retrieval
node scripts/evaluate.ts x --story                                 # the story side
node scripts/evaluate-continuity.ts                                # the checks
node scripts/evaluate-writing.ts <db> <project>                   # the prose
```

Results are in [EVALUATION.md](EVALUATION.md).

## Choosing a model

The prose is only as good as the model behind it, so the repository has a
benchmark for that question: which local model writes the best canon-aware
fanfiction, per unit of generation time, and is it worth sending different
roles to different models.

```bash
node scripts/benchmark/corpus.ts          # build the fixed corpus (once)
node scripts/evaluate-models.ts --role all
node scripts/evaluate-report.ts <run-id>  # the numbers, as markdown tables
node scripts/evaluate-blind.ts <run-id>   # a packet for a human to rate
node scripts/evaluate-judge.ts <run-id>   # a screen, not a verdict
node scripts/evaluate-long-story.ts --models qwen2.5:7b --chapters 1-8
```

The corpus is the imported book, one extraction of its lore, an approved
outline and an approved prologue — all built once, by the baseline model, and
frozen, so that every candidate is given the same passages, the same graph,
the same plan and the same story state. The method is in
[BENCHMARK.md](BENCHMARK.md) and the measurements are in
[RESULTS.md](RESULTS.md).

**What the models have to support.** All of them are Ollama models on the
local machine, and the benchmark found three things worth knowing:

- **A thinking model needs the thinking turned off** for a fair comparison.
  `gemma4` and `ornith-1.5` think out loud, and the thinking comes out of the
  same token budget as the answer. The setting exists in the model settings
  (`"think": false`) and the benchmark harness uses it; `fanforge llm config`
  has no switch for it yet.
- **A model that does not act on a system-role message needs a different
  prompt shape.** `ornith-1.5:9b` ignores a separate system message and obeys
  the same text when it is merged into the first user turn. Fanforge sends the
  role prompts as system messages, so a model like that needs an adapter
  before it can be used for the writer — or the prompt has to be merged.
- **A model that does not fill in a state sheet cannot carry a long story.**
  Over eight chapters, `ornith-1.5:9b` wrote the most words and recorded one
  event, one piece of knowledge and one relationship. The writer's context is
  the story memory, so a model that cannot fill the memory in is a model that
  cannot be used for long stories, whatever its prose is like.

Two other things the benchmark assumes, both stated in the code:

- The context a model writes against can be built by a different model
  (`contextLlm`), and can be handed to several models unchanged (`bundle`).
  That is how the comparison stays a comparison.
- The same seed, context window, temperature and token budget are used for
  every candidate, and every prompt, output, token count and duration is
  written to `benchmarks/runs/<run-id>/`.

## The browser interface

Everything the CLI does is also in the browser, in one place:

```bash
fanforge serve            # http://127.0.0.1:8123
```

| view | what it is for |
| --- | --- |
| **Dashboard** | where the story stands: chapters approved, characters, open issues, what the writer asked for recently |
| **Sources** | import files by dropping them in, see what is indexed |
| **Lore research** | search the canon, or ask a question and get an answer with citations |
| **Book lore** | the extracted index of what the book establishes — people, places, rules, relationships, facts — each with the line it came from; correct or remove entries |
| **Lore gaps** | what the index is probably missing: characters with no relations, relationships the source states plainly that the graph does not hold |
| **Conflicts** | chapters that disagree with the established story, with the provenance of both sides |
| **Canon events** | the index of scenes the story can adapt; rebuild it in one click |
| **Plan** | the premise, the divergence point, the chapter outlines — approve, revise, or talk it through with the planner |
| **Write** | the chapter list and reader; write, edit, regenerate, check and approve |
| **Story state** | characters and what they know, the AU timeline, plot threads, established facts, the context-request log |
| **Continuity** | every open issue with its evidence; accept it as intended or mark it fixed |
| **Settings** | provider, model, base URL, temperature |

You can create and switch projects from the sidebar, so the browser is enough
on its own — the CLI is the fast path for people who prefer a terminal.

It talks to the same controller and the same database as the CLI, so the two
never disagree. Model calls run as background jobs with a progress modal, so a
two-minute chapter write does not freeze the page. Switching project in the
sidebar switches it for the CLI too.

Files you upload are written to `.imports/<project>/` next to the project and
indexed from there — nothing leaves the machine.

Light and dark themes both work, and the layout collapses to a single column on
a narrow window.

---

## How the pieces fit

```
                    ┌──────────────────────────────┐
                    │        application            │
                    │        controller             │
                    └───┬───────┬────────┬──────┬───┘
                        │       │        │      │
        ┌───────────────┘       │        │      └──────────────┐
        ▼                       ▼        ▼                     ▼
   ┌─────────┐            ┌─────────┐ ┌───────────┐      ┌────────────┐
   │ Planner │            │ Writer  │ │  Lore     │      │ Continuity │
   │         │            │         │ │  Research │      │  Checker   │
   └────┬────┘            └────┬────┘ └─────┬─────┘      └──────┬─────┘
        │                      │            │                   │
        └──────────────────────┴────────────┴───────────────────┘
                               │
                    ┌──────────┴───────────┐
                    │   Story Memory       │
                    │   Manager + SQLite   │
                    └──────────────────────┘
```

| File | Role |
| --- | --- |
| `src/controller.ts` | the only component that writes to the database; routes context requests, owns approval state and generation limits |
| `src/planner.ts` | premise, divergence point, structure, chapter outlines, discussion with the author |
| `src/writer.ts` | writes chapters; owns the context-request protocol and the length/continuation loop |
| `src/lore.ts` | imports sources, searches them, answers lore questions with citations, builds the canon event index |
| `src/lorebook.ts` | extracts the book's lore into people, places, rules, relationships, facts and a timeline, each with evidence |
| `src/continuity-settings.ts` | how much the continuity checker does and what it reports |
| `src/graph.ts` | the knowledge graph: nodes, edges, traversal, ranking, rendering |
| `src/graph-checks.ts` | the six continuity checks only a graph can do |
| `src/retrieval.ts` | the unified retrieval service (text and graph together) |
| `src/premise-check.ts` | checks a premise against the canon before a plan is approved |
| `src/migrations.ts` | versioned schema migrations |
| `src/memory.ts` | characters, states, knowledge, relationships, threads, facts, summaries, timeline; context assembly |
| `src/continuity.ts` | deterministic checks (chronology, repetition, canon mixing) plus model-assisted checks |
| `src/schema.ts` | the database schema, including the separation between canon and story tables |
| `src/llm.ts` | providers: Ollama, llama.cpp / OpenAI-compatible, and an offline mock for tests |
| `src/cli.ts` | the command line interface |
| `src/server.ts` | the local web API and job runner |
| `src/ui/` | the browser interface (plain HTML, CSS and JS — no build step) |

### The database

One SQLite file, tables scoped by `project_id`. The important split:

*Canon (write-once)*
`canon_source`, `canon_chunk`, `canon_chunk_fts` (FTS5), `canon_event`

*Story (evolving)*
`outline`, `chapter`, `chapter_revision`, `au_event`, `canon_change`,
`character`, `character_state`, `character_knowledge`, `relationship`,
`plot_thread`, `story_fact`, `chapter_summary`

*Bookkeeping*
`message` (planner conversation), `context_request` (what the writer asked
for), `continuity_issue`

---

## The context request protocol

The writer can stop mid-scene and ask for what it is missing:

```
[[CONTEXT]]
{"kind": "lore", "query": "what the source says about the third promise"}
[[END]]
```

| kind | resolves to |
| --- | --- |
| `lore` | full-text search over the imported canon, with source references |
| `canon` | one specific canon event and the exact text of its passage |
| `memory` | what already happened in this story: events, decisions, facts |
| `character` | one character's profile, state history, knowledge, relationships |
| `au` | what this story has already changed relative to canon |

The controller answers with sections that keep canon evidence, existing story
history and speculation apart. The writer sees the answer and continues the
scene. The request is logged, so `fanforge state requests` shows exactly what
the writer asked and what it got.

Limits (defaults): 4 round trips per scene, 10 distinct requests per scene.
Repeated requests are answered from cache instead of hitting the database
again.

---

## Book lore: what the source actually establishes

The text index tells you where something was said. The **lore index** says
*what the book contains*: the people, places, things and rules that exist, the
relationships between them, the facts the source supports, and the book's own
timeline.

```bash
fanforge lore extract        # read the imported material and record its lore
fanforge lore show           # browse it
```

Every entry keeps the passage it came from, so a claim can always be checked,
and every entry can be corrected or removed from the browser.

This index does three things:

- **It grounds the writer.** The writer is given the lore brief (names, roles,
  states, relationships, rules) instead of a wall of retrieved text, which is
  both better writing and less copying.
- **It answers lore questions.** The researcher consults the index first, then
  the passages, and cites both.
- **It makes new checks possible.** A character who is dead in the book but
  acts in your story is now detectable — and if you have recorded the change
  from canon, the checker stays quiet.

## Missing lore: finding it without inventing it

One extraction pass never captures everything. A character who appears in two
hundred passages can end up with one relation, because the passages that
mentioned their family never happened to sit next to the passage that named
them.

`fanforge lore diagnose` looks for the gaps:

- characters with no relationships at all
- characters who appear often but have only one
- two relations between the same pair that disagree
- **a passage that plainly states a relationship the graph does not hold** —
  reported with the passage that says it, never written into the graph

`fanforge lore enrich <name>` then re-reads the passages that mention one
character and records only what is missing, marked as needing review. A
hand-made correction (`fanforge lore correct relation 42 --kind "guards"`) is
marked as the author's, and the model's claim is kept beside it.

## Continuity checking, on your terms

The checker is useful, but it is not the author's job to read a wall of
warnings. It is configurable, per project:

```bash
fanforge continuity                     # show the current settings
fanforge continuity --off               # turn it off entirely
fanforge continuity --model off         # only the deterministic checks
fanforge continuity --drafts off        # check on approval, not on every draft
fanforge continuity --severity error    # only report errors
```

The same switches are in **Settings → Continuity checking** in the browser.

## Canon briefs instead of copy-paste

By default the writer is given a **canon brief** — the facts, the available
canon scenes, and an explicit list of what the evidence does *not* settle —
rather than the raw source text. That keeps the prose the writer's own. When
it needs the exact wording of a canon scene, it asks for it with a context
request.

This is the single biggest quality lever in the system: handing a model three
hundred words of source text and asking for a chapter produces paraphrase.
Handing it a fact sheet produces prose.

---

## Continuity checking

Deterministic checks need no model and always run (when the checker is on):

- story time running backwards inside a chapter
- a flashback that is not placed in the past
- a chapter that substantially repeats an earlier one
- an AU event that adapts a canon event but does not record what changed
- open plot threads that have gone quiet
- changes from canon that the author has not confirmed

Model-assisted checks look for the things that need reading comprehension: a
character acting on information they do not have yet, a relationship that
shifts without cause, an injury that healed too fast, canon details that were
supposed to change but did not, and scenes that leave the approved outline.

Findings are reported with evidence and a suggestion. The checker never
rewrites anything and never rejects an intentional AU change — it points it out
and you decide. `fanforge issues resolve <id> --accept|--fix` records your
decision.

---

## Testing

```bash
npm test
```

135 tests covering import and search, PDF/EPUB/DOCX reading, page-aware
chunking, JSON handling from models, the
context-request protocol and its limits, memory extraction and retrieval,
character merging, lore extraction and its use as a brief, the dead-character
check, continuity settings, the full plan → write → approve → remember workflow,
persistence across a restart, and the web API. The tests use a mock provider,
so they need no model and no GPU.

The graph has its own suite (`test/graph.test.ts`, `test/graph-checks.test.ts`,
`test/retrieval.test.ts`, `test/migrations.test.ts`): multi-hop retrieval and
relationship direction, entity resolution and duplicate prevention, evidence
provenance, temporal filtering and character knowledge, canon/AU isolation,
approval-gated updates and re-approval, persistence across restarts, retrieval
limits and budgets, and the graph-based continuity detection.

---

## Notes and limits

- **Text formats.** Plain text, Markdown, PDF, EPUB and DOCX are all read
  directly (see above). A scanned PDF needs OCR first.
- **Retrieval** is FTS5 with stemming, plus a model-generated query expansion
  for conceptual questions. Embeddings and hybrid search are a later step; the
  retrieval interface is already in place for it.
- **The model is the weakest link.** A 7B model will sometimes ignore the
  context protocol, write short chapters, or invent canon details. The
  continuity checker catches a lot of this, and the approval workflow means
  nothing reaches the story's memory without your say-so.
- **Chapter length.** The writer is asked for a target length and, if it stops
  early, is asked to continue. The number of continuations is capped.

---

## Configuration

`~/.config/fanforge/config.json`:

```json
{
  "provider": "ollama",
  "baseUrl": "http://127.0.0.1:11434",
  "model": "qwen2.5:7b",
  "temperature": 0.8,
  "maxTokens": 2048,
  "contextTokens": 16384
}
```

Per-project overrides live in the `project.settings` column and win over the
global file. `fanforge project settings --model ... --temperature ...` sets
them.

**The context window is worth its memory.** The planner's prompt alone is
close to 6,000 tokens, and a model whose window is full cannot finish its
answer — the benchmark found three of four models returning no outline at all
with an 8 k window. 16 k is the default for that reason; a 7B model at Q4_K_M
needs about a gigabyte more of VRAM for it, which a 16 GB card has to spare.
Set `"think": false` for a model that thinks out loud (`gemma4`,
`ornith-1.5`), or the reasoning comes out of the same budget as the answer.

---

## License

MIT.
