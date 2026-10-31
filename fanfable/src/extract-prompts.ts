/**
 * Extraction prompts: the exact wording the reader is given.
 *
 * Prompt text only — application, salvage and parsing stay in lorebook.
 * lorebook.ts imports from here and re-exports the full prior public
 * surface; nothing else reaches a prompt except through lorebook or this
 * module. Bytes are locked: the suite pins every prompt's hash, so any
 * rewording, reordering, or whitespace drift fails the build on purpose.
 */
/**
 * What the first call asks for: people, peoples, places, things, groups,
 * creatures and rules, plus the facts the passages state — as JSON, one
 * window at a time. Facts ride along because both are short, noun-scoped
 * records, and the three-call split otherwise leaves them without a home.
 * Three narrow calls instead of one mega-prompt because the mega-prompt
 * taught us the failure: the reader answered the first schema and rushed
 * the rest, and one truncated answer lost the whole window.
 * The caller must never bank from this answer without the verbatim
 * checker, never run two extractions on one GPU, and always smoke a
 * single window before a full run.
 */
export const EXTRACT_ENTITIES_SYSTEM = `You read passages from a book and record the people, peoples, places, things, groups, creatures and rules they establish, and the facts the passages state.

Reply with JSON only:
{
  "entities": [
    {"kind":"character|species|faction|location|item|rule|creature",
     "name":"the name as the book gives it",
     "aliases":["other names or titles used here"],
     "summary":"one or two sentences on who or what this is",
     "attributes":{"any":"kind specific detail"},
     "role":"their role in the story, if it is a person",
     "status":"alive, dead, missing, ruined, unknown — if the book says",
     "chunk_index": 0,
     "evidence":"a short exact quote from the passage"}
  ],
  "facts": [
    {"topic":"the subject of the fact","statement":"what the book establishes",
     "kind":"rule|fact|background","certainty":"confirmed|inferred","subject":"name it concerns",
     "chunk_index":0,"evidence":"a short exact quote",
     "modality":"asserted|denied|possible|suspected — only include when not asserted"}
  ]
}

Entity kinds (choose exactly one):
- character — one named individual.
- species — a people or kind with members (a species, race, folk, lineage or bloodline).
- faction — an organisation, order, house, company, government, army or cult.
- location — a place, region, world, or building used as a setting.
- item — a named object, weapon, ship, artefact or substance.
- rule — a law, magic or system rule, custom or prophecy.
- creature — a non-people animal or monster: a named beast, or a kind of beast the book treats as wildlife.

Entity funnels:
- Common nouns are not entities. An unadorned common noun (a bat, a chair, a tree) never becomes an entity. Record what the passage says as a fact instead: subject = the named person or place it appeared with, topic = the noun, statement = exactly what the passage says, evidence = a verbatim quote. Never drop the information.
- One-scene props are not entities. A named thing that appears once and holds no role or tie stays a fact about the scene. It earns a row only when a later passage makes it matter.
- People get one species row. A people or kind with members gets one species entry; its individual members stay character and tie to it. An individual never gets a species row.
- Organisations are faction. A company, order, cult, senate, army or security force is faction, never character and never creature.
- Occupations are not entities. A job, rank or title (senator, captain, apprentice) is the person's role or attribute, never its own entity.
- Named individuals are character. A properly named person is character even when they appear once; proper names are not props.
- Resolve ambiguity by role. A creature or item is decided by whether the book treats it as alive; a faction or species by whether it is an organisation (faction) or a people (species). If it is still unclear, keep it a fact instead of an entity.

Rules:
- Only record what these passages support. Never fill gaps with general knowledge.
- Record people by the proper name the passages give. A description is never a new person: "the Potters' son" points at a named Potter when one is known, otherwise it is skipped. A thing or place is never a character.
- One person per entry. Never bank "A and B" as a single person: "Lily and James Potter" is two entries, not one. A family group ("the Potters") is never a character.
- chunk_index is the number shown in front of each passage. Use it for every entry.
- evidence must be a short phrase copied from the passage, not your own words.
- If the passages contain no new people, places or facts, return empty arrays.
- If the passage denies, doubts, or frames something as merely possible, record the claim normally but set modality to denied/possible/suspected with the denying quote as evidence; never store a denial as a plain fact.
- No prose outside the JSON.`;

/**
 * The shared rating questions: the same block the extraction reader and
 * the assess pass both ask, so a strength means the same thing in both.
 * Interpolated verbatim into the relations prompt and asked standalone
 * by the assess pass — one home, two uses.
 * The caller must never edit the questions for one pass without the
 * other; the scale only compares when the questions match.
 */
/** The shared rating questions: extraction and the assess pass use the same block. */
export const ASSESSMENT_QUESTIONS = `Before you rate, answer these questions about the quote.
Judge each one yourself; do not look for a rule to follow.

- Does the quote identify both people? A nickname or title counts if a reader
  would connect it. A pronoun counts if the passage makes the referent clear.
- Does the sentence state the relationship, or only imply it? Implication is
  fine if a careful reader would agree it is there.
- Where one person is referred to indirectly, how clear is the reference in
  the surrounding text?
- Is the kind right for what the sentence says? A correct pair does not rescue
  a wrong kind.
- Does the author sound certain, or is this hedged, doubted or denied?
- Given your answers, how strongly does this quote support the claim? Give a
  number from 0 to 1 and one sentence saying why.`;

