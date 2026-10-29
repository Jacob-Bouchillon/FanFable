# Spec — kind labels as described concepts

**Date:** 2026-10-29
**Status:** design; not implemented
**Supersedes:** kind matching by head word plus a hand-written synonym list.

---

## 1. The rule

A label names a **concept**. Its description explains the concept and how it differs from its neighbours. Nothing in the code enumerates the English words that express it.

```
disliked
  Holds a negative opinion of, or aversion toward, another person, without
  declared opposition or conflict. Differs from enemy in that no side is
  taken and no harm is pursued; differs from distrust in that the feeling is
  about the person rather than their reliability.

enemy
  Actively opposes another person, fights them, or works against them.
  Differs from disliked in that conflict is open and harm is intended.
```

The model reads the descriptions and decides which concept a passage expresses. That is the semantic work; it is not delegated to a word list, because no list survives contact with a hundred books.

---

## 2. What the system checks

The guard cannot judge meaning, so it checks what is checkable:

1. **The label is one of the concepts.** The set stays closed so the bank stays queryable — "who dislikes whom" has an answer only if `disliked` exists as a label. The model maps the passage's wording onto a concept; it does not invent labels.
2. **`kind_source` appears verbatim in the quote.** The words the model says express the relationship must actually be there.
3. **The sentence links the anchor to *both* endpoints.** This is the check that a quoted anchor is not mistaken for proof. `assertsRelationship` must bind `kind_source` to the other endpoint as well as the subject; a quote that says "Harry loathed Snape" does not prove anything about Ron, even though "loathed" is real and Ron is named in the same passage.
4. **Direction resolves, or is left unknown** — per §3, only where the concept is directional.

Nothing else. In particular:

- the label itself need not appear in the quote — `disliked` is proven by a sentence that says "loathed", because the model mapped it;
- no synonym list is consulted, in the prompt or the guard;
- the head-word test and the `kind_source` substitution both go.

---

## 3. Concept boundaries and direction

Concepts that are easily confused get a stated boundary, in the description itself, with no vocabulary:

| Concept | Is | Differs from |
|---|---|---|
| disliked | personal aversion | **enemy**: no open conflict; **distrust**: about the person, not their reliability |
| enemy | active opposition, harm intended | **disliked**: conflict is open |
| trusted | confidence in someone's conduct | **loyal**: confidence is held by the truster, allegiance is given by the other |
| loyal to | allegiance given to someone | **trusted**: allegiance, not an assessment |
| protected by / protective of | safeguarding from harm | **mentor**: safety, not development |
| feared | emotional response to threat | **distrusted**: fear, not doubt about intentions |

Each concept declares whether it is **directional** or **symmetric**:

- directional — `enemy`, `mentor`, `teacher`, `bullied`, `protective of`, `obeyed`, `loyal to`, and the family set. Direction is checked; a reversed claim is refused.
- symmetric — `disliked`, `admired`, `trusted`, `distrusted`, `feared`, `friend`, `sibling`, `cousin`, `colleague`, `partner`. Either order is the same claim; direction is not enforced, and the pair is stored once.

This distinction is data on the concept, not a special case in the matcher.

---

## 4. Consequences, stated plainly

- **Semantic fidelity is the model's.** The system guarantees that a citation is real and that the anchor binds to the pair; it does not guarantee the label is apt. A model that calls "loathed" `enemy` is wrong in a way the guard cannot see.
- **A described concept is only as good as its description.** Bad descriptions produce bad labels; that is where effort goes, not into vocabulary lists.
- **Existing rows are untouched.** Rows banked under the old rule keep their kind; new extraction uses the new prompt and guard.

---

## 5. Evaluation set

Guard compliance is not accuracy. The change is judged on a fixed, hand-written set of passages with expected concepts, run through the new extraction and compared with the old one. No existing banked rows are modified.

