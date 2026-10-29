# Spec — derived name variants (match-time only)

**Date:** 2026-10-29
**Status:** approved direction, not implemented
**Decision of record:** derive at match time; never store a derived alias.

---

## 1. Objective

Make an entity's stored name resolvable to the shorter forms the text actually uses — given name, surname, title-stripped name — without writing anything to the database, without merging entities, and without changing what counts as proof.

This is a **naming** change, not an acceptance change. The assertion guard stays exactly as it is. If the change makes more relationships acceptable, that is a consequence to be measured, not a goal.

### Why this comes first

Measured on the test book, sentences that name two roster characters and contain a kin noun:

| Naming input | sentences | guard accepts |
|---|---:|---:|
| stored names exactly, aliases as they are | 84 | 0 |
| plus first/surname variants | 208 | 13 (6%) |

With empty alias lists the guard cannot match "Harry" to the entity named "Harry Potter", so 84 of 84 fail before the assertion rule is consulted. Widening the assertion matcher first would buy almost nothing.

## 2. Rule

### 2.1 What is explicit and what is derived

- **Explicit**: the stored `name` and every string in `aliases`. These are usable unconditionally and are never filtered.
- **Derived**: everything this function generates. Derived forms are filtered (2.3) and never persisted, displayed, merged on, or written back to `canon_entity`.

### 2.2 Derivation

For each explicit form `b` (stored name first, then each alias), with canonical tokens `T`:

1. `canonicalName` applies: case, possessives, leading article, punctuation.
2. **Title-strip.** While `T.length > 1` and `T[0]` is a title token, drop `T[0]`. A token is a title when either:
   - it is in the universal honorific/kin-title set (Mr, Mrs, Miss, Ms, Dr, Doctor, Professor, Captain, Sir, Lady, Lord, King, Queen, Prince, Princess, Uncle, Aunt, Father, Mother, Brother, Sister, Grandfather, Grandmother), or
   - the number of entities whose stored name or explicit alias contains that token exceeds `NAME_DF_CAP`.
3. **Emit** from the (possibly stripped) token list:
   - the full form,
   - the title-stripped form, when it differs,
   - the **last** token (surname), when `T.length > 1`,
   - the **first** token (given name), when `T.length > 1`.

Single-token names emit only themselves. Ordering is deterministic: explicit forms in stored order, then full, stripped, surname, given.

### 2.3 Filters (derived forms only)

| Filter | Rule | Reuses |
|---|---|---|
| Minimum length | shorter than `NAME_MIN_TOKEN` (3) is dropped | `names.ts:20` |
| Common word | dropped when the **lowercase** form occurs in the source text, whole-word and case-sensitive | the exact predicate behind `quarantineSuspectCharacters` (`lorebook.ts:7373`), extracted to a shared helper |
| Roster collision | dropped when any **other** entity's stored name or explicit alias canonicalises to the same string | `canonicalName` |
| Duplicate | dropped when it equals one of the entity's own explicit forms | — |

The common-word filter must call the same extracted helper the quarantine uses. Do not reimplement a similar-sounding regex — the two policies then drift apart and one of them silently stops matching the other.

**The extraction is a pure refactor.** `quarantineSuspectCharacters` builds its predicate locally (`lorebook.ts:7373`): a whole-word, case-sensitive `\bterm\b` scan over all of the project's chunk text joined with a single space, applied to `name.toLowerCase()`. The shared helper must reproduce that exactly — same word boundaries, same case sensitivity, same input scope — and the quarantine must then call it and behave identically. `testing/tests/entity-quarantine.test.ts` must pass **unmodified**. If a test in that file needs editing, the refactor changed behaviour and is wrong.

Two limits this filter does not remove, and the measurement must not imply it does:

- A capitalised homograph — a title or place name that never appears lowercase — is not caught here; only roster collision sees it. "Dean" as a school title passes the lowercase test.
- The predicate is a full-text scan per term. That is seconds over a few hundred entities, and not worth optimising in this change. Precomputing a token set instead would risk diverging from `\b` semantics, which is the exact failure this section forbids.

Roster collisions are counted over **all entities in the project**, not characters only: a word that names a place is still ambiguous in prose. Collisions are **not resolved**. Two entities sharing a given name both lose that variant, and the ambiguity stays visible in the measurement.

### 2.4 What this deliberately does not do

- Does not merge entities, however similar the names.
- Does not resolve "Harry" when two roster rows both claim it. That is the duplicate-identity problem, which needs its own fix.
- Does not touch the assertion guard, `namesBothDistinctly`, or any promotion threshold.
- Does not infer the gender or number of any entity.

## 3. Shape of the change

One function, one roster index, no storage.

