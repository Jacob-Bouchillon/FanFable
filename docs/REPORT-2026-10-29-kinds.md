# FanFable — kinds, sweep, and evidence checkpoint

**Date:** 2026-10-29
**Branch:** `experiment/evidence-scan`
**State:** 616 tests passing, `tsc` clean, no migrations added.

This supersedes `REPORT-2026-10-29-final.md` for the relationship work. The earlier document remains the system inventory.

---

## 1. What changed in this checkpoint

### 1.1 Relationship kinds are described concepts

`KIND_GLOSSES` no longer carries a synonym list. Each concept has:

- a **description**: what it is and how it differs from its nearest neighbour;
- a **direction**: `directional` (family, office, conflict) or `symmetric` (friend, sibling, disliked, admired, trusted).

The synonym lists and `KIN_GROUPS` were deleted. Nothing in the code enumerates English words for a relationship.

Concepts added: `rival of`, `acquaintance`, `guardian of`, `employer of`, `customer of`, `owner of`, and the affect family — `disliked`, `resented`, `feared`, `admired`, `trusted`, `distrusted`, `bullied`, `protective of`, `jealous of`, `loyal to`, `obeyed`.

Concepts removed as duplicates: `married to`, `partner with`, `assistant of`. Specific kinship kinds were kept.

### 1.2 The guard checks a citation, not a grammar

- The model returns `kind_source`: the passage's own words that express the relationship.
- The guard requires that citation to appear verbatim in the quote (or the anchor), replacing the head-word test.
- The `kind_source` substitution loophole is closed: `enemy of` can no longer ride on "hated".
- Reverse direction is enforced only for directional concepts.
- Denial and hedge markers are checked against the **source sentence**, not the model's sub-span, so a quote cannot drop a preceding "perhaps".

### 1.3 The name sweep is now a product capability

`fanfable/src/sweep.ts` and `lore sweep [--name] [--batch] [--limit]`.

It walks each character's mentions in reading order, asks for line numbers, fetches quotes by index, and writes each derived pair to `canon_tie_note` as a proposal — `reason = 'sweep-proposal'`, verbatim evidence, source reference. It never writes `canon_relation`, never overwrites a row, and skips pairs that already hold a keeper.

### 1.4 Relationship views

- `lore relationships` — one line per pair, strongest status first, with the best locator and duplicate count.
- `lore proposals` — pending proposals that never reached the bank, with the guard's reason.

Both collapse inverse rows and duplicate roster names into one pair.

### 1.5 The evidence selector (built, not wired)

`fanfable/src/evidence.ts` and `evidence-retrieval.ts` implement the deterministic selector from `docs/SPEC-evidence-selection.md`: scene requirements in, a packet of `support` / `context` / `gaps` out, with claim-type routing between `canon_event` and `au_event`.

It is complete and tested but **not connected to the planner**. v5 showed the planner choosing one catch-all event for five scenes; the selector is the proposed fix and has not been adopted yet.

---

## 2. Measurements

| Measure | Result |
|---|---|
| test suite | 616 pass, 0 fail |
| kind-label evaluation (qwen3.5:9b, 3 runs) | 6/6 concept mapping each run; 0 false proposals; 0 co-occurrence proposals; 0 wrong three-character pairs |
| sweep on the test book | 77 characters, 133 proposals, 122 distinct pairs; queue 258 notes (133 sweep, 120 unsupported, 5 open-vocab) |
| sweep quotes verbatim | 132 of 133 |
| sweep quotes naming both endpoints | 12 of 132 (9.1%) |
| accepted-row audit | 21 audited, 20 demoted, 1 kept |
| proposal negative control (ARF) | 50 no-relation chunks → 2 with a proposal (4%); 50 positive chunks → 42% recall |
| bank | 164 relations: 23 user_confirmed, 1 accepted, 122 provisional, 18 needs_review |
| canon events | 392, covering passages 0–523 of 527 |

One earlier evaluation run scored 5/6 and emitted `loathed` as a label. It parked rather than banked — the failure mode the concept set exists to catch.

---

## 3. Decisions recorded

1. **The model judges relationship nuance; the code records and verifies.** Code cannot define what a relationship is without hard requirements that either reject true ties or admit scenes. Both failures were measured.
2. **Labels are concepts; descriptions carry meaning.** No synonym lists in code. An example may appear in a prompt; it is never a gate.
3. **Evidence of a citation is mechanical.** The only things code certifies are that the quote exists in the source, that the entities exist, and that they are not the same person.
4. **Confidence replaces proof.** The next change (`docs/SPEC-claim-confidence.md`) has the model return its assessment and a confidence, with the code applying an author-set threshold and a calibration table measured against the blind-labelled rows.
5. **Unused is not invalid.** Concepts were not removed for being absent from one book; only duplicates and non-relationships were removed.

---

## 4. Known limits

- **Time-scoped relationships are not stored.** A friendship that later breaks cannot be banked as two claims; `canon_relation` has no time-scope field and adding one is a migration.
- **Notes carry citations inside `source_refs`.** `canon_tie_note` has no `kind_source` column.
- **The scan finds only concept words.** It will not propose "loathed" for `disliked`; the relations path does, via the citation.
- **`lore-ask.ts` still references the removed kinds** (`partner with`, `married to`) in hint strings. Old rows remain readable; the hints should be remapped.
- **The sweep proposes, it does not prove.** Nine in ten of its quotes name one person. It is a queue filler.
- **The selector is unwired**, so scene grounding is unchanged from v5.

---

## 5. Next

1. Implement `SPEC-claim-confidence.md`: model assessment fields, threshold, calibration against the labelled rows.
2. Re-measure the bank at the chosen threshold: how many ties, and their supported rate.
3. Remap the `lore-ask` hints and decide whether time-scoping earns a migration.