| Case type | Example shape | Expected |
|---|---|---|
| same concept, different wording | three passages expressing aversion with different verbs | all map to `disliked` |
| near-miss concepts | aversion without conflict vs open opposition | `disliked` vs `enemy`, no crossover |
| co-occurrence only | two characters in one scene, no relationship stated | no proposal |
| three or more characters | anchor binds one pair, a third is present | only the bound pair is proposed |
| negation | "he did not trust her" | refused, or `distrusted` — never `trusted` |
| uncertainty | "perhaps she feared him" | not banked as asserted |
| change over time | friendship that later breaks | two time-scoped claims, not one timeless one |

Metrics: concept accuracy on the set, false proposals on the co-occurrence and three-character cases, and the count of labels the model chose outside the concept set (should be zero, since the set is enforced).

---

## 6. Tests

- a row labelled `disliked` whose quote says "loathed" passes, with `kind_source = "loathed"`;
- a row labelled `disliked` with no `kind_source` in the quote fails;
- a three-character passage where the anchor binds only one pair yields exactly one proposal;
- a label outside the concept set is refused, and the refusal names the allowed set;
- a symmetric concept accepts either order and stores one pair; a directional one refuses the reverse;
- the existing assertion fixtures pass unchanged;
- the glossary block contains every concept and no word lists.

---

## 7. Implementation order

1. Rewrite `KIND_GLOSSES` as descriptions; add the affect concepts; add the directional/symmetric flag.
2. Prompt: present concepts as descriptions; require `kind_source` verbatim.
3. Guard: keep the concept-set check, replace the head-word test with the `kind_source` check, enforce anchor-to-both-endpoints linkage.
4. Update `kind-glossary` tests; add the cases in §6.
5. Run the §5 evaluation set; report concept accuracy and false proposals.
6. Re-run extraction on one window to confirm labels come from the text's wording.

---

## Appendix — ontology changes

The 282 distinct kind strings seen across bank rows, parked notes and both sweep runs are evidence that the ontology needs cleaning, not that the bank needs a bigger synonym dictionary. Three separate actions, and one rule that governs them.

**Rule: usage in one book is not a reason to delete a concept.** `niece of`, `leader of` and `peer of` never occur in the test book and are perfectly valid relationships in other books. They stay. Only genuine duplicates and non-relationship labels are removed.

### Merge — same concept, different wording

| concept | keep as | variants absorbed |
|---|---|---|
| friend | `friend of` | friend, friendship, best friend, teammate |
| enemy | `enemy of` | enemy, enmity, adversary |
| spouse | `spouse of` | wife, husband, married, wife/husband |
| sibling | `sibling of` | brother, sister, older/younger/twin brother |
| parent | `parent of` | mother, father, son, daughter, child |
| relative | `relative of` | family, family member, kin |
| teacher | `teacher of` | teacher, authority figure/teacher |
| student | `student of` | student, study partner, apprentice |
| colleague | `colleague of` | colleague, coworker |
| master | `master of` | master, servant |
| ally | `ally of` | ally, companion |

Note on parent/sibling: keep the specific kinds (`mother of`, `father of`, `son of`, `daughter of`, `brother of`, `sister of`, `sibling of`) alongside the generic ones, because direction and kinship queries depend on them. The merge above is about *absorbing the model's wording*, not collapsing the specific kinds.

### Add — real relationship concepts with no label today

`rival of` (competition, distinct from enmity), `acquaintance`, `guardian of`, `employer of`, `customer of`, `owner of` (a person and their animal), plus the affect family from §3 of the main spec: `disliked`, `resented`, `feared`, `admired`, `trusted`, `distrusted`, `bullied`, `protective of`, `jealous of`, `loyal to`, `obeyed`.

### Remove — duplicates and non-relationships

- duplicates: `married to` (spouse of), `partner with` (partner), `assistant of` (aide of)
- scene descriptions, refused because they are not relationship concepts: `standing next to`, `blocked by`, `lamp-like eyes`, `host`, `enforcer`, `loves him because he hated harry's father`

`child of` and `partner with` are removed only as duplicates of kinds that already exist; neither is removed for being unused.