/**
 * What the second call asks for: lasting ties between names already on
 * the roster — never a new name, never a moment (moments belong to
 * events). The KNOWN ENTITIES roster rides alongside, formatted by
 * formatKnownEntities.
 * Narrow because the relations verdict is the bank's most expensive
 * mistake: a wrong tie banks a false fact, while an empty answer costs
 * only a re-read.
 * The caller must hand it the roster exactly as banked and never let
 * the answer widen the cast.
 */
export const EXTRACT_RELATIONS_SYSTEM = `You read passages from a book and record relationships between the known entities listed below.

Reply with JSON only:
{
  "relations": [
    {"from":"a name from the list, exactly as written",
     "to":"another name from the list, exactly as written",
     "kind":"one of the defined relationship concepts, exactly as written",
     "kind_source":"the passage's own words that express the concept, copied verbatim",
     "description":"one sentence","chunk_index":0,"evidence":"a short exact quote",
     "anchor":"the sentence naming the other person when the quote names only one, copied verbatim; empty when the quote names both",
     "names_both": false, "other_person": "named|pronoun|role|absent",
     "asserted": true, "hedge": "certain|hedged|doubted|denied",
     "kind_fit": "yes|partly|no", "strength": 0.7,
     "why":"one sentence of reasoning",
     "modality":"asserted|denied|possible|suspected — only include when not asserted"}
  ]
}

Rules:
- "from" and "to" must both be names from the KNOWN ENTITIES list. Do not invent a name, and do not use a name that is not listed, even if it appears in the passage.
- Record only a lasting tie the passages state or clearly imply. A tie stays true pages later (family, lasting roles, friend or enemy). A moment happens once (met, gave, told, saw, wished, refused) and is never a tie: moments belong to events.
- Be exhaustive, not representative: list EVERY lasting tie the passages support — most windows contain several, and a long list is good while a missed tie is bad. When in doubt, include it with its quote and let the strength answer decide.
- evidence must be a phrase copied VERBATIM from the passage, not your own words. It may name one endpoint or both.
- When the quote names only one endpoint, put in "anchor" one contiguous sentence from the same passage, copied VERBATIM, that names the other person. Leave "anchor" empty when the quote names both.
- One relation per entry, with one kind. If two people have several relationships, write a separate entry for each.
- kind must be exactly one of the defined relationship concepts below; never invent a kind. kind_source must be the passage's own words that express that concept, copied verbatim from the quote.
- The direction matters: "from" is the one who has the relationship and "to" is the one it is to. If Harry is Petunia's nephew, it is from="Harry", to="Petunia", kind="nephew of".
- chunk_index is the number shown in front of each passage.
- names_both is true when the quote itself names both people; other_person says how the other side is named (named, pronoun, role, absent). asserted is true when the quote states the tie rather than only implying it. hedge is certain, hedged, doubted or denied. kind_fit is yes, partly or no. strength is your answer to the last question, from 0 to 1. why is one sentence of reasoning, stored for audit and never parsed.
- If the passage denies, doubts, or frames something as merely possible, set asserted=false, hedge to doubted or denied, and the low strength that follows; also set modality.
${ASSESSMENT_QUESTIONS}
- No prose outside the JSON.`;

/**
 * What the third call asks for: what happens, in order — the timeline.
 * Runs third so each answer stays complete and checkable on its own;
 * a failed section costs only that section.
 * The caller must never treat an event as a tie, however lasting it
 * sounds — happenings are indexed, not banked as relationships.
 */
export const EXTRACT_EVENTS_SYSTEM = `You read passages from a book and record what happens in them, in order.

Reply with JSON only:
{
  "timeline": [
    {"title":"what happens","summary":"one or two sentences",
     "when":"when it happens, in the book's words",
     "participants":["names as they appear in the passages"],
     "location":"where","chunk_index":0,"evidence":"a short exact quote"}
  ]
}

Rules:
- Only record events these passages actually narrate. Never fill gaps with general knowledge.
- One entry per distinct thing that happens; do not split one scene into many entries.
- participants are the people or creatures who take part, named as the passages name them.
- chunk_index is the number shown in front of each passage.
- evidence must be a short phrase copied from the passage, not your own words.
- If the passages narrate no event, return an empty array.
- If the passage denies, doubts, or frames something as merely possible, record the claim normally but set modality to denied/possible/suspected with the denying quote as evidence; never store a denial as a plain fact.
- No prose outside the JSON.`;

/**
 * Renders the KNOWN ENTITIES roster a relations call may use: names only,
 * exactly as banked, one per line. The caller's only naming rule is never
 * to add, widen, or guess a name that is not on this list.
 */
export function formatKnownEntities(names: string[]): string {
  return `KNOWN ENTITIES:\n${names.map((n) => `- ${n}`).join('\n')}`;
}
