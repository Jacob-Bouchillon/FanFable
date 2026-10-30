# Webs and Threads — day-1 visual system

Design proposal for red pen. Nothing here is built unless marked shipped;
unmarked sections are proposal only, faithful to the approved consolidated
design. Terminology: threads for persistent investigations, the web for the
accumulated network; meeting, birth, note (clue), open end, and map keep their
names. Grades are proven tie, attested, held-aside.

## Status

- **SHIPPED (verified committed behavior only):** attested tier code,
  pronoun-first ordering, demote-with-reason path, strict integrity,
  quarantine, rulings replay.
- **PROPOSED:** thread records, meetings, births, scoped sharing, map
  behavior and rendering fixes (crowding/zoom), review-by-richness queue,
  combination accumulation, multi-sentence evidence, evidence-thread concept.
- **Discovery:** design approved day-1; unbuilt except sweep.ts
  per-character ledgers (122 distinct pairs); the 80-row stratified sample is
  DESIGNED BUT UNRUN.
- **OPEN:** birth triggers, idempotency edge cases, starvation caps,
  evidence-thread implementation, cost limits.

The meeting-vs-birth distinction is what prevents uncontrolled merging:
a meeting is exchange between intact threads; only a birth makes a new
thread, and only on a meaningful new combined purpose or knowledge state.
Exchange never creates; birth never merges people.

## Build order

Evidence web first, map second — the map visualizes a correct network, never
substitutes for it.

## Core

Reading grows a persistent web of information, not disconnected rows. Every
read leaves clues on persistent threads; threads meet, share, resolve, birth;
understanding accumulates across the book. No single passage needs the whole
truth. The model reads and interprets; code handles structure, persistence,
provenance and mechanics; the user alone proves.

## Pieces

- **Passage** (~220 words, ground of all evidence, everything traceable).
- **Thread:** persistent investigation with identity + type, ordered passage
  history, accumulated notes, open end (what it still needs), connections,
  parentage if born.
