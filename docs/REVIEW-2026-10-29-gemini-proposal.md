# Review — Gemini's proposal for widening assertion coverage

**Date:** 2026-10-29
**Reviewed:** "The Architecture of the Decision" + "Coder Task: Widen Assertion Coverage in `canPromote()`"
**Method:** every claim about current behaviour was checked against `fanfable/src/lorebook.ts` and `fanfable/src/names.ts`, and the pattern list was run through `assertsRelationship()` directly as a probe (no database, no model). Results below are measured, not inferred.

---

## 1. Verdict

The **philosophical call is correct** and matches the product's own rules: a pronoun bound across sentences is an inference, and an inference must not set a status. Where the proposal fails is the **implementation scope**. Two of its five listed patterns must never pass, one is a pronoun binding dressed up as a structural rule, and four of the remaining cases already pass today — so a Coder following the prompt literally would rewrite working logic and simultaneously reopen the false-positive class the assertion guard was built to close.

The proposal also estimates the payoff at 50–65% recall. That number is unsupported, and the reasoning behind it treats "the relationship is stated with a pronoun" as the whole of the gap. Part of the gap is a different problem the proposal never names.

---

## 2. What the proposal gets right

| Point | Why it holds |
|---|---|
| Keep `accepted` reserved for deductive single-span proof | Matches `canPromote`'s contract; status is set by code, never by confidence |
| Cross-sentence pronoun resolution stays provisional | Genuinely unprovable without a parser; the failure mode is silent bank corruption |
| Title detection without a data migration | Correct layer. `NAME_DF_CAP` already defines a title as a token carried by many entities; using it at proof time touches no stored row, no graph key, no evidence reference |
| Both endpoints must remain explicitly present | Consistent with `namesBothDistinctly` |
| Negative test for unbound pronouns | Right instinct, wrong fixture — see §4.2 |
| Run `lore integrity` after the change | Correct regression gate |

The verdict paragraph — omission is cheaper than corruption — is the right reason to reach the right answer.

---

## 3. Measured check of the pattern list

Each sentence was passed to `assertsRelationship()` with the kind that matches its kin noun. `true` means the current guard already accepts it.

| Sentence | Kind | Current guard | Proposal's claim |
|---|---|---|---|
| "Vernon's wife, Petunia, entered the room." | `wife` | **passes** | listed as missing |
| "Dudley, son of Vernon." | `son of` | **passes** | listed as missing |
| "Petunia was Dudley's mother." | `mother of` | **passes** | not listed |
| "Aunt Petunia looked over at Dudley." | `aunt of` | rejects | **proposed as proof** |
| "Aunt Petunia Dursley took Dudley to London." | `aunt of` | rejects | **proposed as proof** |
| "Petunia left the house with her husband Vernon." | `husband of` | rejects | proposed as proof |
| "Vernon nodded; his wife, Petunia, said nothing." | `wife of` | rejects | barred by its own carve-out |
| "Petunia and her brother Vernon argued." | `sister of` | rejects | proposed as proof |
| "Petunia was married to Vernon." | `married to` | rejects | not properly specified |

Three findings follow.

**The appositive and of-phrase cases already work.** The existing possessive branch (`words[i-1] === "'s"`, owner must be a named span, other endpoint within four words) covers "Vernon's wife, Petunia". The of-phrase branch covers "Dudley, son of Vernon". Asking a Coder to add these invites a rewrite of logic that is already correct and already tested — the most likely outcome of "expand the matchers" is a regression on cases that pass today.

**The kin-group pattern is the exact bug the guard exists to stop.** "Aunt Petunia looked over at Dudley" does not assert that Petunia is Dudley's aunt. "Aunt" is a title she carries; the sentence links her to Dudley only by looking at him. The header comment on `assertsRelationship` names this shape as the thing a leading title must not be allowed to prove. Implementing pattern 1 restores the pre-guard false-positive rate while the accepted count rises, which will read as success in the acceptance criteria the prompt proposes.

**The "with her husband" pattern is a pronoun binding, not a structural one.** The sentence names both people, but "her" must bind to the subject. Two problems: the current guard has no "with" branch at all, so the case actually fails for mechanical reasons the proposal never diagnoses; and binding "her" is the same operation Option A says must stay provisional. Apposition binds the *noun*, not the pronoun — "Vernon nodded; his wife, Petunia, said nothing" is equally grammatical and binds "his" to the wrong man. The proposal's carve-out therefore contradicts its own verdict.

---

## 4. The three defects in detail

### 4.1 Pattern 1 asserts nothing

A title is a fact about the title-holder, not about the person standing next to them. Accepting it also creates a second, worse failure: the tie direction is unknowable, because "Aunt Petunia" does not say whose aunt. Whatever direction the model happened to emit becomes banked canon.

### 4.2 The negative test does not cover the risky case