```
// names.ts
export function occursLowercaseInText(text: string, term: string): boolean
export function deriveNameVariants(
  row: { name: string; aliases: string[] },
  index: RosterIndex,
): string[]                       // explicit forms first, then derived
export function buildRosterIndex(
  rows: { name: string; aliases: string[] }[],
  text: string,
): RosterIndex
```

The index is built **once per command** and passed down. Proof functions keep their current signatures and receive the variant list where they currently receive `row.aliases`; every proof call site keeps working with explicit aliases when no index is supplied, so behaviour is unchanged for callers that do not opt in.

Call sites to route through it:

| File | What |
|---|---|
| `fanfable/src/lorebook.ts` | `mentionSpans`, `assertsRelationship` (`spansOf`), `namesBothDistinctly`, `endpointTokens` / `quoteDirection`, `anchorNamesMissingEndpoint` |
| `fanfable/src/lorebook.ts` | `scanSentenceCandidates` — currently matches full names only (`lorebook.ts:5458`) |
| `testing/trials/adjudication/name-sweep.ts` | replace the inline form builder; it is why "The" became a name form and swept a noise entity 334 times |
| `fanfable/src/lore-ask.ts` | endpoint mention checks in the answer guard |

No new dependency, no migration, no column.

## 4. Measurement before any acceptance change

Produce a counts-only report per book:

1. entities in roster; entities yielding zero matchable variants.
2. variants retained, by type (full / stripped / surname / given).
3. dropped: too short, common word, roster collision, duplicate.
4. the §1 table re-run with derived variants: sentences, accepts, rejects; rejects split by "contains a possessive pronoun" vs not.
5. gold set: how many of the 226 rows' endpoints become resolvable in their own quote, where they were not before. Counts only — do not open verdicts.
6. blind adjudication of a sample of up to 30 **newly resolvable** quotes, judged supported / context / unsupported by a pass that does not see which variant unlocked them.

Report 1–5 before 6, and 6 before any decision to promote.

## 5. Tests — `testing/tests/name-variants.test.ts`

Positive:
1. "Aunt Petunia Dursley" with no collisions yields `petunia dursley`, `petunia`, `dursley`.
2. A df-based title token is stripped; `NAME_DF_CAP` boundary tested on both sides.
3. Proof integration: a quote naming only "Petunia" satisfies the endpoint "Aunt Petunia Dursley" when the index is supplied.
4. Scan integration: a sentence naming only "Harry" yields a candidate for "Harry Potter" when unique.

Negative:
5. "Aunt Petunia looked over at Dudley" is still rejected with variants enabled. This is the regression that matters most.
6. Collision: two entities sharing a given name — both lose it; no merge; both still match their full names.
7. Common word: a variant whose lowercase form occurs in the text is dropped (the "Dean" / "Mark" / "Will" class).
8. `namesBothDistinctly` still refuses a single surface string as both endpoints.
9. Passing no index reproduces current behaviour byte for byte on the existing fixtures.

Hygiene:
10. `aliases` and `name` are unchanged in the database after a full extraction pass — compare before/after.
11. Two runs over the same database produce identical variant maps.
12. `The Ticket Inspector` yields no derived variant that occurs in the text; the sweep matches zero sentences for it and reports it, rather than sweeping common words.

## 6. Acceptance criteria

```
npm run typecheck
npm test
```

- typecheck clean; all existing tests pass, including `exact-endpoint-proof`, `quote-endpoints`, `assertion-fixtures`, `can-promote`, `name-linking`, `name-roster`.
- No schema change; `git diff` touches no migration.
- Determinism and no-write tests (10, 11) pass.
- Negative fixtures (5–8) pass.
- The §4 report exists, with counts only, before any guard work starts.

## 7. Boundaries

**Must not change:** the assertion rule, promotion tiers, `namesBothDistinctly`, entity merging, quarantine, any migration, any stored alias.
**Must not do:** write derived variants anywhere; use them in `lore-ask` answers as if the text said them; treat a roster-unique variant as sentence-unique.
**Stop and report** if: a negative fixture flips; the derived-variant accept count exceeds the name-only ceiling by more than newly resolvable sentences can explain; or the change requires touching more than the files listed in §3.
**Timing:** run 2 of the frozen sweep is in flight. Do not edit `testing/trials/adjudication/name-sweep.ts` until it completes, or run 2 stops being comparable to run 1.

**Rollback:** one commit confined to `names.ts`, `lorebook.ts`, `lore-ask.ts`, the sweep, and one new test file. `git revert` restores exact prior behaviour; nothing is stored, so no data repair is needed.

## 8. Optional, out of scope

An entity whose stored name and every explicit alias have zero occurrences in the source ("The Ticket Inspector" is the pattern) is evidence of a bad extraction, but quarantining it is a separate rule with its own risk. Report the count; do not act on it in this change.