- **Note (clue):** immutable observation (passage, people/pair, exact quote,
  claim, strength 0–1, one-line why, what's missing); never rewritten,
  corrections recorded separately.
- **Meeting:** two threads at a shared point; records which threads, why
  matched, what exchanged, what resolved, what remains; never auto-merges
  everything.
- **Sharing:** scoped exchange BEFORE birth, both directions; identity info ≠
  pair evidence (a Plagueis–11-4D meeting exchanges only
  Plagueis/11-4D-relevant notes).
- **Birth:** a meeting may produce ONE child when there is a meaningful new
  combined investigative purpose or knowledge state; resolved-want and new
  pooled pair evidence are two examples, and the trigger policy stays OPEN
  (two threads discovering they concern the same event qualifies with neither
  example firing). Otherwise the outcome is meeting-only. The child records
  both parents, references (not copies) pooled knowledge, resolved +
  unresolved wants carried; parents stay intact and readable; birth recorded
  with all three IDs; thread birth is NEVER people-merging (merges need the
  user word alone).
- **Open end:** question + origin + what would resolve it + status + age;
  resolution links, never erases.
- **Map:** the visible web — threads, knots, births, proof grades on lines
  (proven solid, attested thinner, held-aside dotted), open ends flagged;
  selecting shows history, passages, contradictions, assessments.

## Types (relationships first)

- Person threads (identity, aliases, titles, appearances, context for indirect
  reference).
- Pair threads — the centerpiece — every claim, multi-passage evidence,
  interactions, support AND contradiction, change over time, NO single
  permanent label (mentor + ally + enemy dimensions allowed; the schema already
  carries event-scoped validity). Temporal scope is an explicit requirement:
  began / ended / changed dates if known, supporting passages per period,
  current vs historical vs uncertain status — apprentice-early and enemy-later
  must both be representable and true.
- Evidence threads (establishes / reinforces / challenges / context per claim;
  passages shared across threads without duplicating notes) stay in the
  conceptual design; implementation is OPEN — start as a reference network
  between notes, pair threads, and passages, and only become a full
  independent thread type after person and pair threads validate.
- Event / place / lore threads later, same network.

## Begin and grow

Import → passages → names → windows of 8 (recurring names first, seeded
rest); three narrow passes (people / ties / events); continue-or-start per
person and pair; every observation immutable with an open end; reads load open
threads first (capped per read, starved first), never cold; exhaustive intent
(long lists welcome, misses are failures, moments go to events, denials
preserved).

## Meetings

Deterministic match (shared person → person info, shared pair → pair info,
claim-meets-evidence), no fuzzy identity, no auto-merge; at a meeting both
sides inspect the relevant notes, wants checked immediately (a want answered
by the other's notes resolves on the spot with linked evidence),
contradictions stay visible, record what was learned; IDEMPOTENT — same
threads + same evidence + same exchange creates no duplicate meeting or
birth; same threads + new evidence appends notes and updates the meeting or
creates an evidence-linked revision; changed resolution preserves the earlier
one and records the new one alongside. Idempotency must never suppress
accumulation.

## Proof

The checker verifies quote word-for-word, both people listed, distinct
identities, source linkage — never semantics. The model assesses
assert / imply / mention / reinforce / challenge + strength + why. Grades:
proven (user word — overrides everything, stays distinct), attested (quote
states the tie, verbatim, both names in passage scope even across sentences,
assessment clears the bar, citable with scope — never proven-tie grade;
intended rule as stated here, with honesty about what is verified: the tier
code is shipped, but 0 of 262 passage-proof candidates moved without stored
assessments, so passage-scope promotion at scale is intended-but-unverified
pending live-bank application — 27 attested on the assessed disposable copy
only, real bank untouched), held-aside (insufficient / conflicting / identity
/ fabricated + reason, never deleted). Weak independent evidence accumulates
(three independent weaks outscore one loud one; same-scene repeats are NOT
independent; duplicates never inflate; contradictions visible; scores real,
never default). Code aggregates and thresholds, invents nothing.

## Persistence and model-independence

All state is ordinary bank data; later readers (same, bigger, or later models)
load threads and continue; re-reads prioritize thin threads, unresolved pairs,
pending meetings, oldest ends, starved.

## Review

Richest-evidence threads first, then oldest and most important; evidence
richness — not raw confidence — orders until scores are trustworthy.

## Discovery

Coverage is structural, inference is spent where it informs. Measured gap on
the trial book (182 names): 16,471 possible pairs; 3,258 sharing a passage;
sweep.ts proposes 122 (~3.7% of co-occurring).

Design:

1. Thread creation — code-only pair threads for every co-occurring pair (no
   model calls), generated from distinct canonical person identities sharing
   at least one passage — resolved through the identity system first
   (nested, shared-alias, and quarantine rules), never raw name strings, so
   aliases and titles cannot inflate the graph and no fuzzy merging happens
   at creation; an empty thread means investigation exists with no evidence
   yet gathered, NEVER no-relationship.
2. Initial evidence — run the existing 80-row stratified sample design
   (co-occurrence depth × book position) against unproposed co-occurring
   pairs (the 3,258 minus the 122 already proposed): sample distinct pairs,
   never raw rows, so duplicates collapse before sampling; strata with too
   few candidates contribute all available rows and report the shortfall
   rather than silently shrinking the denominator.
3. Yield measurement — useful evidence by stratum.
4. Adaptive allocation — model effort to productive strata only, never uniform.
5. Rendezvous — never-co-occurring pairs gain threads only when indirect
   evidence (pronouns, events, context) connects them; absence of
   co-occurrence is not absence of relationship and never becomes a negative
   verdict. The build spec must specify how event, pronoun, or context
   discoveries connect never-co-occurring pairs (the 12,371), so they cannot
   remain invisible forever; no mechanism is prescribed yet. Co-occurrence is
   a candidate signal per literary-network findings, never proof; coreference
   gaps are the known miss class.
6. Persistence — every thread kept including empty and unresolved; new
   evidence grows threads.

Principle: guarantee investigative coverage structurally, spend model
inference where it adds information. Co-occurrence is not evidence: it opens
an investigation and establishes no interaction or relationship. A shared
passage may be incidental, contradictory, or merely referential. Threads stay
open until evidence is gathered and assessed. Exhaustive verdicts cost ≈2
hours by extrapolation from the measured rate (336 rows in 2m12s, ≈0.39s/call
on qwen3.5:9b) to 16,471 pairs — an extrapolation, not a measured full-book
runtime; per-pair evidence gathering (retrieval + context) is unmeasured,
and 12,371 never-sharing pairs need indirect-evidence work of unknown cost. The exhaustive-sweep rejection
rests on the unmeasured gathering cost and the never-co-occurring pairs — not
on the earlier 14-GPU-hour figure, which was unverified arithmetic (corrected
here, not silently). This design replaces it.

## Principles

Evidence accumulates; observations immutable; pairs investigated persistently;
sharing scoped; birth preserves lineage; identity separate; uncertainty
preserved; the model interprets and code mechanizes; the user proves; the
network survives model changes.

## Open decisions (open, not decided)

Birth edge cases, starvation caps. Costs and risks were not stated in the
approved text — open.