The proposed rejection fixture is "Vernon entered. His wife smiled." — cross-sentence, which the proposal already bans. The case its own carve-out lets through is same-sentence and ambiguous: "Vernon nodded; his wife, Petunia, said nothing." A test suite built from the proposal's list would pass while the guard admits a wrong tie.

### 4.3 Title stripping is right, but the match target is too loose

Allowing a quote token to match "Petunia" against the entity "Petunia Dursley" changes what "both endpoints named" means. `names.ts` documents PROOF as deliberately exact — "whole-token equality only; no edit distance, no substring, no partial" — precisely so two people sharing a given name cannot satisfy each other's endpoint. The safe form strips title tokens from **both** the entity name and the quote span and then requires the remainder to match as a contiguous run containing the longest name token (normally the surname). That keeps "Aunt Petunia" → "Petunia Dursley" working and keeps "Petunia" alone from proving a tie to a different Petunia.

---

## 5. The issue the proposal does not address

In the 26 verified quotes from the whole-book cloud read, the second party is regularly named by **role**, not by name: "his father", "my best friend", "his onetime rival". A flawless pronoun binder does not convert "his father" into the bank entity named Henry Gatz. That is a role-to-entity inference, independent of coreference, and no assertion rule touches it.

This is why the 50–65% estimate should be treated as unknown. Assertion widening recovers only the subset where the other endpoint is *named* in the sentence or its neighbour. Where the text says only "his father", three separate things must hold: the pronoun binds to the right person, the role binds to the right entity, and the role is unique among that character's relations. The third is not even decidable from a single sentence.

## 6. The dependency the proposal does not budget

"Distance / uniqueness" appears in the diagram as if it were free. Counting candidate antecedents requires knowing each character's gender and number. `canon_entity` stores name, aliases, kind, mentions and review status only — no gender, no number. Deriving it is feasible from pronoun co-occurrence across a character's mentions, but it is new work, it is itself a heuristic, and it must be in place before a uniqueness rule can be tested.

---

## 7. Secondary problems

- **Direction.** The prompt says to verify `parent_of` vs `child_of` from syntactic order. The observed failure is upstream of that: kinds arrive with direction baked into the label — the running sweep already emitted `Vernon Dursley (wife/husband)` and `Vernon Dursley (husband)` for the same pair. Direction checking cannot repair a label that encodes both directions; canonicalisation has to run first.
- **Acceptance criteria are biased.** "Confirm precision remains high" measured on the existing 42-row accepted set cannot detect new false positives, because those rows were selected by an older, weaker guard. Precision must be measured on **rows the new rules alone admit**, adjudicated blind.
- **The prompt lacks scope controls.** It grants "expand", "widen", and "co-occurring prepositional phrases" without a closed list of sentences that must pass and sentences that must fail. It also omits an explicit must-not-change list, a backup step, and a stop condition. Under Tier 0/1 that is not implementable; under Tier 2 it is an invitation to redesign the guard.

---

## 8. What a safe widening looks like

Three tiers rather than two. Only the middle one is a decision.

| Tier | Shape | Status |
|---|---|---|
| A | Both endpoints named; kin noun linked by possessive, of-phrase, appositive, copula or SVO | `accepted` (mostly built) |
| B | One endpoint named, pronoun bound **within the same sentence**, exactly one viable antecedent | disputed |
| C | Pronoun bound across sentences, or the other party named by role only | `provisional` |

Tier A's genuine gaps, all deductive and testable:

1. Copular prepositional pairs: "X was married to Y", "X was engaged to Y", "X worked for Y". No branch covers these today.
2. Title-stripped endpoint matching, bounded as in §4.3.
3. Kin-group *anchors* where the group noun is itself the relation and both parties are named in the same clause ("the Weasley brothers", "the Dursley family") — group membership, not individual assertion; only if the group noun and both names sit in one clause.

Tier B is where the practical recall lives, and it is measurable against the existing gold set: take the 42 rows the strict guard rejected, tag which are tier B, blind-adjudicate those, and read the rate. That number decides whether tier B may be `accepted`. Everything in tier C stays provisional regardless.

## 9. Verification plan for whichever widening is approved

- **Fixtures first, written as sentence → kind → expected verdict**, including the four negative cases in §3 that must stay rejected. A widening that flips any of them is rejected outright.
- **Blind precision on newly admitted rows only**, not on the historical accepted set.
- **Recall read on the 42-row strict-mode set**, so the trade is visible as a pair of numbers rather than one.
- **`lore integrity`** for zero database regressions.
- **Rollback:** the change is confined to `lorebook.ts` and `names.ts` plus fixtures; `git diff` on those two files is the undo path. No migration, no stored-string rewrite.

## 10. Decision

Everything except tier B is safe to specify now. Tier B needs one answer from you: **may a same-sentence pronoun binding with a unique antecedent count as `accepted`, or does it stay `provisional` like the cross-sentence case?**
