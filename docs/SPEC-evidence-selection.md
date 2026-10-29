# Spec — deterministic evidence selection

**Date:** 2026-10-29
**Status:** design approved; steps 1–3 only
**Supersedes:** the "give the model a bigger event pool" approach in `planner.ts` and `controller.draftPlan`.

---

## 1. Why the current approach stops here

Five drafts of the same outline were run against the same book, premise and model. Each round fixed a real defect, and each fix exposed the next:

| Round | Fix | What it exposed |
|---|---|---|
| v1 | none | planner had no relationships; invented a first meeting |
| v2 | cast-tie block | scene adaptations returned empty |
| v3 | better model | canon events table was empty |
| v4 | complete event index | every scene cited a chapter heading |
| v5 | heading filter + full pool | five of seven scenes cited one broad event |

v5 is the decisive one. With headings removed and the whole index available, the model did not choose better evidence — it chose the next broadest valid id. Seven scenes, two specific citations, five defaults to `Arrival at Hogwarts Platform`.

That is not a prompt problem. Asking a model to navigate a large pool and select the most specific support produces the least specific thing that is technically valid. The selection has to happen before the model sees anything.

---

## 2. Shape

```
scene requirements            characters, required claims, constraints, position
        │
        ▼
retrieval (impure)            load events, entities, aliases, references
        │
        ▼
selector (pure)               normalize → filter → rank → validate
        │
        ▼
packet                        supported claims + context + explicit gaps
        │
        ▼
validation (impure)           ids and references re-checked against the db
        │
        ▼
planner / writer              consume the packet; may propose, may not certify
        │
        ▼
continuity                    compares the draft against the packet's claims
```

The model's job shrinks to writing prose that honours supplied evidence. It stops being the thing that decides what the evidence is.

---

## 3. Scene requirements

A scene must state what it needs before anything is retrieved. Stored in the existing outline JSON — no migration.

```json
{
  "title": "The Sort",
  "characters": ["Harry Potter", "Dudley Dursley"],
  "requires": [
    "the Sorting ceremony places first-years into houses",
    "Dudley is placed in Gryffindor"
  ],
  "constraints": ["first-years arrive by boat", "the ceremony precedes the feast"],
  "timeline": { "after": null, "before": null }
}
```

Rules:

- `characters` are roster names, resolved by retrieval. Unknown names are preserved as unresolved, never guessed.
- `requires` are short claims in plain language. They are what the selector validates against and what continuity later verifies.
- `timeline.after` / `before` are canon event ids where known. This is ordering, not dates (see §9).
- A scene with no `requires` yields a packet with no support and says so; it does not inherit a catch-all event.

### 3.1 Normalisation, not literal matching

Claims and event text are normalised before comparison:

- lowercase, possessives stripped, punctuation removed, common stopwords dropped;
- a small synonym table maps inflections and near-synonyms onto one stem — `sorted`, `sorting`, `placed`, `assigned`, `sorted into` → `sort`; `arrived`, `arrival` → `arriv`; `gryffindor` stays as-is.

The table is explicit, testable and small. It is not an embedding or a model call. Where no reliable match exists, the claim becomes a gap — never a broad event.

---

## 4. Layers

Three separate pieces, so ranking is testable without a database.

**4.1 Retrieval (impure).** Given a project and scene requirements, loads: candidate events whose participants resolve to any scene character, the entities and aliases needed for that resolution, and each candidate's source reference. Also loads events inside any timeline window even when the participant match is indirect.

**4.2 Selector (pure).** `selectEvidence(requirements, records) → Packet`. No database access, no model call, deterministic. `records` are plain objects; tests call this directly.

**4.3 Validation (impure).** `validatePacket(db, projectId, packet) → { ok, problems[] }`. Re-checks that every cited id exists, belongs to the project, and that its locator matches the stored event. The selector's output is never trusted without this.

---

## 5. Relevance and support are different

Every candidate is scored on two axes, and the packet keeps them apart.

- **Scene relevance** — is this event appropriate background for this scene? Participants overlap and location are enough.
- **Claim support** — does this event actually establish this claim? Requires a non-name term match against the normalised claim, plus participant overlap.

A packet has three sections:

```json
{
  "support":  [ { "claim": "...", "eventId": 203, "title": "...", "locator": "...", "score": 0.8, "why": "..." } ],
  "context":  [ { "eventId": 150, "title": "...", "locator": "...", "why": "shares both characters; background only" } ],
  "gaps":     [ { "claim": "...", "reason": "no-event" } ]
}
```

`support` is proof. `context` is scene material and may never be cited as proof. Anything that fails support becomes a gap; anything relevant but unsupported may appear in `context`.

Validation rule: a candidate enters `support` only if it shares a character **and** matches at least one non-name claim token after normalisation. Character overlap alone can only reach `context`.

---

## 6. Reuse is allowed, catch-all is not

Scenes may legitimately share an event — several scenes can depend on the same ceremony. The failure to catch is one event being used as blanket support.

- Reuse is allowed when each claim validates independently.
- Reuse is flagged when a single event supports three or more claims whose normalised term sets are disjoint. The packet records a `suspiciousReuse` note; it does not silently drop the support.

---

## 7. Packet bounds

At most six `support` entries and six `context` entries per scene, each with id, title, locator and a one-line reason. Gaps are unbounded but deduplicated by claim.

---

## 8. Model contract

- Citations must come from `support`. Ids from `context` or outside the packet are dropped with a warning.
- A model may propose an event; the selector validates it and either promotes it or rejects it. Proposing does not certify.
- **A gap is not an instruction to invent.** If the packet has a gap, the writer may omit the claim, keep it uncertain, or state that the information is missing. What it must not do is assert canon that no packet event supports. It is not obliged to announce every gap.

---

## 9. What this does not solve

**Calendar chronology.** `time_label` carries time of day ("Morning", "Night"), not dates. A complete index and a perfect selector still cannot tell that Halloween follows the start of term. That needs its own representation and its own spec.

**Entity duplication.** The roster holds `Harry` and `Harry Potter` as separate rows. The selector resolves through the naming layer, but it does not merge them, and it must not start to.

---

## 10. Acceptance criteria

1. The Sorting scene's claim "Dudley is placed in Gryffindor" is supported by the Sorting event (id 203 in the test book), and `Arrival at Hogwarts Platform` appears at most in `context`.
2. The magical-Dudley divergence resolves to support for the Hagrid/Dursley scene, or is an explicit gap. It cannot resolve to an unrelated event.
3. No claim is supported by an event that shares only a character.
4. Unresolved participants and missing evidence are reported, never substituted.
5. Legitimate reuse passes; one event supporting three or more claims with disjoint terms is flagged.
6. Confirmed relationships, planner behaviour and event extraction are unchanged.
7. Tests cover correct selection, deliberate failure when suitable evidence does not exist, and the normalisation table.

---

## 11. Implementation order

1. Packet, claim-support and requirement types.
2. Pure selector and the normalisation table.
3. Tests: seven-scene fixture, Sorting, magical-Dudley divergence, missing evidence, unresolved participants, suspicious reuse.
4. Measure selection quality against the fixture — no prompt changes yet.
5. Wire packets into planner and writer.
6. Validate citations against packets; continuity against claims.
7. Calendar chronology, separately.

Steps 1–3 are the agreed checkpoint. Nothing in the planner, writer or prompts changes until the selector passes its fixtures on its own.
