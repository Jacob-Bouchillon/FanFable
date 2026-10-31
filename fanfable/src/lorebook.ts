/**
 * Extracted book lore.
 *
 * The text index tells you *where* something was said. This module pulls
 * *what the book says* out into structured form: the people, places, things
 * and rules that exist, the relationships between them, the facts the source
 * supports, and the book's own timeline.
 *
 * Every entry keeps the passages it came from, so nothing here is a black box:
 * the UI can show the evidence, and the writer can be grounded in facts rather
 * than in a wall of retrieved text.
 */
import { Db, fromJson, nowIso, strList, toJson } from './db.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { asRecordArray, extractJson, salvageJsonArray, toStringArray } from './json.ts';
import type { LlmClient } from './llm.ts';
import { embedMissing, type EmbedFn } from './embeddings.ts';
import { CORROBORATION_CAP, tripleKey, rankRows } from './edge-rank.ts';
import { noteFromExtraction, starvedWindowScores } from './note-ingest.ts';
import { recordRuling } from './ruling.ts';
import { findHeadings, lexicalScore, splitSentences, tokenize, truncate } from './text.ts';
import {
  ANSWER_CUE_STOPWORDS,
  KIND_PARTICLES,
  KINSHIP_CUES,
  MOMENT_WORDS,
  PROOF_FILLER,
  PROOF_TITLES,
  STOPWORDS,
} from './vocab.ts';
import { SEARCH_CANDIDATE_POOL } from './search-policy.ts';
import {
  buildRosterIndex,
  canonicalName,
  deriveNameVariants,
  linkTokenMatch,
  linkTokensMatch,
  lowerOccurrencesInText,
  nameMentionedExact,
  nameMentionedFromTokens,
  nameRelation,
  nameTokens,
  NAME_DF_CAP,
  NAME_MIN_TOKEN,
  textTokenSet,
  type RosterIndex,
} from './names.ts';
export { canonicalName, nameRelation, nameTokens } from './names.ts';

/* ------------------------------------------------------------------ models */

export type EntityKind = 'character' | 'species' | 'location' | 'item' | 'rule' | 'faction' | 'creature';

export interface CanonEntity {
  id: number;
  kind: EntityKind;
  name: string;
  aliases: string[];
  summary: string;
  attributes: Record<string, string>;
  role: string;
  status: string;
  firstChunk: number | null;
  evidence: string;
  sourceRefs: { source: string; locator: string; chunk?: number }[];
  mentions: number;
  reviewStatus: string;
}

export interface SupportingEvidence {
  quote: string;
  sourceRefs: { source?: string; locator?: string; chunk?: number }[];
  reason: string;
  movedAt: string;
  /** The model's assessment, when this item carries one. */
  assessment: ClaimAssessment | null;
}

export interface CanonRelation {
  id: number;
  fromId: number;
  fromName: string;
  toId: number;
  toName: string;
  kind: string;
  description: string;
  evidence: string;
  /** Display-only superseded quotes; never cited or answered. */
  supportingEvidence: SupportingEvidence[];
  modality: string;
  conflictStatus: string;
  ledgerState: string;
  scope: string;
  reviewStatus: string;
}

export interface CanonFact {
  id: number;
  topic: string;
  statement: string;
  kind: string;
  certainty: string;
  subject: string;
  evidence: string;
  sourceRefs: { source: string; locator: string; chunk?: number }[];
  modality: string;
  conflictStatus: string;
}

export interface CanonTimelineEntry {
  id: number;
  eventId: number | null;
  seq: number;
  title: string;
  summary: string;
  when: string;
  participants: string[];
  location: string;
  evidence: string;
}

/* ------------------------------------------------------------- extraction */

export const EXTRACT_SYSTEM = `You read passages from a book and record what the book establishes, as structured notes.

Reply with JSON only:
{
  "entities": [
    {"kind":"character|species|faction|location|item|rule|creature",
     "name":"the name as the book gives it",
     "aliases":["other names or titles"],
     "summary":"one or two sentences on who or what this is",
     "attributes":{"any":"kind specific detail"},
     "role":"their role in the story, if it is a person",
     "status":"alive, dead, missing, ruined, unknown — if the book says",
     "chunk_index": 0,
     "evidence":"a short exact quote from the passage"}
  ],
  "relations": [
    {"from":"name","to":"name","kind":"one short phrase, such as 'sibling of'",
     "description":"one sentence","chunk_index":0,"evidence":"a short exact quote",
     "modality":"asserted|denied|possible|suspected — only include when not asserted"}
  ],
  "facts": [
    {"topic":"the subject of the fact","statement":"what the book establishes",
     "kind":"rule|fact|background","certainty":"confirmed|inferred","subject":"name it concerns",
     "chunk_index":0,"evidence":"a short exact quote",
     "modality":"asserted|denied|possible|suspected — only include when not asserted"}
  ],
  "timeline": [
    {"title":"what happens","summary":"one or two sentences","when":"when it happens, in the book's words",
     "participants":["names"],"location":"where","chunk_index":0,"evidence":"a short exact quote"}
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
- chunk_index is the number shown in front of each passage. Use it for every entry.
- evidence must be a short phrase that appears in the passage, not your own words.
- One relation per entry, with one kind. If two people have several relationships,
  write a separate entry for each.
- The direction matters: "from" is the one who has the relationship and "to" is
  the one it is to. If Harry is Petunia's nephew, it is from="Harry Potter",
  to="Aunt Petunia", kind="nephew of".
- If the passages contain no new people or facts, return empty arrays.
- If the passage denies, doubts, or frames something as merely possible, record the claim normally but set modality to denied/possible/suspected with the denying quote as evidence; never store a denial as a plain fact.
- No prose outside the JSON.`;

/*
 * Phase 1: the extraction is split into three small calls per window instead
 * of one large one. A 7-8B model given four schemas at once answers the first
 * one and rushes the rest, and a single truncated answer loses the whole
 * window. Three narrow calls each produce a complete, checkable answer, and a
 * failed section costs only that section.
 *
 *   (a) entities + facts   (b) relations between known names   (c) events
 *
 * Facts travel with the entities call: both are short, noun-scoped records,
 * and the plan's three-call split otherwise leaves them without a home.
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
 * Three invented examples for the relations call, off by default.
 *
 * Set FANFABLE_REL_FEWSHOT=1 to append them. They show the one distinction the
 * rules ask for: a lasting tie with its exact quote, a moment that must not be
 * banked, and a passage naming only one endpoint. No source content.
 */
export const EXTRACT_RELATIONS_FEWSHOT = `Examples (invented names):
Passage: "Asha is Bram's sister, and the hall has always known it."
Relation: {"from":"Asha","to":"Bram","kind":"sister of","evidence":"Asha is Bram's sister"}

Passage: "Cora met Bram at the gate and waved."
Relation: none. Meeting once is a moment, not a lasting tie.

Passage: "Cora waited beside the cart."
Relation: none. Only one known name is stated; a tie needs both endpoints named.`;

/**
 * Strict-mode additions: closed kinds and one both-names sentence.
 *
 * Built lazily so CLOSED_ROLE_KINDS stays imported from the vocabulary
 * declared later in this module rather than copied here.
 */
export function strictRelationsPrompt(): string {
  return `Strict mode:
- Kinds are closed. Choose the closest allowed kind from this list and never invent a kind:
  ${CLOSED_ROLE_KINDS.join(', ')}
- evidence must be ONE contiguous sentence copied from the passage that contains a form of BOTH names. If no single sentence names both, return no entry for that pair.
Example: the passage sentence "Asha is Bram's sister, and the hall has always known it." is one entry: {"from":"Asha","to":"Bram","kind":"sister of","evidence":"Asha is Bram's sister, and the hall has always known it."}`;
}

/** Strict mode is opt-in; every other path keeps the historical prompt. */
export function strictRelationsEnabled(): boolean {
  return process.env.FANFABLE_REL_STRICT === '1';
}

/** The relations system prompt; optional blocks sit behind their env switches. */
export function relationsSystemPrompt(): string {
  let prompt = EXTRACT_RELATIONS_SYSTEM;
  prompt += `\n\n${kindGlossaryBlock()}`;
  if (process.env.FANFABLE_REL_FEWSHOT === '1') prompt += `\n\n${EXTRACT_RELATIONS_FEWSHOT}`;
  if (strictRelationsEnabled()) prompt += `\n\n${strictRelationsPrompt()}`;
  if (process.env.FANFABLE_REL_LIBERAL === '1') prompt += `\n\n${liberalRelationsPrompt()}`;
  return prompt;
}

/**
 * Liberal discovery additions: every stated or strongly implied relationship,
 * the model's own wording, no lasting-only or both-names gate. Enabled only by
 * FANFABLE_REL_LIBERAL=1; the proof rules downstream are unchanged.
 */
export function liberalRelationsPrompt(): string {
  return `Liberal discovery mode (this overrides the lasting-tie, moment and noun rules above):
- Record every relationship these passages state or strongly imply, whether it lasts or happens once.
- Use your own short wording for the kind; do not restrict yourself to a fixed list.
- Direction still matters: "from" is the one who has the relationship and "to" is the one it is to.
- evidence must be one sentence copied from the passage, or empty if no single sentence states it. The sentence need not name both endpoints.
- Never use outside knowledge.`;
}

/** Narrow re-ask for one relation whose quote does not name both endpoints. */
export const EXTRACT_RELATIONS_RETRY_SYSTEM = `You repair one relationship quote.
Reply with JSON only: {"quote":"..."}
You are given a PASSAGE, a PAIR of names and a KIND. Return ONE contiguous sentence copied VERBATIM from the passage that contains a form of BOTH names. If no single sentence names both names, reply {"quote":"NONE"}.
Never paraphrase, never join sentences, and never use any text that is not in the passage.`;

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

export interface ExtractWindowProgress {
  phase: 'lore';
  done: number;
  total: number;
  passagesDone: number;
  passagesTotal: number;
}

export interface ExtractOptions {
  sourceId?: number;
  /** How many passages to send in one request. */
  windowSize?: number;
  /** How many windows to read at the same time. */
  concurrency?: number;
  /** Only process passages that have not been extracted yet (default on). */
  incremental?: boolean;
  /**
   * How many tokens the model may use for one window.
   *
   * A verbose model can run out of tokens half way through the answer, and
   * then the window yields nothing at all. Raising this is cheaper than
   * losing a window.
   */
  maxTokens?: number;
  /**
   * Use the single mega-prompt from before Phase 1.
   *
   * Kept as the rollback path while the split extractor is being validated.
   * The split path is the default.
   */
  singlePrompt?: boolean;
  /**
   * Mine at most this many windows, chosen by priority (see scoreWindow).
   *
   * Absent means mine everything, which is today's behavior. The budget only
   * bites when this is passed. Skipped windows keep lore_mined=0 so a later
   * run — budgeted or --full — can pick them up.
   */
  maxWindows?: number;
  /**
   * Windows reserved for starved threads before priority selection.
   *
   * Default: a quarter of the budget (1 to 4), or 4 when no budget is set.
   * `0` restores pure priority selection.
   */
  starvedFirst?: number;
  /**
   * Starved-thread reservation for unbudgeted (full) runs.
   *
   * Full runs mine everything, so there is nothing to reserve from: when set,
   * up to this many starved windows move to the front of the run order and
   * the reservation is recorded in stats. Default 0: full runs behave
   * exactly as before.
   */
  starvedReserve?: number;
  /**
   * How many of the budget always go to the highest-scoring windows.
   * Defaults to the whole budget (pure priority order, no sampling).
   */
  priorityFirst?: number;
  /**
   * Fraction 0-1 of the remaining budget spent on a uniform sample of the
   * other windows, drawn with a seeded RNG. The floor buys coverage: a lonely
   * window with a low score still gets mined sometimes. Defaults to 1 when
   * priorityFirst leaves budget unspent (fill it by sampling), else 0.
   */
  randomFloor?: number;
  /** Seed for the deterministic sample. Default 42. */
  seed?: number;
  /** Mine everything, ignoring maxWindows/priorityFirst/randomFloor. */
  full?: boolean;
  /**
   * Embed newly mined rows when the embedder is reachable, else leave them
   * NULL for the backfill. Opt-in only: extraction never makes network calls
   * by default. Never fails the run.
   */
  embed?: { baseUrl: string; model?: string; embedFn?: EmbedFn; batchSize?: number; timeoutMs?: number };
  onProgress?: (message: string) => void;
  /** Structured window counts, for a progress monitor rather than the console. */
  onWindow?: (progress: ExtractWindowProgress) => void;
}

/** What the span gate did with the claims of one extraction run. */
export interface VerificationStats {
  /** Claims the model made, with a usable quote. */
  claimed: number;
  /** Claims whose quote was found in the passage they cited. */
  verified: number;
  /** Claims whose quote was found in a neighbouring passage; reference corrected. */
  repointed: number;
  /** Claims whose quote was found nowhere; never written. */
  dropped: number;
  /** Relations naming an entity that does not exist; never written. */
  unresolved: number;
  /** Claims whose quote names nobody in the claim (third roster person
   * instead); flagged in the counter and never written. */
  unrelated: number;
  /** Claims whose label is a moment, not a tie (met, gave, told, saw,
   * refused and their kin belong to events); counted and never written. */
  moment: number;
  /** Claims whose generic kinship word repeats a specific one already banked
   * for the pair ("parent of" beside "father of"); counted and never written. */
  redundant: number;
  /** Claims whose noun tie the quote never speaks ("cousin of" proved by a
   * sentence without the word); counted and never written. */
  unsupported: number;
  /** Unresolved-endpoint claims kept in canon_tie_hint instead of dropped. */
  hinted: number;
  /** Strict-mode relation quote retries attempted. */
  retried: number;
  /** Retries that returned a verbatim, both-names sentence. */
  retriedFixed: number;
  /** Retries that did not. */
  retriedFailed: number;
}

/**
 * Why a window produced nothing.
 *
 * A zero-row window must never be silent: it is either an empty answer, a
 * truncated answer, a gate that rejected everything, or a failed call.
 */
export interface EmptyWindowReport {
  index: number;
  locator: string;
  reason: 'empty-answer' | 'truncated-answer' | 'gate-dropped' | 'error';
  detail?: string;
}

/** A pair that looks like one thing under two names but was not merged. */
export interface QuarantinedAlias {
  name: string;
  candidate: string;
  reason: string;
}

export interface ExtractLoreResult {
  entities: number;
  relations: number;
  facts: number;
  timeline: number;
  passages: number;
  /** Windows processed in this run. */
  windows: number;
  verification: VerificationStats;
  /** Rows that passed the verbatim gate but failed the proven tier. */
  provisional: number;
  emptyWindows: EmptyWindowReport[];
  quarantinedAliases: QuarantinedAlias[];
  mergedAliases: string[];
  /** Budget selection, when a budget applied. Absent means everything ran. */
  selection?: { selected: number; total: number; skipped: number };
  /** Rival-claim rows flagged contested by this run. */
  contested?: { facts: number; relations: number };
  /** Clue notes this run added to the evidence web, when ingestion ran. */
  notesIngested?: number;
  /** Windows reserved for starved threads, and the threads they covered. */
  starvedReserved?: number;
  starvedUsed?: number;
  threadsCovered?: number;
}

export interface ChunkRow {
  id: number;
  seq: number;
  heading: string;
  locator: string;
  text: string;
  source_title: string;
  path: string;
  source_id: number;
}

/* ------------------------------------------------------- window scoring */

/**
 * Why a window is worth a model call, scored without a model.
 *
 * Extraction is the expensive step on a small machine, and not every window
 * repays it: a bridge window that names the people other windows talk about
 * is worth more than a landscape. All signals come from text and metadata
 * already in the chunk rows, so scoring is deterministic and free.
 */
export interface WindowScore {
  score: number;
  reasons: string[];
}

/**
 * Capitalized words that look like names.
 *
 * The first word of a sentence is skipped: it is capitalized by grammar, not
 * by meaning. Everything else capitalized and at least three letters long is
 * probably a name, a place or a title — exactly what extraction is for.
 */
export function properNamesOf(text: string): string[] {
  const names: string[] = [];
  for (const sentence of splitSentences(text)) {
    const words = sentence.match(/[A-Za-z][a-z']*/g) ?? [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (w.length < 3 || !/^[A-Z]/.test(w)) continue;
      if (i === 0) continue;
      names.push(w.toLowerCase());
    }
  }
  return names;
}

/**
 * How many windows mention each proper name.
 *
 * A name in two or more windows is a bridge or a hub: the windows around it
 * talk about the same people, so mining it first grounds the most retrieval.
 */
export function buildNameDocFreq(windows: ChunkRow[][]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const window of windows) {
    const seen = new Set(properNamesOf(window.map((c) => c.text).join('\n')));
    for (const name of seen) freq.set(name, (freq.get(name) ?? 0) + 1);
  }
  return freq;
}

/** Two name tokens that look like one thing under two forms. */
function aliasPair(a: string, b: string): boolean {
  if (a === b) return false;
  return nameRelation(a, b) !== null;
}

/**
 * Score one window: bridges and hubs first, then dialogue and relations.
 *
 * Dialogue windows are weighted up, not down: the archive showed dialogue
 * collapsing extraction, which means those windows hold relationships the
 * index is missing, not that they hold nothing.
 */
export function scoreWindow(window: ChunkRow[], docFreq: Map<string, number>): WindowScore {
  const reasons: string[] = [];
  let score = 0;
  const text = window.map((c) => c.text).join('\n');

  const distinct = new Set(properNamesOf(text));
  score += distinct.size * 2;
  if (distinct.size) reasons.push(`names:${distinct.size}`);

  const bridges = [...distinct].filter((n) => (docFreq.get(n) ?? 0) >= 2);
  score += bridges.length * 3;
  for (const b of bridges.slice(0, 5)) reasons.push(`bridge:${b}`);

  const list = [...distinct];
  let aliasHits = 0;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (aliasPair(list[i]!, list[j]!)) aliasHits++;
    }
  }
  score += aliasHits * 2;
  if (aliasHits) reasons.push(`aliases:${aliasHits}`);

  const colonSpeakers = (text.match(/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\s*:/gm) ?? []).length;
  const dialogue = speakersIn(text).length + colonSpeakers;
  score += Math.min(dialogue, 5) * 2;
  if (dialogue) reasons.push(`dialogue:${dialogue}`);

  const lower = text.toLowerCase();
  let cues = 0;
  for (const cue of KINSHIP_CUES) {
    if (lower.includes(cue)) cues++;
  }
  score += Math.min(cues, 8);
  if (cues) reasons.push(`relations:${cues}`);

  return { score, reasons };
}

/** Deterministic RNG for the coverage sample. Same seed, same windows. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface WindowSelection {
  /** Candidate indices to mine, in original window order. */
  selected: number[];
  /** Candidate indices left unmined for a later run. */
  skipped: number[];
  /** Score reasons per selected index, plus 'priority' or 'sampled'. */
  reasons: Map<number, string[]>;
}

/**
 * Choose which candidate windows to mine under a budget.
 *
 * The top priorityFirst by score always go first; the rest of the budget is a
 * uniform sample drawn with a seeded RNG, so a low-scoring window still gets
 * coverage across runs and the freeze stays reproducible. Ties break by
 * window order. Without a budget (or with full) everything is selected.
 */
export function selectWindows(
  scores: WindowScore[],
  opts: { maxWindows?: number; priorityFirst?: number; randomFloor?: number; seed?: number; full?: boolean } = {},
): WindowSelection {
  const n = scores.length;
  const empty: WindowSelection = {
    selected: [],
    skipped: [],
    reasons: new Map(),
  };
  if (!n) return empty;
  if (opts.full || opts.maxWindows === undefined || opts.maxWindows >= n) {
    return {
      selected: scores.map((_, i) => i),
      skipped: [],
      reasons: new Map(scores.map((s, i) => [i, [...s.reasons, 'priority']])),
    };
  }
  const budget = Math.max(0, Math.min(opts.maxWindows, n));
  const order = scores.map((_, i) => i).sort((a, b) => scores[b]!.score - scores[a]!.score || a - b);
  const priorityCount = Math.min(opts.priorityFirst ?? budget, budget);
  const picked = new Set(order.slice(0, priorityCount));
  const reasons = new Map<number, string[]>();
  for (const i of picked) reasons.set(i, [...scores[i]!.reasons, 'priority']);

  const rest = order.slice(priorityCount);
  const remaining = budget - picked.size;
  const floor = opts.randomFloor ?? 1;
  let sampleCount = Math.min(remaining, Math.floor(remaining * floor));
  if (remaining > 0 && floor > 0 && sampleCount === 0) sampleCount = 1;
  const rand = mulberry32(opts.seed ?? 42);
  const shuffled = [...rest];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  for (const i of shuffled.slice(0, sampleCount)) {
    picked.add(i);
    reasons.set(i, [...scores[i]!.reasons, 'sampled']);
  }

  const selected = [...picked].sort((a, b) => a - b);
  return { selected, skipped: order.filter((i) => !picked.has(i)), reasons };
}

/**
 * Candidate indices for the first `count` starved windows, in starved order.
 * Pure over the caller's maps: the same mapping the budgeted reservation uses.
 */
export function starvedCandidateIndices(
  candidateByFirstChunk: Map<number, number>,
  chunks: { id: number }[],
  windows: { index: number }[],
  count: number,
  windowSize: number,
): number[] {
  const reserved: number[] = [];
  if (count <= 0) return reserved;
  for (const entry of windows) {
    const first = chunks[entry.index * windowSize];
    if (!first) continue;
    const candidateIndex = candidateByFirstChunk.get(first.id);
    if (candidateIndex === undefined) continue;
    reserved.push(candidateIndex);
    if (reserved.length >= count) break;
  }
  return reserved;
}

/**
 * Read the imported material and record its lore.
 *
 * Runs in windows of passages so a whole book does not have to fit in the
 * context, and keeps a record of which passages were already processed.
 */
/**
 * Read the imported material and record its lore.
 *
 * Runs in windows of passages so a whole book does not have to fit in the
 * context, and keeps a record of which passages were already processed.
 *
 * With maxWindows set, only a budgeted selection is mined — the top
 * priorityFirst by score plus a seeded sample of the rest — and the skipped
 * windows keep lore_mined=0 for a later run. Without a budget (or with full)
 * everything runs, which is today's behavior.
 */
export async function extractLore(
  db: Db,
  llm: LlmClient,
  projectId: number,
  opts: ExtractOptions = {},
): Promise<ExtractLoreResult> {
  const windowSize = opts.windowSize ?? 8;
  const chunks = loadOrderedChunks(db, projectId, opts.sourceId);
  const stats = blankResult();
  if (!chunks.length) return stats;
  const runStartedAt = nowIso();

  // Passages that have already been mined are skipped, so re-running the
  // extraction over a long book is cheap.
  const mined = loadMinedSet(db, projectId);
  const ctx = loadChunkContext(db, projectId);
  const entityIdByName = new Map<string, number>();
  // Names harvested from the whole book once, before any window runs.
  const roster = buildNameRoster(db, projectId, chunks);
  // One derived-variant index per extraction command, built beside the roster.
  const nameIndex = commandRosterIndex(db, projectId);

  const allWindows = sliceWindows(chunks, windowSize);
  // Bridges are recurrence across the book, so the frequencies are built over
  // every window — including already-mined ones — while only candidates run.
  const docFreq = buildNameDocFreq(allWindows);
  const candidates: { window: ChunkRow[]; index: number }[] = [];
  allWindows.forEach((window, index) => {
    if (opts.incremental !== false && window.every((c) => mined.has(c.id))) return;
    candidates.push({ window, index });
  });
  if (!candidates.length) {
    opts.onProgress?.('everything has already been read');
    return stats;
  }

  // Starved first: a few windows are reserved for threads that have nothing
  // yet, so a budgeted run never reads only the same rich passages. The
  // reservation is capped and ordered deterministically; 0 disables it.
  const budgeted = opts.full !== true && opts.maxWindows !== undefined && opts.maxWindows < candidates.length;
  const starvedFirst =
    opts.starvedFirst ??
    (opts.maxWindows !== undefined ? Math.min(4, Math.max(1, Math.ceil(opts.maxWindows / 4))) : 4);
  let selection = selectWindows(
    candidates.map(({ window }) => scoreWindow(window, docFreq)),
    opts,
  );
  let chosen = new Set(selection.selected);
  const candidateByFirstChunk = new Map<number, number>();
  candidates.forEach(({ window }, index) => {
    const first = window[0];
    if (first) candidateByFirstChunk.set(first.id, index);
  });
  if (budgeted && starvedFirst > 0) {
    const starved = starvedWindowScores(db, projectId, { windowSize });
    const reserved = starvedCandidateIndices(
      candidateByFirstChunk,
      chunks,
      starved.windows,
      starvedFirst,
      windowSize,
    );
    if (reserved.length) {
      const reservedSet = new Set(reserved);
      const pool = candidates
        .map((_, index) => index)
        .filter((index) => !reservedSet.has(index));
      const remaining = Math.max(0, (opts.maxWindows ?? 0) - reserved.length);
      const rest = selectWindows(
        pool.map((index) => scoreWindow(candidates[index]!.window, docFreq)),
        { ...opts, maxWindows: remaining, full: false },
      );
      const reasons = new Map<number, string[]>();
      for (const index of reserved) reasons.set(index, ['starved']);
      for (const index of rest.selected) {
        const mapped = pool[index]!;
        reasons.set(mapped, [...(rest.reasons.get(index) ?? []), 'starved-fill']);
      }
      selection = { selected: [...new Set([...reserved, ...rest.selected.map((i) => pool[i]!)])].sort((a, b) => a - b), skipped: [], reasons };
      chosen = new Set(selection.selected);
      stats.starvedReserved = reserved.length;
      stats.starvedUsed = reserved.length;
      stats.threadsCovered = starved.threadsCovered;
    }
  }
  // Full runs mine everything, so --starved-reserve only moves starved
  // windows to the front of the run order and records the stats. Default 0.
  const reserveFull = !budgeted ? Math.max(0, Math.floor(opts.starvedReserve ?? 0)) : 0;
  let runOrder: number[] | null = null;
  if (reserveFull > 0) {
    const starved = starvedWindowScores(db, projectId, { windowSize });
    const reserved = starvedCandidateIndices(
      candidateByFirstChunk,
      chunks,
      starved.windows,
      reserveFull,
      windowSize,
    );
    if (reserved.length) {
      const reservedSet = new Set(reserved);
      runOrder = [...reserved, ...candidates.map((_, i) => i).filter((i) => !reservedSet.has(i))];
      stats.starvedReserved = reserved.length;
      stats.starvedUsed = reserved.length;
      stats.threadsCovered = starved.threadsCovered;
    }
  }
  const runList = (runOrder ?? candidates.map((_, i) => i))
    .filter((i) => chosen.has(i))
    .map((i) => candidates[i]!);
  if (runList.length < candidates.length) {
    const kinds = new Map<string, number>();
    for (const i of selection.selected) {
      for (const reason of selection.reasons.get(i) ?? []) {
        const kind = reason.split(':')[0]!;
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
    }
    const summary = [...kinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([kind, n]) => `${kind}×${n}`)
      .join(', ');
    opts.onProgress?.(
      `selected ${runList.length} of ${candidates.length} windows by priority (${summary}); ` +
        `${candidates.length - runList.length} left unmined; ${runList.length} window model calls`,
    );
    stats.selection = {
      selected: runList.length,
      total: candidates.length,
      skipped: candidates.length - runList.length,
    };
  }

  await runWindowBatch(db, llm, projectId, runList, ctx, entityIdByName, stats, {
    concurrency: Math.max(1, Math.min(opts.concurrency ?? 3, 4)),
    maxTokens: opts.maxTokens ?? 3000,
    singlePrompt: opts.singlePrompt === true,
    windowSize,
    totalChunks: chunks.length,
    onProgress: opts.onProgress,
    onWindow: opts.onWindow,
    roster,
    index: nameIndex,
  });

  // Fold any duplicates left by earlier runs into one row per pair.
  dedupeRelations(db, projectId);
  const contested = markContestedClaims(db, projectId);
  if (contested.facts || contested.relations) stats.contested = contested;
  const merged = mergeCanonEntities(db, projectId);
  stats.mergedAliases = merged.merged;
  stats.quarantinedAliases = merged.quarantined;
  persistQuarantine(db, projectId, merged.quarantined);
  // Identity-claim sweep over entity summaries: flags only, merges stay
  // human-gated. Dynamic import avoids the lorebook<->rule-checker cycle
  // (same precedent as the deferred diagnostics import).
  const identityHits = (await import('./rule-checker.ts')).checkEntities(db, projectId);
  if (identityHits.length) {
    opts.onProgress?.(
      `identity sweep: ${identityHits.length} summar${identityHits.length === 1 ? 'y' : 'ies'} flagged for review`,
    );
  }
  // Now that the entities and the events exist, marry the two.
  linkTimelineToEvents(db, projectId);
  if (opts.embed) {
    try {
      await embedMissing(db, projectId, opts.embed);
    } catch {
      /* embedding never fails an extraction */
    }
  }
  stats.windows = runList.length;
  // Close the loop inline: re-read thin spots in the same run, never a
  // second pass afterward. Same unchanged extractor paths, tight-gated and
  // capped; never throws the extraction.
  const loopLines = await closeTheLoop(db, llm, projectId, stats, {
    maxEntities: 5,
    maxPassages: 4,
    onProgress: opts.onProgress,
  });
  // Capacity sweep over only the entities this run created or touched.
  const touched = new Set(entityIdByName.values());
  for (const row of db.all<{ id: number }>(
    'SELECT id FROM canon_entity WHERE project_id = ? AND (created_at >= ? OR updated_at >= ?)',
    projectId,
    runStartedAt,
    runStartedAt,
  )) {
    touched.add(row.id);
  }
  checkEntityCapacity(db, projectId, touched, { write: true });
  const quarantinedEntities = quarantineSuspectCharacters(db, projectId);
  rememberExtractionReport(db, projectId, stats);
  writeAuditNote(projectId, 'extract', [
    `windows visited: ${stats.windows}`,
    `ties banked: ${stats.relations}`,
    `entities quarantined: ${quarantinedEntities.quarantined}, released: ${quarantinedEntities.released}`,
    `quotes verified: ${stats.verification.verified}, repointed: ${stats.verification.repointed}, dropped: ${stats.verification.dropped}`,
    `empty windows: ${stats.emptyWindows.length}`,
    ...loopLines,
  ], db);

  return stats;
}

/**
 * Inline gap-driven re-read: the loop closed inside the extract run.
 *
 * After the budgeted windows are mined, entities with no ties (or one tie
 * despite many mentions) are checked against already-mined passages for a
 * same-sentence name-plus-cue hit — the tight gate. At most maxEntities such
 * entities are re-read with the existing enrich path (one call per 4
 * passages), bank-iff-verified, in the same concurrency-1 process. No new
 * machinery, no prompt rewording, no gate loosening. Never throws.
 */
const LOOP_CUES: RegExp[] = [
  /\b(?:his|her|their) (?:son|daughter)\b/i, /\b(?:son|daughter) of\b/i,
  /\b(?:brother|sister|sibling) of\b/i, /\b(?:mother|father) of\b/i,
  /\b(?:uncle|aunt) of\b/i, /\b(?:cousin|nephew|niece) of\b/i,
  /\b(?:wife|husband|spouse) of\b/i, /\bmarried to\b/i, /\bapprentice\b/i,
  /\baide\b/i, /\bassistant\b/i, /\bmaster of\b/i, /\bmentor\b/i, /\bpartner\b/i,
];

async function closeTheLoop(
  db: Db,
  llm: LlmClient,
  projectId: number,
  stats: ExtractLoreResult,
  opts: { maxEntities: number; maxPassages: number; onProgress?: (message: string) => void },
): Promise<string[]> {
  const lines: string[] = [];
  try {
    const tieCount = new Map<number, number>();
    for (const r of db.all<{ e: number }>(
      `SELECT from_entity AS e FROM canon_relation WHERE project_id = ? UNION ALL SELECT to_entity AS e FROM canon_relation WHERE project_id = ?`,
      projectId, projectId,
    )) tieCount.set(r.e, (tieCount.get(r.e) ?? 0) + 1);
    const entities = db.all<{ id: number; name: string; mentions: number }>(
      'SELECT id, name, mentions FROM canon_entity WHERE project_id = ? ORDER BY mentions DESC',
      projectId,
    );
    const gaps = entities.filter((e) => {
      const ties = tieCount.get(e.id) ?? 0;
      return ties === 0 || (ties === 1 && e.mentions > 3);
    });
    if (!gaps.length) return ['loop: no gap entities'];
    const chunks = db.all<{ id: number; text: string; mined: number }>(
      'SELECT id, text, lore_mined AS mined FROM canon_chunk WHERE project_id = ?',
      projectId,
    );
    const tight: { id: number; name: string }[] = [];
    for (const e of gaps) {
      const needle = e.name.toLowerCase();
      const minedOnes = chunks.filter((c) => c.mined && c.text.toLowerCase().includes(needle));
      if (!minedOnes.length) continue;
      const hit = minedOnes.some((c) =>
        c.text.split(/(?<=[.!?])\s+/).some((s) => s.toLowerCase().includes(needle) && LOOP_CUES.some((re) => re.test(s))),
      );
      if (hit) tight.push(e);
      if (tight.length >= Math.max(1, opts.maxEntities)) break;
    }
    if (!tight.length) return [`loop: ${gaps.length} gap entities, 0 tight-gated, 0 extra calls`];
    // Deferred import: lore-diagnostics reads lorebook at module load, so a
    // top-level import would cycle. Resolved here at runtime, long after init.
    const { enrichEntity } = await import('./lore-diagnostics.ts');
    let calls = 0;
    for (const e of tight) {
      try {
        const r = await enrichEntity(db, llm, projectId, e.name, {
          maxPassages: Math.max(1, opts.maxPassages),
          onProgress: opts.onProgress,
        });
        calls++;
        stats.relations += r.relations;
        stats.facts += r.facts;
        lines.push(`loop: re-read ${e.name}: +${r.relations} ties, +${r.facts} facts from ${r.passages} passages`);
      } catch (err) {
        lines.push(`loop: re-read ${e.name} failed (${err instanceof Error ? err.message : String(err)}), bank untouched`);
      }
    }
    try {
      dedupeRelations(db, projectId);
    } catch {
      /* dedupe is a nicety: never fail the loop over it */
    }
    lines.unshift(`loop: ${tight.length} tight-gated entities, ${calls} extra calls`);
  } catch (err) {
    lines.push(`loop: skipped (${err instanceof Error ? err.message : String(err)})`);
  }
  return lines;
}

export interface LazyMineOptions {
  windowSize?: number;
  sourceId?: number;
  concurrency?: number;
  maxTokens?: number;
  singlePrompt?: boolean;
  /** Never mine more than this many windows in one call. Default 2. */
  maxLazyWindows?: number;
  onProgress?: (message: string) => void;
  /** Structured window counts, for a progress monitor rather than the console. */
  onWindow?: (progress: ExtractWindowProgress) => void;
}

/**
 * Mine just the windows that hold the given passages.
 *
 * A query that touches unmined text should not wait for the whole book: this
 * runs the same split path over at most maxLazyWindows windows and leaves the
 * rest alone. Windows are grouped exactly as extractLore groups them, so a
 * later full run picks up where this left off. On any error the caller falls
 * back to the unmined passages as today.
 */
export async function ensureWindowsForChunks(
  db: Db,
  llm: LlmClient,
  projectId: number,
  chunkIds: number[],
  opts: LazyMineOptions = {},
): Promise<ExtractLoreResult> {
  const stats = blankResult();
  const wanted = new Set((chunkIds ?? []).filter((n) => Number.isFinite(n)));
  if (!wanted.size) return stats;

  const windowSize = opts.windowSize ?? 8;
  const chunks = loadOrderedChunks(db, projectId, opts.sourceId);
  if (!chunks.length) return stats;
  const mined = loadMinedSet(db, projectId);
  const cap = Math.max(0, opts.maxLazyWindows ?? 2);
  const targets: { window: ChunkRow[]; index: number }[] = [];
  sliceWindows(chunks, windowSize).forEach((window, index) => {
    if (targets.length >= cap) return;
    if (!window.some((c) => wanted.has(c.id))) return;
    if (window.every((c) => mined.has(c.id))) return;
    targets.push({ window, index });
  });
  if (!targets.length) return stats;

  const ctx = loadChunkContext(db, projectId);
  const roster = buildNameRoster(db, projectId, chunks);
  const nameIndex = commandRosterIndex(db, projectId);
  await runWindowBatch(db, llm, projectId, targets, ctx, new Map<string, number>(), stats, {
    concurrency: Math.max(1, Math.min(opts.concurrency ?? 3, 4)),
    maxTokens: opts.maxTokens ?? 3000,
    singlePrompt: opts.singlePrompt === true,
    windowSize,
    totalChunks: chunks.length,
    onProgress: opts.onProgress,
    onWindow: opts.onWindow,
    roster,
    index: nameIndex,
  });

  dedupeRelations(db, projectId);
  const contested = markContestedClaims(db, projectId);
  if (contested.facts || contested.relations) stats.contested = contested;
  const merged = mergeCanonEntities(db, projectId);
  stats.mergedAliases = merged.merged;
  stats.quarantinedAliases = merged.quarantined;
  persistQuarantine(db, projectId, merged.quarantined);
  // Identity-claim sweep over entity summaries: flags only, merges stay
  // human-gated. Dynamic import avoids the lorebook<->rule-checker cycle
  // (same precedent as the deferred diagnostics import).
  const identityHits = (await import('./rule-checker.ts')).checkEntities(db, projectId);
  if (identityHits.length) {
    opts.onProgress?.(
      `identity sweep: ${identityHits.length} summar${identityHits.length === 1 ? 'y' : 'ies'} flagged for review`,
    );
  }
  linkTimelineToEvents(db, projectId);
  stats.windows = targets.length;
  writeAuditNote(projectId, 'mine', [
    `windows visited: ${stats.windows}`,
    `ties banked: ${stats.relations}`,
    `quotes verified: ${stats.verification.verified}, repointed: ${stats.verification.repointed}, dropped: ${stats.verification.dropped}`,
  ], db);
  return stats;
}

/**
 * Mine the windows behind passage hits, best-effort.
 *
 * Shared by the query paths that touch unmined text. Never throws: on any
 * error the caller falls back to the unmined passages as today. Returns the
 * mini result when at least one window was mined, else undefined.
 */
export async function mineUnminedHits(
  db: Db,
  llm: LlmClient,
  projectId: number,
  chunkIds: number[],
): Promise<ExtractLoreResult | undefined> {
  if (!chunkIds.length) return undefined;
  const unmined = db
    .all<{ id: number }>(
      `SELECT id FROM canon_chunk WHERE project_id = ? AND lore_mined = 0 AND id IN (${chunkIds.map(() => '?').join(',')})`,
      projectId,
      ...chunkIds,
    )
    .map((r) => r.id);
  if (!unmined.length) return undefined;
  try {
    // Window size 8 is the extraction default; a mismatch only regroups,
    // because mined state is per passage and a later run regroups anyway.
    const mini = await ensureWindowsForChunks(db, llm, projectId, unmined, { windowSize: 8 });
    return mini.windows > 0 ? mini : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------- batch plumbing */
function blankResult(): ExtractLoreResult {
  return {
    entities: 0,
    relations: 0,
    facts: 0,
    timeline: 0,
    passages: 0,
    windows: 0,
    verification: { claimed: 0, verified: 0, repointed: 0, dropped: 0, unresolved: 0, unrelated: 0, moment: 0, redundant: 0, unsupported: 0, hinted: 0, retried: 0, retriedFixed: 0, retriedFailed: 0 },
    provisional: 0,
    emptyWindows: [],
    quarantinedAliases: [],
    mergedAliases: [],
  };
}

/** Every passage of a project (or one source), in window order. */
function loadOrderedChunks(db: Db, projectId: number, sourceId?: number): ChunkRow[] {
  const params: unknown[] = [projectId];
  let sql = `SELECT c.id, c.seq, c.heading, c.locator, c.text, s.title AS source_title, s.path, c.source_id
             FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
             WHERE c.project_id = ?`;
  if (sourceId) {
    sql += ' AND c.source_id = ?';
    params.push(sourceId);
  }
  sql += ' ORDER BY c.source_id, c.seq';
  return db.all<ChunkRow>(sql, ...params);
}

function loadMinedSet(db: Db, projectId: number): Set<number> {
  return new Set(
    db
      .all<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ? AND lore_mined = 1', projectId)
      .map((r) => r.id),
  );
}

function sliceWindows(chunks: ChunkRow[], windowSize: number): ChunkRow[][] {
  const windows: ChunkRow[][] = [];
  for (let start = 0; start < chunks.length; start += windowSize) {
    windows.push(chunks.slice(start, start + windowSize));
  }
  return windows;
}

interface ChunkContext {
  neighboursOf: (id: number | undefined) => ChunkRow[];
}

/**
 * Every passage of the project, so a quote that belongs to a neighbouring
 * passage can be found and its reference corrected.
 */
function loadChunkContext(db: Db, projectId: number): ChunkContext {
  const allChunks = db.all<{
    id: number;
    seq: number;
    source_id: number;
    text: string;
    locator: string;
    source_title: string;
  }>(
    `SELECT c.id, c.seq, c.source_id, c.text, c.locator, s.title AS source_title
     FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
     WHERE c.project_id = ? ORDER BY c.source_id, c.seq`,
    projectId,
  );
  const chunkById = new Map(allChunks.map((c) => [c.id, c as ChunkRow]));
  const neighboursOf = (id: number | undefined): ChunkRow[] => {
    const chunk = id === undefined ? undefined : chunkById.get(id);
    if (!chunk) return [];
    const out: ChunkRow[] = [];
    for (const candidate of allChunks) {
      if (candidate.source_id !== chunk.source_id) continue;
      if (Math.abs(candidate.seq - chunk.seq) <= 2) out.push(candidate as ChunkRow);
    }
    return out;
  };
  return { neighboursOf };
}

interface RunBatchOpts {
  concurrency: number;
  maxTokens: number;
  singlePrompt: boolean;
  windowSize: number;
  totalChunks: number;
  onProgress?: (message: string) => void;
  onWindow?: (progress: ExtractWindowProgress) => void;
  /** Book-wide capitalization roster, built once per extraction. */
  roster?: NameRoster;
  /** Derived-variant index, built once per extraction command. */
  index?: RosterIndex;
}

/** Run windows through the split (or legacy) path and mark them mined. */
async function runWindowBatch(
  db: Db,
  llm: LlmClient,
  projectId: number,
  entries: { window: ChunkRow[]; index: number }[],
  ctx: ChunkContext,
  entityIdByName: Map<string, number>,
  stats: ExtractLoreResult,
  batch: RunBatchOpts,
): Promise<void> {
  let done = 0;
  for (let start = 0; start < entries.length; start += batch.concurrency) {
    const group = entries.slice(start, start + batch.concurrency);
    await Promise.all(
      group.map(async ({ window, index }) => {
        const emptyBefore = stats.emptyWindows.length;
        try {
          if (batch.singlePrompt) {
            await extractWindowLegacy(db, llm, projectId, window, entityIdByName, stats, ctx.neighboursOf, batch.maxTokens, batch.index);
          } else {
            await extractWindowSplit(
              db,
              llm,
              projectId,
              window,
              entityIdByName,
              stats,
              ctx.neighboursOf,
              batch.maxTokens,
              index,
              batch.roster,
              batch.index,
            );
          }
        } catch (err) {
          // One bad window must not abort the run, but it must not be silent.
          stats.emptyWindows.push({
            index,
            locator: window[0]?.locator ?? '',
            reason: 'error',
            detail: err instanceof Error ? err.message : String(err),
          });
        }
        const failed = stats.emptyWindows.slice(emptyBefore).some((e) => e.index === index && e.reason !== 'empty-answer');
        if (!failed) {
          for (const c of window) db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE id = ?', c.id);
        }
        // Feed the evidence web from this window. Additive and fenced off: a
        // failure here is logged and never fails the extraction.
        try {
          const ingested = noteFromExtraction(db, projectId, window, stats);
          if (ingested.notes) {
            batch.onProgress?.(`  notes: +${ingested.notes} from window ${index}`);
          }
        } catch (err) {
          batch.onProgress?.(
            `  note ingestion skipped for window ${index}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        done++;
        batch.onProgress?.(
          `read ${done}/${entries.length} windows (${done * batch.windowSize} of ${batch.totalChunks} passages)`,
        );
        batch.onWindow?.({
          phase: 'lore',
          done,
          total: entries.length,
          passagesDone: Math.min(done * batch.windowSize, batch.totalChunks),
          passagesTotal: batch.totalChunks,
        });
        return undefined;
      }),
    );
  }
}
/**
 * Keep the last extraction's counters where diagnostics can read them.
 *
 * `lore diagnose` runs in another process from `lore extract`, so the counters
 * have to survive the run. schema_meta is the existing key-value store; no new
 * table is needed.
 */
function rememberExtractionReport(db: Db, projectId: number, stats: ExtractLoreResult): void {
  try {
    db.run(
      'INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)',
      `lore-extraction:${projectId}`,
      JSON.stringify({
        at: nowIso(),
        windows: stats.windows,
        verification: stats.verification,
        emptyWindows: stats.emptyWindows,
        quarantinedAliases: stats.quarantinedAliases.length,
        mergedAliases: stats.mergedAliases.length,
        contested: stats.contested ?? { facts: 0, relations: 0 },
      }),
    );
  } catch {
    /* diagnostics are a nicety: never fail an extraction over them */
  }
}

/**
 * Audit notes by default: every run emits windows visited, ties banked,
 * quotes repointed/dropped, rules fired as text alongside DB writes.
 * DB stays authoritative; the note is the paper trail. Never throws.
 * Code paths are bit-deterministic; LLM text excluded from comparison.
 */
export function writeAuditNote(projectId: number, op: string, lines: string[], db?: Db): string | undefined {
  try {
    // Alongside the DB when its path is known (temp DBs stay in tmp, real
    // DBs keep notes next to them); :memory: and pathless callers fall back
    // to a tmpdir home so suite runs never pollute the repo dir.
    let dir: string;
    const p = db?.path;
    if (p && p !== ':memory:') {
      dir = join(dirname(p), '.audits');
    } else if (!db) {
      dir = join(tmpdir(), '.audits-fanfable');
    } else {
      dir = join(tmpdir(), '.audits-fanfable');
    }
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeOp = op.replace(/[^a-z0-9-_]+/gi, '-').slice(0, 40) || 'op';
    const path = join(dir, `${projectId}-${safeOp}-${stamp}.md`);
    writeFileSync(path, `# Audit ${op} project ${projectId} at ${new Date().toISOString()}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
    return path;
  } catch {
    return undefined;
  }
}

/** Load the counters of the last extraction for a project. */
export function lastExtractionReport(
  db: Db,
  projectId: number,
): {
  at: string;
  windows: number;
  verification: VerificationStats;
  /** Rows that passed the verbatim gate but failed the proven tier. */
  provisional: number;
  emptyWindows: EmptyWindowReport[];
  quarantinedAliases: number;
  mergedAliases: number;
  contested: { facts: number; relations: number };
} | undefined {
  const row = db.get<{ value: string }>('SELECT value FROM schema_meta WHERE key = ?', `lore-extraction:${projectId}`);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as never;
  } catch {
    return undefined;
  }
}

/**
 * Flag rival claims neither side resolves.
 *
 * Deterministic marking only: same-subject facts (or same-pair relations)
 * whose normalized texts contain opposing markers — a negation against an
 * affirmation, died/dead against alive, before against after — are both set
 * to contested. Nothing is deleted, nothing is auto-resolved, and model
 * judgment stays out of it. Only rows still marked none move.
 */
export function markContestedClaims(db: Db, projectId: number): { facts: number; relations: number } {
  const counts = { facts: 0, relations: 0 };
  const flag = (table: string, ids: number[]): number => {
    let n = 0;
    for (const id of ids) {
      const r = db.run(
        `UPDATE ${table} SET conflict_status = 'contested' WHERE id = ? AND project_id = ? AND conflict_status = 'none'`,
        id,
        projectId,
      );
      n += r.changes;
    }
    return n;
  };

  const facts = db.all<{ id: number; subject: string; statement: string }>(
    'SELECT id, subject, statement FROM canon_fact WHERE project_id = ?',
    projectId,
  );
  const bySubject = new Map<string, typeof facts>();
  for (const f of facts) {
    const key = f.subject.trim().toLowerCase() || '(no subject)';
    bySubject.set(key, [...(bySubject.get(key) ?? []), f]);
  }
  for (const group of bySubject.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (opposingClaims(group[i]!.statement, group[j]!.statement)) {
          counts.facts += flag('canon_fact', [group[i]!.id, group[j]!.id]);
        }
      }
    }
  }

  const relations = db.all<{ id: number; from_entity: number; to_entity: number; description: string }>(
    'SELECT id, from_entity, to_entity, description FROM canon_relation WHERE project_id = ?',
    projectId,
  );
  const byPair = new Map<string, typeof relations>();
  for (const r of relations) {
    const key = [r.from_entity, r.to_entity].sort((a, b) => a - b).join(':');
    byPair.set(key, [...(byPair.get(key) ?? []), r]);
  }
  for (const group of byPair.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (opposingClaims(group[i]!.description, group[j]!.description)) {
          counts.relations += flag('canon_relation', [group[i]!.id, group[j]!.id]);
        }
      }
    }
  }
  return counts;
}

const NEGATION_RE = /\b(not|never|no|n't|cannot|can't|didn't|doesn't|don't|isn't|wasn't|weren't|hasn't|haven't|hadn't|won't|wouldn't|couldn't|shouldn't|neither|nor|nothing|none|without)\b/;
const DIED_RE = /\b(died|dead|death)\b/;
const ALIVE_RE = /\b(alive|living|survived|survive|survives)\b/;
const BEFORE_RE = /\bbefore\b/;
const AFTER_RE = /\bafter\b/;

function hasMarker(text: string, re: RegExp): boolean {
  return re.test(` ${text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ')} `);
}

/** Do two same-subject texts state opposite things by a fixed marker set? */
function opposingClaims(a: string, b: string): boolean {
  if (!a.trim() || !b.trim()) return false;
  // Rival claims talk about the same thing: without a shared content word
  // the markers below would fire on any two unrelated statements.
  const wa = new Set(tokenize(a));
  let shared = 0;
  for (const w of tokenize(b)) if (wa.has(w)) shared++;
  if (shared < 1) return false;
  if (hasMarker(a, NEGATION_RE) !== hasMarker(b, NEGATION_RE)) return true;
  if (hasMarker(a, DIED_RE) && hasMarker(b, ALIVE_RE)) return true;
  if (hasMarker(a, ALIVE_RE) && hasMarker(b, DIED_RE)) return true;
  if (hasMarker(a, BEFORE_RE) && hasMarker(b, AFTER_RE)) return true;
  if (hasMarker(a, AFTER_RE) && hasMarker(b, BEFORE_RE)) return true;
  return false;
}

/** Place order for a relation: first referenced chunk's seq, or null. */
function refsSeq(db: Db, sourceRefs: string): number | null {
  const chunkId = firstChunkOf(sourceRefs);
  if (chunkId === undefined) return null;
  return db.get<{ seq: number }>('SELECT seq FROM canon_chunk WHERE id = ?', chunkId)?.seq ?? null;
}

/** The earlier of two places; a known place beats an unknown one. */
function earliestRefs(db: Db, a: string, b: string): string {
  const sa = refsSeq(db, a);
  const sb = refsSeq(db, b);
  if (sa === null) return sb === null ? a : b;
  if (sb === null) return a;
  return sa <= sb ? a : b;
}

/**
 * One relation per pair and label.
 *
 * The model can name the same tie from either side (A→B and B→A), so the pair
 * is unordered and the label is lower-cased. Surviving rows keep the longer
 * sentence and quote, the earliest place, and needs_review if either side had
 * it. Different labels on the same pair stay separate.
 */
export function dedupeRelations(db: Db, projectId: number): void {
  type Row = { id: number; from_entity: number; to_entity: number; kind: string; description: string; evidence: string; source_refs: string; review_status: string };
  const rows = db.all<Row>(
    'SELECT id, from_entity, to_entity, kind, description, evidence, source_refs, review_status FROM canon_relation WHERE project_id = ? ORDER BY id',
    projectId,
  );
  const pairOf = (row: Row) => (row.from_entity < row.to_entity ? `${row.from_entity}:${row.to_entity}` : `${row.to_entity}:${row.from_entity}`);
  const merged = new Map<string, Row>();
  for (const row of rows) {
    // The same pair can hold several relationships, so the label is part of the key.
    const key = `${pairOf(row)}:${row.kind.toLowerCase()}`;
    const first = merged.get(key);
    if (!first) {
      merged.set(key, row);
      continue;
    }
    const description = row.description.length > first.description.length ? row.description : first.description;
    const evidence = row.evidence.length > first.evidence.length ? row.evidence : first.evidence;
    const sourceRefs = earliestRefs(db, first.source_refs, row.source_refs);
    const review = maxTrust(first.review_status, row.review_status);
    db.transaction(() => {
      const survivorBefore = first.review_status;
      db.run(
        'UPDATE canon_relation SET description = ?, evidence = ?, source_refs = ?, review_status = ? WHERE id = ?',
        description,
        evidence,
        sourceRefs,
        review,
        first.id,
      );
      if (review !== survivorBefore) {
        recordRuling(db, projectId, {
          relationId: first.id,
          role: 'appeal',
          actor: 'guard',
          standard: 'merge',
          fromStatus: survivorBefore,
          toStatus: review,
          basis: `merge trust from relation ${row.id}`,
          quote: evidence,
        });
      }
      recordRuling(db, projectId, {
        relationId: row.id,
        role: 'appeal',
        actor: 'guard',
        standard: 'merge',
        fromStatus: row.review_status,
        toStatus: 'merged',
        basis: `merged into relation ${first.id}`,
        quote: row.evidence,
      });
      db.run('DELETE FROM canon_relation WHERE id = ?', row.id);
    });
    first.description = description;
    first.evidence = evidence;
    first.source_refs = sourceRefs;
    first.review_status = review;
  }
}

/**
 * Recover the complete records from one section of a truncated answer.
 *
 * A model that runs out of tokens leaves the JSON unfinished. The records it
 * did finish are good, and the section that was cut off is the part that is
 * missing — usually the relations, because they come last. Without this, one
 * long window loses everything it produced.
 */
function salvageSection(text: string, key: string): Record<string, unknown>[] {
  const at = (text ?? '').indexOf(`"${key}"`);
  if (at < 0) return [];
  const open = text.indexOf('[', at);
  if (open < 0) return [];
  return salvageJsonArray(text.slice(open));
}

/**
 * The four sections of an extraction answer.
 *
 * A complete answer is used as it is. A truncated one is salvaged section by
 * section, so the parts the model finished are kept.
 */
function parseExtraction(text: string): {
  entities: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  facts: Record<string, unknown>[];
  timeline: Record<string, unknown>[];
} {
  const parsed = extractJson<Record<string, unknown>>(text);
  if (parsed && typeof parsed === 'object') {
    const whole = {
      entities: asRecordArray(parsed.entities),
      relations: asRecordArray(parsed.relations),
      facts: asRecordArray(parsed.facts),
      timeline: asRecordArray(parsed.timeline),
    };
    if (whole.entities.length || whole.relations.length || whole.facts.length || whole.timeline.length) {
      return whole;
    }
  }
  return {
    entities: salvageSection(text, 'entities'),
    relations: salvageSection(text, 'relations'),
    facts: salvageSection(text, 'facts'),
    timeline: salvageSection(text, 'timeline'),
  };
}

/** A claim's quote, after checking it against the source. */
interface SpanCheck {
  quote: string;
  chunkId: number | null;
  source: string;
  locator: string;
  status: 'verified' | 'repointed' | 'dropped';
}

/**
 * Check a claim's quote against the passage it cites and the passages around it.
 *
 * A quote that is in the cited passage is verified. A quote that is in a
 * neighbouring passage is repointed: the model read the right words and cited
 * the wrong window. A quote that appears nowhere is dropped, because an
 * unbacked claim in the index is worse than a missing one.
 *
 * Normalisation ignores case, punctuation and line breaks, so a quote copied
 * across a line wrap still verifies.
 */
export function verifySpan(
  raw: unknown,
  chunk: ChunkRow | undefined,
  neighbours: ChunkRow[] = [],
): SpanCheck {
  const text = String(raw ?? '').trim();
  const cited = {
    chunkId: chunk?.id ?? null,
    source: chunk?.source_title ?? '',
    locator: chunk?.locator ?? '',
  };
  if (!text || !chunk) return { ...cited, quote: '', status: 'dropped' };
  const needle = normalise(text);
  if (!needle) return { ...cited, quote: '', status: 'dropped' };

  const contains = (target: ChunkRow | undefined): boolean =>
    !!target && normalise(target.text).includes(needle);

  if (contains(chunk)) return { ...cited, quote: text, status: 'verified' };
  for (const candidate of neighbours) {
    if (candidate.id === chunk.id) continue;
    if (contains(candidate)) {
      return {
        quote: text,
        chunkId: candidate.id,
        source: candidate.source_title,
        locator: candidate.locator,
        status: 'repointed',
      };
    }
  }
  return { ...cited, quote: '', status: 'dropped' };
}

/**
 * The evidence area for a quote: the page the cited chunk sits on — every
 * chunk from the same source whose page range overlaps it, joined in read
 * order. A tie may be stated across two sentences on one page; it may not be
 * assembled from the whole book.
 *
 * Returns null when the chunk carries no page numbers, so callers fall back to
 * the single cited passage.
 */
export function pageEvidenceText(db: Db, chunkId: number): string | null {
  const cited = db.get<{ source_id: number; page_start: number; page_end: number }>(
    'SELECT source_id, page_start, page_end FROM canon_chunk WHERE id = ?',
    chunkId,
  );
  if (!cited || (!cited.page_start && !cited.page_end)) return null;
  const start = Math.min(cited.page_start, cited.page_end);
  const end = Math.max(cited.page_start, cited.page_end);
  const rows = db.all<{ text: string }>(
    `SELECT text FROM canon_chunk
      WHERE source_id = ? AND page_start <= ? AND page_end >= ?
      ORDER BY seq`,
    cited.source_id,
    end,
    start,
  );
  return rows.length ? rows.map((row) => row.text).join('\n') : null;
}

/** Parse one section of an answer, salvaging it when the answer was cut off. */function parseSection(text: string, key: string): Record<string, unknown>[] {
  const parsed = extractJson<unknown>(text);
  // Models sometimes return the section as a bare list instead of the asked-for
  // labelled box (e.g. `[{...}]` for relations). That is the same content and
  // must not be silently dropped.
  if (Array.isArray(parsed)) {
    const values = asRecordArray(parsed);
    if (values.length) return values;
  } else if (parsed && typeof parsed === 'object') {
    const values = asRecordArray((parsed as Record<string, unknown>)[key]);
    if (values.length) return values;
  }
  return salvageSection(text, key);
}

/** The passages as the model sees them. */
function passageBlock(window: ChunkRow[]): string {
  return (
    'PASSAGES:\n' +
    window
      .map((c, i) => `[#${i}] ${c.source_title} | ${c.locator}\n${truncate(c.text, 1400)}`)
      .join('\n\n')
  );
}

function chunkAt(window: ChunkRow[], idx: unknown): ChunkRow | undefined {
  const i = Number(idx);
  return Number.isFinite(i) ? window[i] : undefined;
}

function refsFor(chunk: ChunkRow | undefined): { source: string; locator: string; chunk?: number }[] {
  return chunk ? [{ source: chunk.source_title, locator: chunk.locator, chunk: chunk.id }] : [];
}


/* ------------------------------------------------------------ name roster */

/** Ceiling for the relation prompt's name list, roster included. */
export const WINDOW_NAME_CAP = 80;
/** The list's pre-roster ceiling: bank and finder names keep their old size. */
const WINDOW_BANK_NAME_CAP = 60;

export interface NameRosterEntry {
  /** Representative surface: the most frequent form in the group. */
  surface: string;
  /** Every accepted surface form collapsed into this entry. */
  surfaces: string[];
  tokens: string[];
  count: number;
  trustedSource: 'mid-sentence' | 'sentence-start-matched';
}

export interface NameRosterDiagnostics {
  sentenceInitialCandidates: number;
  accepted: number;
  rejected: number;
  topRejected: { surface: string; count: number }[];
  /** Quote boundaries that began a new utterance segment. */
  quotedStarts: number;
  rejectedInvalid: number;
  rejectedContraction: number;
  rejectedFunctionWord: number;
  rejectedTitleOnly: number;
  rejectedCommonWord: number;
  rejectedStoplist: number;
  rejectedNoMidSentence: number;
}

export interface NameRoster {
  entries: NameRosterEntry[];
  diagnostics: NameRosterDiagnostics;
}

/**
 * Words that start sentences but are not names.
 *
 * Pronouns, determiners, conjunctions, common adverbs and prepositions, plus
 * the discourse starters prose leans on. Universal English function words:
 * extend only with the same classes, never with names.
 */
const NAME_STARTER_STOPLIST = new Set([
  'but', 'he', 'she', 'it', 'they', 'we', 'you', 'i', 'in', 'on', 'at', 'as', 'if',
  'then', 'how', 'what', 'when', 'where', 'why', 'who', 'his', 'her', 'their', 'the',
  'a', 'an', 'and', 'or', 'so', 'yet', 'for', 'not', 'no', 'yes', 'that', 'this',
  'these', 'those', 'there', 'here', 'now', 'later', 'before', 'after', 'once', 'still',
  'even', 'only', 'just', 'also', 'perhaps', 'maybe', 'suddenly', 'finally', 'however',
  'meanwhile', 'while', 'because', 'though', 'although', 'unless', 'until', 'since',
  // Same classes, for sentences opening on a preposition or connective.
  'about', 'above', 'across', 'afterwards', 'against', 'along', 'among', 'around',
  'behind', 'below', 'beneath', 'beside', 'besides', 'between', 'beyond', 'by',
  'despite', 'down', 'during', 'except', 'from', 'inside', 'into', 'near', 'of', 'off',
  'onto', 'out', 'outside', 'over', 'past', 'through', 'throughout', 'toward',
  'towards', 'under', 'up', 'upon', 'with', 'within', 'without', 'first', 'second',
  'third', 'next', 'last', 'another', 'each', 'every', 'both', 'few', 'many', 'most',
  'some', 'such', 'than', 'too', 'very', 'well', 'almost', 'already', 'always',
  'never', 'often', 'sometimes', 'soon', 'today', 'tomorrow', 'yesterday', 'again',
  'away', 'back', 'forward', 'instead', 'otherwise',
]);

/** Universal titles that name a role, not a person, when they stand alone. */
const NAME_TITLE_WORDS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'sir', 'madam', 'lord', 'lady', 'captain', 'commander',
  'general', 'senator', 'master', 'darth', 'magister', 'count', 'duke', 'king',
  'queen', 'prince', 'father', 'mother', 'brother', 'sister',
]);

interface RosterToken {
  text: string;
  capitalized: boolean;
  usable: boolean;
}

interface RosterRun {
  tokens: RosterToken[];
  startIndex: number;
}

/** Words only: possessives stripped, punctuation used as run boundaries. */
function rosterSentenceTokens(sentence: string): RosterToken[] {
  const out: RosterToken[] = [];
  const re = /[A-Za-z0-9][A-Za-z0-9'’\-]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sentence)) !== null) {
    const raw = match[0];
    const text = raw.replace(/['’]s$/i, '').replace(/['’]$/, '');
    const letters = text.replace(/[^A-Za-z]/g, '');
    const capitalized = /^[A-Z]/.test(text);
    const allCapsArtifact = letters.length > 1 && letters === letters.toUpperCase();
    const pureDigits = letters.length === 0;
    out.push({
      text,
      capitalized,
      usable: text.length >= 2 && capitalized && !allCapsArtifact && !pureDigits,
    });
  }
  return out;
}

/** Maximal runs of capitalized tokens; punctuation ends a run. */
function capitalizedRuns(tokens: RosterToken[]): RosterRun[] {
  const runs: RosterRun[] = [];
  let current: RosterToken[] = [];
  let start = 0;
  tokens.forEach((token, index) => {
    if (token.capitalized) {
      if (!current.length) start = index;
      current.push(token);
      return;
    }
    if (current.length) {
      runs.push({ tokens: current, startIndex: start });
      current = [];
    }
  });
  if (current.length) runs.push({ tokens: current, startIndex: start });
  return runs;
}

/**
 * Split one sentence at quotation boundaries.
 *
 * A capital right after an opening quote begins an utterance, so it is
 * sentence-initial, never mid-sentence. Straight single quotes count only at a
 * word edge; an apostrophe inside a word does not split.
 */
function quoteSegments(sentence: string): string[] {
  const segments: string[] = [];
  let current = '';
  for (let i = 0; i < sentence.length; i++) {
    const ch = sentence[i]!;
    const doubleQuote = ch === '"' || ch === '“' || ch === '”';
    const singleQuote =
      ch === "'" &&
      (i === 0 ||
        /[\s([{—–-]/.test(sentence[i - 1] ?? '') ||
        /[\s)\]},.;:!?—–-]/.test(sentence[i + 1] ?? ''));
    if (doubleQuote || singleQuote) {
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments.length ? segments : [sentence];
}

function sentenceKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^[#\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Heading surfaces for one chunk, from the same detection import used. */
function chunkHeadingKeys(chunk: ChunkRow): Set<string> {
  const keys = new Set<string>();
  const add = (text: string): void => {
    const key = sentenceKey(text);
    if (key) keys.add(key);
  };
  add(chunk.heading);
  for (const heading of findHeadings(chunk.text)) add(heading.heading);
  return keys;
}

type RunRejection =
  | 'invalid'
  | 'contraction'
  | 'function-word'
  | 'title-only'
  | 'common-word';

interface RunCheck {
  surface: string;
  tokens: string[];
  reason?: RunRejection;
}

/**
 * One capitalized run, checked against the universal exclusions.
 *
 * Function words are rejected in both passes, so the mid-sentence vocabulary
 * never contains "the" or "and". A lone title is a role, not a name; a lone
 * common word is only a name when the bank already knows it as one.
 */
function evaluateRosterRun(
  run: RosterRun,
  context: { lowercaseWords: Set<string>; bankedNames: Set<string> },
): RunCheck {
  const slice = run.tokens.slice(0, 4);
  const usable = slice.filter((token) => token.usable);
  const surface = (usable.length ? usable : slice).map((token) => token.text).join(' ');
  if (!usable.length || usable.length !== slice.length) {
    return { surface, tokens: [], reason: 'invalid' };
  }
  const tokens = usable.map((token) => token.text.toLowerCase());
  if (tokens.some((token) => /['’]/.test(token) && !/['’]s$/i.test(token))) {
    return { surface, tokens, reason: 'contraction' };
  }
  if (tokens.some((token) => STOPWORDS.has(token))) {
    return { surface, tokens, reason: 'function-word' };
  }
  if (tokens.every((token) => NAME_TITLE_WORDS.has(token))) {
    return { surface, tokens, reason: 'title-only' };
  }
  if (
    tokens.length === 1 &&
    context.lowercaseWords.has(tokens[0]!) &&
    !context.bankedNames.has(canonicalName(surface))
  ) {
    return { surface, tokens, reason: 'common-word' };
  }
  return { surface, tokens };
}

/**
 * Group exact variants that differ only by titles, e.g. "Ashaline" and
 * "Lady Ashaline". A distinctive token must be at least five letters; no
 * identity is decided, only candidate counting stops duplicating a form.
 */
function variantKey(entry: NameRosterEntry): string | null {
  const distinctive = entry.tokens.filter((token) => !NAME_TITLE_WORDS.has(token));
  if (!distinctive.length) return null;
  if (!distinctive.some((token) => token.length >= 5)) return null;
  return [...new Set(distinctive)].sort(compareText).join(' ');
}

function collapseVariants(entries: NameRosterEntry[]): NameRosterEntry[] {
  const groups = new Map<string, NameRosterEntry[]>();
  const collapsed: NameRosterEntry[] = [];
  for (const entry of entries) {
    const key = variantKey(entry);
    if (!key) {
      collapsed.push(entry);
      continue;
    }
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }
  for (const members of groups.values()) {
    const surfaces = [...members]
      .sort((a, b) => b.count - a.count || compareText(a.surface, b.surface))
      .map((member) => member.surface);
    collapsed.push({
      surface: surfaces[0]!,
      surfaces,
      tokens: [...new Set(members.flatMap((member) => member.tokens))].sort(compareText),
      count: members.reduce((sum, member) => sum + member.count, 0),
      trustedSource: members.some((member) => member.trustedSource === 'mid-sentence')
        ? 'mid-sentence'
        : 'sentence-start-matched',
    });
  }
  return collapsed.sort((a, b) => b.count - a.count || compareText(a.surface, b.surface));
}

/**
 * Book-wide name candidates from capitalization alone.
 *
 * Pass A records every capitalized run *inside* an utterance segment, so the
 * closed set of sentence starters never enters the vocabulary. Pass B revisits
 * segment starts and keeps a run only when one of its tokens was already seen
 * inside a segment. Two passes, no model calls, no persistence.
 */
export function buildNameRoster(
  db: Db,
  projectId: number,
  loaded?: ChunkRow[],
): NameRoster {
  const chunks = loaded ?? loadOrderedChunks(db, projectId);
  const bankedNames = new Set<string>();
  for (const row of db.all<{ name: string; aliases: string }>(
    'SELECT name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  )) {
    const name = canonicalName(row.name);
    if (name) bankedNames.add(name);
    for (const alias of strList(row.aliases)) {
      const key = canonicalName(alias);
      if (key) bankedNames.add(key);
    }
  }
  const contextFor = (chunk: ChunkRow) => ({
    // Whole words that really appear lowercase, not the lowercase form of a
    // capitalized name elsewhere in the same chunk.
    lowercaseWords: new Set(chunk.text.match(/\b[a-z][a-z'’-]*\b/g) ?? []),
    bankedNames,
  });

  const midTokens = new Set<string>();
  const midSurfaces = new Map<string, { surface: string; tokens: string[]; count: number }>();

  for (const chunk of chunks) {
    const headings = chunkHeadingKeys(chunk);
    const context = contextFor(chunk);
    for (const sentence of splitSentences(chunk.text)) {
      if (headings.has(sentenceKey(sentence))) continue;
      for (const segment of quoteSegments(sentence)) {
        const runs = capitalizedRuns(rosterSentenceTokens(segment));
        for (const run of runs) {
          // Segment-initial capitalization is the thing Pass B judges.
          if (run.startIndex === 0) continue;
          const check = evaluateRosterRun(run, context);
          if (check.reason) continue;
          const tokens = check.tokens;
          for (const token of tokens) midTokens.add(token);
          const key = check.surface.toLowerCase();
          const existing = midSurfaces.get(key);
          if (existing) existing.count++;
          else midSurfaces.set(key, { surface: check.surface, tokens, count: 1 });
        }
      }
    }
  }

  const startedSurfaces = new Map<string, { surface: string; tokens: string[]; count: number }>();
  const rejectedSurfaces = new Map<string, number>();
  const diagnostics: NameRosterDiagnostics = {
    sentenceInitialCandidates: 0,
    accepted: 0,
    rejected: 0,
    topRejected: [],
    quotedStarts: 0,
    rejectedInvalid: 0,
    rejectedContraction: 0,
    rejectedFunctionWord: 0,
    rejectedTitleOnly: 0,
    rejectedCommonWord: 0,
    rejectedStoplist: 0,
    rejectedNoMidSentence: 0,
  };

  const reject = (reason: RunRejection | 'stoplist' | 'no-mid', surface: string): void => {
    diagnostics.rejected++;
    rejectedSurfaces.set(surface, (rejectedSurfaces.get(surface) ?? 0) + 1);
    if (reason === 'invalid') diagnostics.rejectedInvalid++;
    else if (reason === 'contraction') diagnostics.rejectedContraction++;
    else if (reason === 'function-word') diagnostics.rejectedFunctionWord++;
    else if (reason === 'title-only') diagnostics.rejectedTitleOnly++;
    else if (reason === 'common-word') diagnostics.rejectedCommonWord++;
    else if (reason === 'stoplist') diagnostics.rejectedStoplist++;
    else diagnostics.rejectedNoMidSentence++;
  };

  for (const chunk of chunks) {
    const headings = chunkHeadingKeys(chunk);
    const context = contextFor(chunk);
    for (const sentence of splitSentences(chunk.text)) {
      if (headings.has(sentenceKey(sentence))) continue;
      const segments = quoteSegments(sentence);
      diagnostics.quotedStarts += Math.max(0, segments.length - 1);
      for (const segment of segments) {
        const runs = capitalizedRuns(rosterSentenceTokens(segment));
        const initial = runs.find((run) => run.startIndex === 0);
        if (!initial) continue;
        diagnostics.sentenceInitialCandidates++;
        const check = evaluateRosterRun(initial, context);
        if (check.reason) {
          reject(check.reason, check.surface);
          continue;
        }
        const firstWord = check.tokens[0] ?? '';
        if (NAME_STARTER_STOPLIST.has(firstWord)) {
          reject('stoplist', check.surface);
          continue;
        }
        if (!check.tokens.some((token) => midTokens.has(token))) {
          reject('no-mid', check.surface);
          continue;
        }
        diagnostics.accepted++;
        const key = check.surface.toLowerCase();
        const existing = startedSurfaces.get(key);
        if (existing) existing.count++;
        else startedSurfaces.set(key, { surface: check.surface, tokens: check.tokens, count: 1 });
      }
    }
  }

  const exact = new Map<string, NameRosterEntry>();
  for (const [key, value] of midSurfaces) {
    exact.set(key, {
      surface: value.surface,
      surfaces: [value.surface],
      tokens: value.tokens,
      count: value.count,
      trustedSource: 'mid-sentence',
    });
  }
  for (const [key, value] of startedSurfaces) {
    const existing = exact.get(key);
    if (existing) {
      existing.count += value.count;
      continue;
    }
    exact.set(key, {
      surface: value.surface,
      surfaces: [value.surface],
      tokens: value.tokens,
      count: value.count,
      trustedSource: 'sentence-start-matched',
    });
  }

  diagnostics.topRejected = [...rejectedSurfaces.entries()]
    .map(([surface, count]) => ({ surface, count }))
    .sort((a, b) => b.count - a.count || compareText(a.surface, b.surface))
    .slice(0, 20);

  return { entries: collapseVariants([...exact.values()]), diagnostics };
}

/**
 * One surface for this entry in the window: the first variant actually present
 * whole-word, else the representative when one of its tokens occurs. Collapsed
 * variants never become two entries in the same list.
 */
function rosterEntryInWindow(
  entry: NameRosterEntry,
  hayCanonical: string,
  hayTokens: Set<string>,
): string[] {
  const present = entry.surfaces.find((surface) => {
    const canonical = canonicalName(surface);
    return !!canonical && ` ${hayCanonical} `.includes(` ${canonical} `);
  });
  if (present) return [present];
  return entry.tokens.some((token) => hayTokens.has(token)) ? [entry.surface] : [];
}

/**
 * The entities this window actually mentions.
 *
 * The relations call is only allowed to use these names, so it cannot invent a
 * person and cannot attach a relation to a name it hallucinated.
 */
export function windowEntityNames(
  db: Db,
  projectId: number,
  window: ChunkRow[],
  roster?: NameRoster,
): string[] {
  const hayCanonical = canonicalName(window.map((c) => c.text).join(' '));
  const hayTokens = new Set(hayCanonical.split(' ').filter(Boolean));
  const names: string[] = [];
  for (const entity of listEntities(db, projectId)) {
    const variants = [entity.name, ...entity.aliases];
    if (
      variants.some((variant) =>
        nameMentionedFromTokens(variant, hayCanonical, hayTokens, { partial: true }),
      )
    ) {
      names.push(entity.name);
    }
  }
  // Finder spans ride along when a sidecar has recorded them: names the CPU
  // pointer saw in these passages, merged with the bank's names. Absent file
  // means today's behavior, exactly as before. Universal: names only, never
  // book-specific content in code.
  for (const n of finderNamesFor(db, window)) {
    if (!names.some((e) => e.toLowerCase() === n.toLowerCase())) names.push(n);
  }
  // The bank keeps exactly the list it had before the roster: the old 60-name
  // ceiling, deduped. Raising the total to 80 gives the roster room instead of
  // letting a saturated bank list squeeze every new name out.
  const bankNames = uniqueNames(names).slice(0, WINDOW_BANK_NAME_CAP);
  // Roster names are book-wide capitalization candidates, so a person the
  // entity call never banked can still be related inside a window that names
  // them. Whole-word only; the roster is names, never identities.
  const merged = [...bankNames];
  if (roster) {
    for (const entry of roster.entries) {
      if (!rosterEntryInWindow(entry, hayCanonical, hayTokens)) continue;
      merged.push(entry.surface);
    }
  }
  return uniqueNames(merged).slice(0, WINDOW_NAME_CAP);
}

/** The cleaned roster alone (no bank or finder names) for the window. */
export function windowRosterNames(window: ChunkRow[], roster: NameRoster): string[] {
  const hayCanonical = canonicalName(window.map((chunk) => chunk.text).join(' '));
  const hayTokens = new Set(hayCanonical.split(' ').filter(Boolean));
  const names: string[] = [];
  for (const entry of roster.entries) {
    for (const surface of rosterEntryInWindow(entry, hayCanonical, hayTokens)) names.push(surface);
  }
  return uniqueNames(names).slice(0, WINDOW_NAME_CAP);
}

/** Case-insensitive stable dedupe for one window's name list. */
function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    const clean = name.trim();
    const key = clean.toLowerCase();
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    unique.push(clean);
  }
  return unique;
}

/** Trust order for automatic merges: a human ruling always outranks the
 * machine, and the machine never downgrades either on its own. Explicit
 * user action (or a user-run review) is the only way a keeper changes. */
function trustRank(status: string): number {
  return status === 'user_confirmed' ? 2 : status === 'accepted' ? 1 : 0;
}

function maxTrust(a: string, b: string): string {
  return trustRank(a) >= trustRank(b) ? a : b;
}

/** Cached finder-spans map: chunk seq -> names. Missing/unreadable = none. */
const finderCache = new Map<string, Map<number, string[]>>();
function finderNamesFor(db: Db, window: ChunkRow[]): string[] {
  const path = join(dirname(db.path), 'finder-spans.json');
  let bySeq = finderCache.get(path);
  if (bySeq === undefined) {
    bySeq = new Map();
    try {
      if (existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string[]>;
        for (const [k, v] of Object.entries(raw)) {
          if (Array.isArray(v)) bySeq.set(Number(k), [...new Set(v.map((s) => String(s).trim()).filter(Boolean))].slice(0, 40));
        }
      }
    } catch {
      bySeq = new Map();
    }
    finderCache.set(path, bySeq);
  }
  const out: string[] = [];
  for (const c of window) {
    for (const n of bySeq.get(c.seq) ?? []) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Check a quote, counting what the gate did with it when the gate is on. */
function spanFor(
  raw: unknown,
  chunk: ChunkRow | undefined,
  neighbours: ChunkRow[],
  gate: boolean,
  verification: VerificationStats,
): SpanCheck {
  if (!gate) {
    // The pre-Phase-1 path keeps its lenient correction.
    return { ...verifyQuote(raw, chunk, neighbours), status: 'verified' };
  }
  const span = verifySpan(raw, chunk, neighbours);
  verification.claimed++;
  if (span.status === 'verified') verification.verified++;
  else if (span.status === 'repointed') verification.repointed++;
  else verification.dropped++;
  return span;
}

/** Write the entity section. Returns how many claims were accepted. */
function applyEntities(
  db: Db,
  projectId: number,
  raws: Record<string, unknown>[],
  window: ChunkRow[],
  entityIdByName: Map<string, number>,
  stats: ExtractLoreResult,
  neighboursOf: (id: number | undefined) => ChunkRow[],
  gate: boolean,
): number {
  let accepted = 0;
  for (const raw of raws) {
    const name = String(raw.name ?? '').trim();
    if (!name) continue;
    const kind = normaliseKind(String(raw.kind ?? 'character'));
    // A description, a conjunction, or a group is never a new character.
    // Skipped here, relations naming it fall into the existing unresolved
    // path and are counted there.
    if (
      kind === 'character' &&
      (isDescriptiveCharacterName(name) || isConjoinedCharacterName(name) || isGroupCharacterName(name))
    ) {
      continue;
    }
    const chunk = chunkAt(window, raw.chunk_index);
    const span = spanFor(raw.evidence, chunk, neighboursOf(chunk?.id), gate, stats.verification);
    if (span.status === 'dropped') continue;
    const evidence = span.quote;
    const refs = span.chunkId !== null
      ? [{ source: span.source, locator: span.locator, chunk: span.chunkId }]
      : refsFor(chunk);
    const existing = entityIdByName.get(key(name)) ?? findEntityId(db, projectId, kind, name);
    const attributes = (raw.attributes ?? {}) as Record<string, unknown>;
    if (existing) {
      db.run(
        `UPDATE canon_entity SET summary = ?, role = ?, status = ?, attributes = ?, evidence = ?,
                source_refs = ?, mentions = mentions + 1, updated_at = ? WHERE id = ?`,
        String(raw.summary ?? '').trim(),
        String(raw.role ?? '').trim(),
        String(raw.status ?? '').trim(),
        toJson(Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, String(v)]))),
        evidence,
        toJson(refs),
        nowIso(),
        existing,
      );
      entityIdByName.set(key(name), existing);
      accepted++;
      continue;
    }
    db.run(
      `INSERT OR IGNORE INTO canon_entity (project_id, kind, name, aliases, summary, attributes, role, status,
                                 first_chunk, evidence, source_refs, mentions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      projectId,
      kind,
      name,
      toJson(toStringArray(raw.aliases)),
      String(raw.summary ?? '').trim(),
      toJson(Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, String(v)]))),
      String(raw.role ?? '').trim(),
      String(raw.status ?? '').trim(),
      span.chunkId ?? chunk?.id ?? null,
      evidence,
      toJson(refs),
      nowIso(),
      nowIso(),
    );
    const row = db.get<{ id: number }>(
      'SELECT id FROM canon_entity WHERE project_id = ? AND kind = ? AND lower(name) = lower(?)',
      projectId,
      kind,
      name,
    );
    if (row) {
      entityIdByName.set(key(name), row.id);
      stats.entities++;
      accepted++;
    }
  }
  return accepted;
}

/** Write the fact section. Returns how many claims were accepted. */
function applyFacts(
  db: Db,
  projectId: number,
  raws: Record<string, unknown>[],
  window: ChunkRow[],
  stats: ExtractLoreResult,
  neighboursOf: (id: number | undefined) => ChunkRow[],
  gate: boolean,
): number {
  let accepted = 0;
  for (const raw of raws) {
    const statement = String(raw.statement ?? '').trim();
    if (!statement) continue;
    const chunk = chunkAt(window, raw.chunk_index);
    const span = spanFor(raw.evidence, chunk, neighboursOf(chunk?.id), gate, stats.verification);
    if (span.status === 'dropped') continue;
    const subject = String(raw.subject ?? '').trim();
    const subjectLink = subject ? resolveSubjectEntity(db, projectId, subject) : { missing: true as const };
    const subjectEntityId = 'id' in subjectLink ? subjectLink.id : null;
    const dup = db.get<{ id: number; subject_entity_id: number | null }>(
      'SELECT id, subject_entity_id FROM canon_fact WHERE project_id = ? AND statement = ?',
      projectId,
      statement,
    );
    if (dup) {
      // A duplicate statement is an update opportunity, never a second row.
      // Only fill a missing link; an existing link is never overwritten.
      if (subjectEntityId !== null && dup.subject_entity_id === null) {
        db.run('UPDATE canon_fact SET subject_entity_id = ? WHERE id = ?', subjectEntityId, dup.id);
      }
      accepted++;
      continue;
    }
    const refs = span.chunkId !== null
      ? [{ source: span.source, locator: span.locator, chunk: span.chunkId }]
      : refsFor(chunk);
    db.run(
      `INSERT INTO canon_fact (project_id, topic, statement, kind, certainty, subject, evidence, source_refs, subject_entity_id, modality, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      String(raw.topic ?? '').trim(),
      statement,
      String(raw.kind ?? 'fact').trim(),
      String(raw.certainty ?? 'confirmed').trim(),
      subject,
      span.quote,
      toJson(refs),
      subjectEntityId,
      normaliseModality(raw.modality),
      nowIso(),
    );
    stats.facts++;
    accepted++;
  }
  return accepted;
}

function proofTokens(text: string, minLen: number): Set<string> {
  return new Set(
    normalise(String(text ?? ''))
      .split(' ')
      .filter((w) => w.length >= minLen && !PROOF_TITLES.has(w) && !PROOF_FILLER.has(w)),
  );
}

/** Roster names with aliases for one project: id -> token set. */
function rosterTokens(db: Db, projectId: number): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const row of db.all<{ id: number; name: string; aliases: string }>(
    'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  )) {
    const toks = proofTokens(row.name, 3);
    for (const a of strList(row.aliases)) for (const t of proofTokens(a, 3)) toks.add(t);
    out.set(row.id, toks);
  }
  return out;
}

/**
 * Proof relevance (soft cap: demote, never delete).
 *
 * A proving quote passes when it names at least one endpoint of its claim,
 * or when it names nobody at all (pronoun and scene-color quotes stay).
 * It fails only when it names a *third* roster person absent from the claim —
 * a quote about Neville attached to a Seamus-to-Ron claim. Same-subject
 * fiction, unjudged meaning: the row is still written, flagged for review.
 */
function proofRelevance(
  roster: Map<number, Set<string>>,
  fromId: number,
  toId: number,
  quote: string,
): boolean {
  const words = proofTokens(quote, 3);
  if (!words.size) return true;
  const endpoints = new Set<string>();
  for (const id of [fromId, toId]) for (const t of roster.get(id) ?? []) endpoints.add(t);
  if ([...endpoints].some((t) => words.has(t))) return true;
  for (const [id, toks] of roster) {
    if (id === fromId || id === toId) continue;
    for (const t of toks) {
      if (t.length >= 4 && words.has(t)) return false;
    }
  }
  return true;
}

/* --------------------------------------------------- bank-aware ranking */

/**
 * One passage a caller already retrieved. Ranking only reorders these; it
 * never drops one and never adds a passage the caller did not supply.
 */
export interface BankRankCandidate {
  chunkId: number;
  text?: string;
  score?: number;
}

/**
 * Weights for the shared bank-aware ranker. Tune here, not at call sites.
 *
 * A candidate scores as:
 *   tier base + alias weight × alias hits + direction weight × lean
 *     + lexical weight × lexical score
 *
 * Tier dominates, so a keeper always outranks a parked row and both outrank
 * plain text. The smaller terms only order candidates inside a tier. Ranking
 * is a reorder, never a filter: a passage with no bank backing keeps its place
 * at the text tier, and a query that names nobody in the bank keeps its order.
 */
const BANK_RANK_TIER = { keeper: 4, attested: 3, parked: 2, mention: 1, text: 0 } as const;
const BANK_RANK_ALIAS_WEIGHT = 0.35;
const BANK_RANK_DIRECTION_WEIGHT = 0.35;
const BANK_RANK_LEXICAL_WEIGHT = 0.2;
/**
 * Coverage of the other ends of a query's banked ties. Their aliases widen
 * what a passage can match, but at a fraction of a directly named entity, and
 * capped so a crowded scene cannot outrank the name the query asked about.
 */
const BANK_RANK_LINKED_ALIAS_WEIGHT = 0.02;
const BANK_RANK_LINKED_ALIAS_CAP = 3;
/** How many bank-backed chunks one query may add to a candidate pool. */
const BANK_RANK_EXPAND_LIMIT = 40;

type BankProofTier = keyof typeof BANK_RANK_TIER;

interface BankRelationRow {
  id: number;
  fromId: number;
  toId: number;
  kind: string;
  status: string;
  chunks: number[];
}

export interface BankQueryProfile {
  /** Query words that can name something (stopwords removed). */
  tokens: string[];
  /** The query as raw lowercase words, stopwords kept, for direction. */
  words: string[];
  /** Entities the query names directly, by name or alias. */
  matched: Set<number>;
  /** Entities one banked relation away from a matched entity. */
  linked: Set<number>;
  /** Bank tokens the query names, with exact (1) or fuzzy (0.5) weight. */
  matchTokens: Map<string, number>;
  /** Query tokens that linked to at least one bank token. */
  matchedQuery: Set<string>;
  /** Entities named by a query token that is not a relation-kind cue. */
  named: Set<number>;
  /** True when a correctly directed keeper already matches the exact kind. */
  exactCue: boolean;
  /** True when the query's content is only banked names (a name lookup). */
  bareName: boolean;
  /** True when the query asks for a relation (a cue matches a banked kind). */
  bankActive: boolean;
  /** Entity id -> first raw-word position of its name or alias. */
  order: Map<number, number>;
  /** Entity id -> identifying tokens of its name and aliases. */
  entityTokens: Map<number, Set<string>>;
  /** Relations touching a matched entity, with their proving chunks. */
  relations: BankRelationRow[];
}

/**
 * Map a query onto the bank: names and aliases first, then one relation hop.
 *
 * Nothing here reads outside the project, and nothing writes. A query that
 * names no banked entity yields an empty profile, which is what keeps a
 * nonsense question from surfacing a keeper.
 */
export function buildBankProfile(db: Db, projectId: number, query: string): BankQueryProfile {
  const clean = (query ?? '').replace(/[’']s\b/g, '');
  const tokens = tokenize(clean);
  const words = (query ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const profile: BankQueryProfile = {
    tokens,
    words,
    matched: new Set(),
    linked: new Set(),
    matchTokens: new Map(),
    matchedQuery: new Set(),
    named: new Set(),
    exactCue: false,
    bareName: false,
    bankActive: false,
    order: new Map(),
    entityTokens: new Map(),
    relations: [],
  };
  if (!tokens.length) return profile;

  const rows = db.all<{ id: number; name: string; aliases: string }>(
    'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  );
  const allTokens = new Map<number, Set<string>>();
  const frequency = new Map<string, number>();
  for (const row of rows) {
    const toks = proofTokens(row.name, 3);
    for (const a of strList(row.aliases)) for (const t of proofTokens(a, 3)) toks.add(t);
    allTokens.set(row.id, toks);
    for (const token of toks) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
  for (const [id, toks] of allTokens) {
    profile.entityTokens.set(
      id,
      new Set(
        [...toks].filter(
          (token) =>
            token.length >= NAME_MIN_TOKEN &&
            (frequency.get(token) ?? 0) <= NAME_DF_CAP,
        ),
      ),
    );
  }

  // Map the query's distinctive tokens onto entities. A shared surname can
  // match several rows; that is the bank's existing ambiguity, and the ranker
  // stays soft rather than deciding the merge here. A long token one edit
  // away counts as the same name at half weight.
  for (const [id, toks] of profile.entityTokens) {
    for (const token of tokens) {
      if (token.length < NAME_MIN_TOKEN) continue;
      const hit = linkTokenMatch(toks, token);
      if (!hit) continue;
      profile.matched.add(id);
      profile.matchedQuery.add(token);
      const current = profile.matchTokens.get(hit.bankToken) ?? 0;
      if (hit.weight > current) profile.matchTokens.set(hit.bankToken, hit.weight);
    }
  }
  // A query made only of bank names/titles asks about the entity as a whole;
  // a query with other content words asks something more specific and needs a
  // matching relation kind before a banked tie can count as proof. "Where",
  // "when", "why" and "how" ask for an attribute even when the rest is a name.
  if (!profile.matched.size) return profile;
  const attributeQuestion = /\b(where|when|why|how)\b/.test((query ?? '').toLowerCase());
  profile.bareName =
    !attributeQuestion &&
    tokens.length > 0 &&
    tokens.every((token) => profile.matchedQuery.has(token) || (frequency.get(token) ?? 0) > 0);

  const relationRows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    review_status: string | null;
    source_refs: string;
  }>(
    `SELECT id, from_entity, to_entity, kind, review_status, source_refs
     FROM canon_relation WHERE project_id = ? ORDER BY id`,
    projectId,
  );
  for (const row of relationRows) {
    if (!profile.matched.has(row.from_entity) && !profile.matched.has(row.to_entity)) continue;
    profile.linked.add(row.from_entity);
    profile.linked.add(row.to_entity);
    const chunks: number[] = [];
    for (const ref of fromJson<{ chunk?: unknown }[]>(row.source_refs, [])) {
      const chunk = Number(ref?.chunk);
      if (Number.isFinite(chunk)) chunks.push(chunk);
    }
    profile.relations.push({
      id: row.id,
      fromId: row.from_entity,
      toId: row.to_entity,
      kind: row.kind,
      status: row.review_status ?? 'accepted',
      chunks,
    });
  }

  // A relation kind's words are cues, not names. The set is built once so
  // every path agrees which query words are touch tokens.
  const cueWords = new Set<string>();
  for (const row of relationRows) {
    if (canonicalName(row.kind) === 'appears with') continue;
    for (const token of answerKindTokens(row.kind)) cueWords.add(token);
    for (const kind of inverseKinds(row.kind)) {
      for (const token of answerKindTokens(kind)) cueWords.add(token);
    }
  }
  profile.named.clear();
  for (const [id, toks] of profile.entityTokens) {
    for (const token of profile.tokens) {
      if (cueWords.has(token)) continue;
      if (linkTokenMatch(toks, token)) {
        profile.named.add(id);
        break;
      }
    }
  }

  // Raw-word position of each named entity, skipping cue words first so a
  // title word cannot stand in for the person's actual name.
  profile.order.clear();
  for (const id of profile.named) {
    const toks = profile.entityTokens.get(id);
    if (!toks) continue;
    let fallback = -1;
    for (let i = 0; i < words.length; i++) {
      const word = (words[i] ?? '').replace(/[’']s$/, '');
      if (word.length < NAME_MIN_TOKEN) continue;
      if (!linkTokenMatch(toks, word)) continue;
      if (fallback < 0) fallback = i;
      if (!cueWords.has(word)) {
        profile.order.set(id, i);
        break;
      }
    }
    if (!profile.order.has(id) && fallback >= 0) profile.order.set(id, fallback);
  }

  profile.exactCue = profile.relations.some((relation) => {
    if (relationTier(relation) !== 'keeper') return false;
    if (!profile.named.has(relation.fromId) && !profile.named.has(relation.toId)) return false;
    const hits = answerKindHits(profile, relation.kind);
    if (hits === 0) return false;
    return answerRelationLean(profile, relation, { kind: relation.kind, inverse: false, hits }) >= 0;
  });

  profile.bankActive =
    profile.bareName ||
    profile.relations.some((relation) => {
      const shared = cueDirectionTouch(profile, relation);
      return shared.touches && shared.cueHits > 0;
    });
  return profile;
}

/**
 * What a relation is worth as proof.
 *
 * A keeper is confirmed (user or accepted) and states a tie. Attested sits
 * below keeper: passage-proof and citable with its passage scope, but not
 * sentence-proven. `appears_with` is a mention: two names in one passage,
 * coverage and never evidence. Everything else is parked. Mirrors the answer
 * rule: only keeper-grade ties may be stated outright; attested ties are
 * cited with their passage scope shown.
 */
function relationTier(relation: BankRelationRow): BankProofTier {
  const kind = canonicalName(relation.kind);
  if (kind === 'appears with') return 'mention';
  if (relation.status === 'accepted' || relation.status === 'user_confirmed') return 'keeper';
  if (relation.status === 'attested') return 'attested';
  return 'parked';
}

/* ----------------------------------------- bank-answer cue and inverse rules */

/**
 * The role noun at the front of a relation kind: "master of" → "master",
 * "partner with" → "partner", "married to" → "married", "partner" → "partner".
 * Kinds only; entity names never pass through this.
 */
function kindHead(kind: string): string {
  const canonical = canonicalName(kind);
  for (const particle of KIND_PARTICLES) {
    if (canonical.endsWith(` ${particle}`)) {
      return canonical.slice(0, -(particle.length + 1)).trim();
    }
  }
  return canonical;
}

/**
 * One entry per unordered inverse pair. Both directions are built below, so a
 * new pair cannot accidentally be added one-way. Bare role heads only.
 */
export const INVERSE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['master', 'apprentice'],
  ['parent', 'child'],
  ['parent', 'son'],
  ['parent', 'daughter'],
];

/**
 * Build the one-way lookup from the unordered pair list. Each side points at
 * every partner it appears with; a shared head such as "parent" accumulates
 * all of its children. The map and its lists are frozen at load.
 */
export function buildInverseMap(
  pairs: ReadonlyArray<readonly [string, string]>,
): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const list = out.get(from);
    if (!list) out.set(from, [to]);
    else if (!list.includes(to)) list.push(to);
  };
  for (const [left, right] of pairs) {
    link(left, right);
    link(right, left);
  }
  const frozen = new Map<string, readonly string[]>();
  for (const [key, values] of out) frozen.set(key, Object.freeze(values));
  return Object.freeze(frozen);
}

const KIND_INVERSES: ReadonlyMap<string, readonly string[]> = buildInverseMap(INVERSE_PAIRS);

/** Kind words that can cue a relation; "of" and articles never count. */
function answerKindTokens(kind: string): Set<string> {
  return new Set(
    tokenize(kindHead(kind)).filter(
      (token) => token.length >= 3 && !ANSWER_CUE_STOPWORDS.has(token),
    ),
  );
}

function answerKindHits(profile: BankQueryProfile, kind: string): number {
  const tokens = answerKindTokens(kind);
  const query = new Set(profile.tokens);
  return [...tokens].filter((token) => query.has(token)).length;
}

function inverseKinds(kind: string): readonly string[] {
  return KIND_INVERSES.get(kindHead(kind)) ?? [];
}

interface AnswerCue {
  kind: string;
  inverse: boolean;
  hits: number;
}

/**
 * The kind the question actually names: the row's own kind first, then a
 * universal inverse. "master of" therefore reaches an apprentice-of row.
 */
function answerCue(profile: BankQueryProfile, relation: BankRelationRow): AnswerCue | undefined {
  const actualHits = answerKindHits(profile, relation.kind);
  if (actualHits > 0) return { kind: relation.kind, inverse: false, hits: actualHits };
  // A correctly directed keeper of the asked kind wins over an inverse
  // reading. Inverse kinds are the fallback, not a second equal answer.
  if (profile.exactCue) return undefined;
  let best: AnswerCue | undefined;
  for (const kind of inverseKinds(relation.kind)) {
    const hits = answerKindHits(profile, kind);
    if (hits > (best?.hits ?? 0)) best = { kind, inverse: true, hits };
  }
  return best;
}

/**
 * Existing direction lean, with the arrow flipped when the question used the
 * inverse kind. Still only reorders among keepers that touch a named entity.
 */
function answerRelationLean(
  profile: BankQueryProfile,
  relation: BankRelationRow,
  cue: AnswerCue,
): number {
  const kindTokens = answerKindTokens(cue.kind);
  let lean = Math.min(2, cue.hits);
  const fromMatched = profile.named.has(relation.fromId);
  const toMatched = profile.named.has(relation.toId);
  if (fromMatched && toMatched) {
    const fromOrder = profile.order.get(relation.fromId);
    const toOrder = profile.order.get(relation.toId);
    if (fromOrder !== undefined && toOrder !== undefined) {
      const orderLean = fromOrder < toOrder ? 1 : -1;
      lean += cue.inverse ? -orderLean : orderLean;
    }
    return lean;
  }
  const matchedId = fromMatched ? relation.fromId : toMatched ? relation.toId : undefined;
  if (matchedId === undefined) return lean;
  const side = querySideFor(profile, matchedId, kindTokens);
  if (!side) return lean;
  const agrees = cue.inverse
    ? side === 'from'
      ? matchedId === relation.toId
      : matchedId === relation.fromId
    : side === 'from'
      ? matchedId === relation.fromId
      : matchedId === relation.toId;
  return lean + (agrees ? 1 : -2);
}

/**
 * The shared cue/direction/touch decision.
 *
 * Touch means an endpoint is named by a query token that is not a relation
 * cue. Cue hits use the kind head (particles stripped), the row's own kind
 * first and the existing inverse pairs second. Direction uses the same grammar
 * rules for both paths.
 *
 * `allowBareName` is only for the ranker's focus-name path: a query made only
 * of names has no cue, but the ranker may still surface keeper evidence for a
 * scene. The bank-answer line leaves it false because it must abstain when no
 * relation was asked.
 */
interface CueDirectionTouch {
  touches: boolean;
  cueHits: number;
  inverse: boolean;
  lean: number;
  /** The ranker may treat a bare-name query as evidence; the answer line may not. */
  bare: boolean;
}

function cueDirectionTouch(
  profile: BankQueryProfile,
  relation: BankRelationRow,
  allowBareName = false,
): CueDirectionTouch {
  const touches = profile.named.has(relation.fromId) || profile.named.has(relation.toId);
  if (!touches) return { touches: false, cueHits: 0, inverse: false, lean: 0, bare: false };
  const cue = answerCue(profile, relation);
  if (!cue) {
    return {
      touches: true,
      cueHits: 0,
      inverse: false,
      lean: 0,
      bare: allowBareName && profile.bareName,
    };
  }
  return {
    touches: true,
    cueHits: cue.hits,
    inverse: cue.inverse,
    lean: answerRelationLean(profile, relation, cue),
    bare: false,
  };
}

/**
 * Which end of a "<role> of" relation the query puts a named entity on.
 *
 * Read from the grammar, not from book words:
 *   "X's role"            → X is the one the role is to (`to`)
 *   "X role" (no article) → same reading, apostrophe omitted
 *   "X the role of"       → X has the role (`from`)
 *   "the role of X"       → X is the one the role is to (`to`)
 * A query that cannot be read stays neutral; direction only reorders.
 */
function querySideFor(
  profile: BankQueryProfile,
  entityId: number,
  kindTokens: Set<string>,
): 'from' | 'to' | undefined {
  const position = profile.order.get(entityId);
  if (position === undefined) return undefined;
  const word = profile.words[position] ?? '';
  if (/[’']s$/.test(word)) return 'to';
  const cuePosition = profile.words.findIndex((entry) => kindTokens.has(entry));
  if (cuePosition < 0) return undefined;
  if (position > cuePosition) return 'to';
  const between = profile.words.slice(position + 1, cuePosition);
  return between.includes('the') ? 'from' : 'to';
}

/**
 * How many of the query's names a passage actually carries.
 *
 * A token the query itself used to name a bank entity counts in full when the
 * spelling is exact and at half weight when it is one typo away. The other
 * ends of those entities' banked ties are expanded to their full alias token
 * sets too, but at a fraction and capped: a page crowded with the queried
 * person's associates cannot outrank the page naming the person.
 */
function aliasHits(profile: BankQueryProfile, text: string): number {
  if (!text || !profile.matchTokens.size) return 0;
  const words = new Set(tokenize(text));
  let hits = 0;
  for (const [token, weight] of profile.matchTokens) {
    if (words.has(token)) hits += weight;
  }
  let linked = 0;
  for (const id of profile.linked) {
    if (profile.matched.has(id)) continue;
    const toks = profile.entityTokens.get(id);
    if (!toks) continue;
    if ([...toks].some((token) => words.has(token))) linked++;
  }
  return hits + Math.min(linked, BANK_RANK_LINKED_ALIAS_CAP) * BANK_RANK_LINKED_ALIAS_WEIGHT;
}

/** The best proof a passage carries, and the direction lean of that proof. */
function proofFor(profile: BankQueryProfile, chunkId: number): { tier: BankProofTier; lean: number } {
  let tier: BankProofTier = 'text';
  let lean = 0;
  for (const relation of profile.relations) {
    if (!relation.chunks.includes(chunkId)) continue;
    const shared = cueDirectionTouch(profile, relation, true);
    if (!shared.touches) continue;
    if (shared.cueHits === 0 && !shared.bare) continue;
    if (shared.lean < 0) continue;
    const next = relationTier(relation);
    const nextLean = shared.lean;
    if (
      BANK_RANK_TIER[next] > BANK_RANK_TIER[tier] ||
      (next === tier && nextLean > lean)
    ) {
      tier = next;
      lean = nextLean;
    }
  }
  return { tier, lean };
}

/**
 * Reorder retrieved passages by what the bank can prove about the query.
 *
 * Universal by construction: it knows only names, aliases, relation kinds,
 * review status and source chunks. It carries no book terms and writes
 * nothing. Callers keep their own candidate pool; this only sorts it.
 */
export function rankWithBank<T extends BankRankCandidate>(
  db: Db,
  projectId: number,
  query: string,
  candidates: T[],
  providedProfile?: BankQueryProfile,
): T[] {
  if (candidates.length < 2) return candidates.slice();
  const profile = providedProfile ?? buildBankProfile(db, projectId, query);
  if (!profile.matched.size || !profile.bankActive) return candidates.slice();

  const textCache = new Map<number, string>();
  const scored = candidates.map((candidate, index) => {
    let text = candidate.text ?? '';
    if (!text) {
      text = textCache.get(candidate.chunkId) ?? '';
      if (!text) {
        text =
          db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', candidate.chunkId)?.text ?? '';
        textCache.set(candidate.chunkId, text);
      }
    }
    const proof = proofFor(profile, candidate.chunkId);
    const lexical = Number.isFinite(candidate.score)
      ? Math.max(0, Math.min(1, Number(candidate.score)))
      : 0;
    const score =
      BANK_RANK_TIER[proof.tier] +
      BANK_RANK_ALIAS_WEIGHT * aliasHits(profile, text) +
      BANK_RANK_DIRECTION_WEIGHT * proof.lean +
      BANK_RANK_LEXICAL_WEIGHT * lexical;
    return { candidate, index, score };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.candidate);
}

/**
 * Chunk ids the bank can vouch for on this query.
 *
 * Only relations that touch an entity the query names are returned, so a
 * nonsense query adds nothing. Ordered by proof tier, then cue agreement,
 * then relation id for determinism. Callers fetch the text; nothing is
 * written and no relation is changed.
 */
export function bankLinkedChunkIds(
  db: Db,
  projectId: number,
  query: string,
  limit = BANK_RANK_EXPAND_LIMIT,
  providedProfile?: BankQueryProfile,
): number[] {
  const profile = providedProfile ?? buildBankProfile(db, projectId, query);
  if (!profile.matched.size || !profile.bankActive) return [];
  const best = new Map<number, { tier: number; lean: number; relation: number }>();
  for (const relation of profile.relations) {
    const shared = cueDirectionTouch(profile, relation, true);
    if (!shared.touches) continue;
    if (shared.cueHits === 0 && !shared.bare) continue;
    if (shared.lean < 0) continue;
    const tier = BANK_RANK_TIER[relationTier(relation)];
    const lean = shared.lean;
    for (const chunk of relation.chunks) {
      const current = best.get(chunk);
      if (
        !current ||
        tier > current.tier ||
        (tier === current.tier && lean > current.lean) ||
        (tier === current.tier && lean === current.lean && relation.id < current.relation)
      ) {
        best.set(chunk, { tier, lean, relation: relation.id });
      }
    }
  }
  return [...best.entries()]
    .sort(
      (a, b) =>
        b[1].tier - a[1].tier ||
        b[1].lean - a[1].lean ||
        a[1].relation - b[1].relation ||
        a[0] - b[0],
    )
    .slice(0, limit)
    .map(([chunkId]) => chunkId);
}

/**
 * The bank's own answer line for an asked relation.
 *
 * Read-only. It reuses the same profile and ranking as retrieval, then keeps
 * only keeper-grade, asserted relations whose kind the question names and
 * whose arrow the question does not reverse. It never reads model prose and
 * never joins identities: the names come from the relation row verbatim.
 *
 * When several keepers share the asked relation, the ranker's top proving
 * passage decides; if that passage itself carries more than one keeper line,
 * the result is `several` and the caller abstains.
 */
export interface BankAnswerResult {
  status: 'keeper' | 'attested' | 'none' | 'several';
  /** "From — kind To", bank names verbatim. */
  line?: string;
  quote?: string;
  locator?: string;
  reason?: string;
}

/**
 * Parse the frozen status-of question shape. Shared by the answer guard and
 * the bank answer line so both resolve the same pair.
 */
export function parseStatusPair(question: string): { a: string; b: string } | null {
  const noScope = question.replace(/\s+as\s+of\s+.*$/i, '').trim();
  const m = noScope.match(/status\s+of\s+(.+?)\s+to\s+(.+?)\s*$/i);
  if (!m) return null;
  const clean = (raw: string): string =>
    raw
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim()
      .replace(/[.,;:!?]+$/g, '')
      .trim();
  const a = clean(m[1]);
  const b = clean(m[2]);
  if (!a || !b) return null;
  return { a, b };
}

export interface PairKeeper {
  id: number;
  fromId: number;
  toId: number;
  fromName: string;
  toName: string;
  kind: string;
  evidence: string;
  modality: string;
  reviewStatus: string;
  /** True when a human confirmed the row directly. */
  confirmedByUser: boolean;
  /** Raw source_refs JSON; '[]' means the row carries no passage. */
  sourceRefs: string;
  locator?: string;
}

/**
 * One keeper lookup for an explicit pair. It returns every accepted or
 * user-confirmed row between the named sides, in either direction, keeping the
 * guard's existing "any accepted tie" semantics. The answer line filters this
 * to a plain relational keeper before rendering.
 *
 * Names resolve at query time through the match-time naming layer: an exact
 * stored name or alias, a derived variant, or the same person under
 * `nameRelation`. Nothing is merged, aliased or written; the rows keep their
 * own stored names.
 */
export function lookupKeeperPair(
  db: Db,
  projectId: number,
  a: string,
  b: string,
  statuses: readonly string[] = ['accepted', 'user_confirmed'],
): PairKeeper[] {
  const entities = listEntities(db, projectId);
  const roster = buildRosterIndex(
    entities.map((entity) => ({ name: entity.name, aliases: entity.aliases })),
    db.all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', projectId)
      .map((row) => row.text)
      .join(' '),
  );
  const exactIds = (name: string): number[] => {
    const q = (name ?? '').trim().toLowerCase();
    return entities
      .filter(
        (entity) =>
          entity.name.toLowerCase() === q ||
          entity.aliases.some((alias) => alias.toLowerCase() === q),
      )
      .map((entity) => entity.id);
  };
  // The same person may be stored as several rows. Only when the exact names
  // find no tie at all do we widen each side through the match-time naming
  // layer, so an exact query keeps resolving exactly as before.
  const wideIds = (name: string): number[] => {
    const query = (name ?? '').trim().toLowerCase();
    const canonical = canonicalName(name);
    const ids = new Set<number>(exactIds(name));
    for (const entity of entities) {
      if (ids.has(entity.id)) continue;
      if (!canonical) continue;
      const relation = nameRelation(name, entity.name);
      if (relation === 'same' || relation === 'containment') {
        ids.add(entity.id);
        continue;
      }
      if (deriveNameVariants({ name: entity.name, aliases: entity.aliases }, roster).includes(canonical)) {
        ids.add(entity.id);
      }
    }
    return [...ids];
  };
  const placeholders = (ids: number[]): string => ids.map(() => '?').join(',');
  const queryPair = (idsA: number[], idsB: number[]): {
    id: number;
    from_entity: number;
    to_entity: number;
    from_name: string;
    to_name: string;
    kind: string;
    evidence: string;
    modality: string | null;
    review_status: string | null;
    source_refs: string;
    confirmed_by_user: number | null;
  }[] => {
    if (!idsA.length || !idsB.length) return [];
    if (idsA.some((id) => idsB.includes(id))) return [];
    return db.all<{
      id: number;
      from_entity: number;
      to_entity: number;
      from_name: string;
      to_name: string;
      kind: string;
      evidence: string;
      modality: string | null;
      review_status: string | null;
      source_refs: string;
      confirmed_by_user: number | null;
    }>(
      // Citations read only the primary evidence. supporting_evidence is
      // display-only context and must never be quoted as proof.
      `SELECT r.id, r.from_entity, r.to_entity, a.name AS from_name, b.name AS to_name,
              r.kind, r.evidence, r.modality, r.review_status, r.source_refs, r.confirmed_by_user
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
       WHERE r.project_id = ?
         AND r.review_status IN (${statuses.map(() => '?').join(',')})
         AND ((r.from_entity IN (${placeholders(idsA)}) AND r.to_entity IN (${placeholders(idsB)}))
           OR (r.from_entity IN (${placeholders(idsB)}) AND r.to_entity IN (${placeholders(idsA)})))
       ORDER BY r.id`,
      projectId,
      ...statuses,
      ...idsA,
      ...idsB,
      ...idsB,
      ...idsA,
    );
  };
  let idsA = exactIds(a);
  let idsB = exactIds(b);
  let rows = queryPair(idsA, idsB);
  if (!rows.length) {
    idsA = wideIds(a);
    idsB = wideIds(b);
    rows = queryPair(idsA, idsB);
  }
  const chunkIds = rows.flatMap((row) =>
    fromJson<{ chunk?: unknown }[]>(row.source_refs, [])
      .map((ref) => Number(ref?.chunk))
      .filter((id) => Number.isFinite(id)),
  );
  const locators = new Map(
    (chunkIds.length
      ? db.all<{ id: number; locator: string }>(
          `SELECT id, locator FROM canon_chunk WHERE project_id = ?
           AND id IN (${[...new Set(chunkIds)].map(() => '?').join(',')})`,
          projectId,
          ...[...new Set(chunkIds)],
        )
      : []
    ).map((row) => [row.id, row.locator]),
  );
  return rows.map((row) => {
    const chunk = fromJson<{ chunk?: unknown }[]>(row.source_refs, [])
      .map((ref) => Number(ref?.chunk))
      .find((id) => Number.isFinite(id));
    return {
      id: row.id,
      fromId: row.from_entity,
      toId: row.to_entity,
      fromName: row.from_name,
      toName: row.to_name,
      kind: row.kind,
      evidence: row.evidence,
      modality: row.modality ?? 'asserted',
      reviewStatus: row.review_status ?? 'accepted',
      confirmedByUser: row.confirmed_by_user === 1,
      sourceRefs: row.source_refs ?? '[]',
      ...(chunk !== undefined && locators.has(chunk) ? { locator: locators.get(chunk)! } : {}),
    };
  });
}

/**
 * Passage-proof rows for an explicit pair: `attested` status only. Same
 * resolution as the keeper lookup, but the answer shows them distinctly —
 * quote plus passage scope, never as keeper-grade.
 */
export function lookupAttestedPair(
  db: Db,
  projectId: number,
  a: string,
  b: string,
): PairKeeper[] {
  return lookupKeeperPair(db, projectId, a, b, ['attested']);
}

export function bankAnswerForQuestion(
  db: Db,
  projectId: number,
  question: string,
  providedProfile?: BankQueryProfile,
): BankAnswerResult {
  const pair = parseStatusPair(question);
  if (pair) {
    const rows = lookupKeeperPair(db, projectId, pair.a, pair.b).filter(
      (row) =>
        canonicalName(row.kind) !== 'appears with' &&
        (row.modality ?? 'asserted') === 'asserted',
    );
    if (!rows.length) {
      // No keeper: an attested row may still be cited, distinctly — quote
      // plus passage scope, never keeper-grade.
      const attested = lookupAttestedPair(db, projectId, pair.a, pair.b).filter(
        (row) =>
          canonicalName(row.kind) !== 'appears with' &&
          (row.modality ?? 'asserted') === 'asserted',
      );
      if (!attested.length) {
        return { status: 'none', reason: 'The bank holds no keeper for this pair.' };
      }
      const cited = [...attested].sort((x, y) => x.id - y.id)[0]!;
      return {
        status: 'attested',
        line: `${cited.fromName} — ${cited.kind} ${cited.toName} (attested, not keeper-grade)`,
        quote: cited.evidence,
        ...(cited.locator ? { locator: cited.locator } : {}),
      };
    }
    // A human confirmation outranks a derived pick: answer from the confirmed
    // row itself, deterministically (lowest id), so the line matches what was
    // confirmed. With no confirmation the directed-status path is unchanged.
    const confirmed = rows
      .filter((candidate) => candidate.reviewStatus === 'user_confirmed' || candidate.confirmedByUser)
      .sort((x, y) => x.id - y.id);
    let row: (typeof rows)[number];
    if (confirmed.length) {
      row = confirmed[0]!;
    } else {
      const directed = directedPairStatus(db, projectId, rows[0]!.fromId, rows[0]!.toId);
      const currentId = directed.forward.current?.id ?? directed.reverse.current?.id;
      row = rows.find((candidate) => candidate.id === currentId) ?? rows[0]!;
    }
    return {
      status: 'keeper',
      line: `${row.fromName} — ${row.kind} ${row.toName}`,
      quote: row.evidence,
      ...(row.locator ? { locator: row.locator } : {}),
    };
  }

  const profile = providedProfile ?? buildBankProfile(db, projectId, question);
  if (!profile.named.size) {
    return { status: 'none', reason: 'No banked name matches this question.' };
  }
  if (!profile.bankActive) {
    return { status: 'none', reason: 'The question does not name a banked relation.' };
  }

  const rows = db.all<{
    id: number;
    from_id: number;
    to_id: number;
    from_name: string;
    to_name: string;
    kind: string;
    evidence: string;
    modality: string | null;
    review_status: string | null;
  }>(
    `SELECT r.id, r.from_entity AS from_id, r.to_entity AS to_id,
            a.name AS from_name, b.name AS to_name, r.kind, r.evidence, r.modality,
            r.review_status
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
     WHERE r.project_id = ?`,
    projectId,
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));

  const keepers: BankRelationRow[] = [];
  for (const relation of profile.relations) {
    if (relationTier(relation) !== 'keeper') continue;
    const shared = cueDirectionTouch(profile, relation);
    if (!shared.touches || shared.cueHits === 0) continue;
    if (shared.lean < 0) continue;
    const row = rowById.get(relation.id);
    if (!row || (row.modality ?? 'asserted') !== 'asserted') continue;
    keepers.push(relation);
  }
  if (!keepers.length) {
    return { status: 'none', reason: 'The bank holds no keeper for this relation.' };
  }

  // Score the keeper passages with the same bank ranker Ask uses.
  const chunkIds = [...new Set(keepers.flatMap((relation) => relation.chunks))];
  const chunkRows = chunkIds.length
    ? db.all<{ id: number; text: string; locator: string }>(
        `SELECT id, text, locator FROM canon_chunk
         WHERE project_id = ? AND id IN (${chunkIds.map(() => '?').join(',')})`,
        projectId,
        ...chunkIds,
      )
    : [];
  const textById = new Map(chunkRows.map((row) => [row.id, row.text]));
  const locatorById = new Map(chunkRows.map((row) => [row.id, row.locator]));
  const candidates: { chunkId: number; text: string; relationId: number; score?: number }[] = [];
  const seen = new Set<string>();
  for (const relation of keepers) {
    for (const chunkId of relation.chunks) {
      const key = `${relation.id}:${chunkId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ chunkId, text: textById.get(chunkId) ?? '', relationId: relation.id });
    }
  }
  if (!candidates.length) {
    return { status: 'none', reason: 'The keeper rows carry no proving passage.' };
  }

  // Match the lexical scores Ask gives these passages: only chunks inside the
  // normal candidate pool carry an FTS score; a bank-expanded keeper starts at
  // zero, exactly as it does in searchCanon.
  const match = profile.tokens
    .filter((token) => /^[a-z0-9']+$/.test(token))
    .map((token) => `"${token}"`)
    .join(' OR ');
  const lexical = new Map<number, number>();
  if (match) {
    try {
      const rows = db.all<{ id: number; rank: number }>(
        `SELECT c.id, bm25(canon_chunk_fts) AS rank
         FROM canon_chunk_fts
         JOIN canon_chunk c ON c.id = canon_chunk_fts.rowid
         WHERE canon_chunk_fts MATCH ? AND c.project_id = ?
         ORDER BY rank LIMIT ?`,
        match,
        projectId,
        SEARCH_CANDIDATE_POOL,
      );
      for (const row of rows) lexical.set(row.id, lexicalScore(Number(row.rank ?? 0)));
    } catch {
      // A malformed FTS query simply leaves the bank candidates unscored.
    }
  }
  for (const candidate of candidates) candidate.score = lexical.get(candidate.chunkId) ?? 0;
  // searchCanon sorts by this score before ranking; a bank-expanded keeper
  // (score 0) therefore sits ahead of a weak FTS hit with a negative score.
  candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const ranked = rankWithBank(db, projectId, question, candidates, profile);
  const top = ranked[0]!;
  const lines = new Set<string>();
  for (const candidate of ranked) {
    if (candidate.chunkId !== top.chunkId) continue;
    const row = rowById.get(candidate.relationId);
    if (row) lines.add(`${row.from_name} — ${row.kind} ${row.to_name}`);
  }
  if (lines.size !== 1) {
    return {
      status: 'several',
      reason: 'The top banked passage carries more than one keeper for this relation.',
    };
  }

  const row = rowById.get(top.relationId)!;
  // Reuse the same directed status the ties view uses: a superseded row is
  // not the current tie, even if it is still a keeper.
  const directed = directedPairStatus(db, projectId, row.from_id, row.to_id);
  if (directed.forward.current?.id !== top.relationId) {
    return { status: 'none', reason: 'The bank holds no current keeper for this relation.' };
  }
  const locator = locatorById.get(top.chunkId);
  return {
    status: 'keeper',
    line: `${row.from_name} — ${row.kind} ${row.to_name}`,
    quote: row.evidence,
    ...(locator ? { locator } : {}),
  };
}

/**
 * The bank's own endpoint rule, reused by the relabel pass: a quote banks
 * a tie only when it names at least one endpoint. A nobody-named quote
 * stays pending no matter how suggestive the scene.
 */
export function quoteNamesEndpoint(
  db: Db,
  projectId: number,
  fromId: number,
  toId: number,
  quote: string,
): boolean {
  const roster = rosterTokens(db, projectId);
  const words = proofTokens(quote, 3);
  if (!words.size) return false;
  return [fromId, toId].some((id) => [...(roster.get(id) ?? [])].some((t) => words.has(t)));
}

/** True when the quote names a recognizable form of both endpoints. */
export function quoteNamesBothEndpoints(
  db: Db,
  projectId: number,
  fromId: number,
  toId: number,
  quote: string,
): boolean {
  const roster = rosterTokens(db, projectId);
  const words = proofTokens(quote, 3);
  if (!words.size) return false;
  return [fromId, toId].every((id) =>
    [...(roster.get(id) ?? [])].some((t) => words.has(t)),
  );
}

/**
 * True when the quote names a third roster person beyond the pair — the
 * Kim-assistant shape: the quote proves Pax Teem + Aks Moe, not Pax Teem +
 * Kim. Single-endpoint-plus-outsider must not bank as accepted.
 */
export function quoteNamesThirdParty(
  db: Db,
  projectId: number,
  fromId: number,
  toId: number,
  quote: string,
): boolean {
  const roster = rosterTokens(db, projectId);
  const words = proofTokens(quote, 3);
  if (!words.size) return false;
  for (const [id, toks] of roster) {
    if (id === fromId || id === toId) continue;
    for (const t of toks) {
      if (words.has(t)) return true;
    }
  }
  return false;
}

/**
 * Bank a happening as an event. Moments fail as ties but truly happened, so
 * the occurrence is kept where happenings live: the event index, both
 * people attached, the same proving quote. Deterministic, no model.
 * Reruns collide on title-plus-chunk and add nothing.
 */
function bankMomentEvent(
  db: Db,
  projectId: number,
  fromId: number,
  toId: number,
  kind: string,
  description: string,
  span: { quote: string; chunkId: number | null; source: string; locator: string },
  chunk: ChunkRow | undefined,
): void {
  const names = new Map<number, string>();
  for (const row of db.all<{ id: number; name: string }>(
    'SELECT id, name FROM canon_entity WHERE project_id = ? AND id IN (?, ?)',
    projectId,
    fromId,
    toId,
  )) {
    names.set(row.id, row.name);
  }
  const fromName = names.get(fromId) ?? '';
  const toName = names.get(toId) ?? '';
  if (!fromName || !toName) return;
  let sourceId: number | null = null;
  let chunkId: number | null = null;
  let locator = span.locator;
  let seq = chunk?.seq ?? 0;
  if (span.chunkId !== null) {
    const row = db.get<{ id: number; source_id: number; locator: string; seq: number }>(
      'SELECT id, source_id, locator, seq FROM canon_chunk WHERE id = ?',
      span.chunkId,
    );
    if (row) {
      chunkId = row.id;
      sourceId = row.source_id;
      locator = row.locator;
      seq = row.seq;
    }
  } else if (chunk) {
    const row = db.get<{ id: number; source_id: number }>(
      'SELECT id, source_id FROM canon_chunk WHERE project_id = ? AND seq = ? LIMIT 1',
      projectId,
      chunk.seq,
    );
    if (row) {
      chunkId = row.id;
      sourceId = row.source_id;
    }
    locator = chunk.locator;
  }
  const title = `${fromName} ${kind} ${toName}`;
  const dup = db.get<{ id: number }>(
    'SELECT id FROM canon_event WHERE project_id = ? AND title = ? AND (chunk_id IS ? OR chunk_id = ?)',
    projectId,
    title,
    chunkId,
    chunkId ?? -1,
  );
  if (dup) return;
  db.run(
    `INSERT INTO canon_event (project_id, source_id, chunk_id, locator, title, summary, participants, location, time_label, kind, quote, seq, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '', '', 'event', ?, ?, ?)`,
    projectId,
    sourceId,
    chunkId,
    locator,
    title,
    description,
    toJson([fromName, toName]),
    span.quote,
    seq,
    nowIso(),
  );
}

/** Strict-mode kind mapping: a closed kind wins, otherwise the first one stays. */
export function strictRelationKind(kind: string): string {
  const parts = normaliseKinds(kind);
  return parts.find((part) => isClosedRoleKind(part)) ?? parts[0] ?? 'related to';
}

/** How many narrow quote re-asks one window may spend. */
export const MAX_RELATION_RETRIES_PER_WINDOW = 5;

interface RelationEndpoint {
  id: number;
  name: string;
  aliases: string;
}

function endpointNamed(endpoint: RelationEndpoint, text: string): boolean {
  return (
    nameMentionedExact(endpoint.name, text) ||
    strList(endpoint.aliases).some((alias) => nameMentionedExact(alias, text))
  );
}

function quoteNamesBothEntities(
  from: RelationEndpoint,
  to: RelationEndpoint,
  quote: string,
): boolean {
  return endpointNamed(from, quote) && endpointNamed(to, quote);
}

/** True when the text is one sentence of the passage, not a paraphrase. */
function sentenceFromPassage(passage: string, sentence: string): boolean {
  const needle = normalise(sentence);
  if (!needle || needle.length < 8) return false;
  if (!normalise(passage).includes(needle)) return false;
  return splitSentences(passage).some((candidate) => normalise(candidate).includes(needle));
}

async function askRelationSentence(
  llm: LlmClient,
  passage: string,
  fromName: string,
  toName: string,
  kind: string,
): Promise<string | null> {
  try {
    const res = await llm.chat({
      system: EXTRACT_RELATIONS_RETRY_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `PAIR: ${fromName} — ${kind || 'related to'} — ${toName}\n\nPASSAGE:\n${passage}`,
        },
      ],
      temperature: 0,
      maxTokens: 200,
    });
    const text = (res.text ?? '').trim();
    if (!text) return null;
    let sentence = '';
    try {
      const body = text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as {
        quote?: unknown;
      };
      sentence = String(parsed.quote ?? '').trim();
    } catch {
      sentence = text;
    }
    if (!sentence || /^none$/i.test(sentence)) return null;
    return sentence;
  } catch {
    return null;
  }
}

/**
 * Strict mode only: re-ask once for relations whose quote names fewer than
 * both endpoints, then keep the repaired sentence only when it is verbatim
 * from the cited passage and names both. Unresolved endpoints are skipped —
 * they already become hints. At most five calls per window.
 */
async function retryRelationQuotes(
  db: Db,
  llm: LlmClient,
  projectId: number,
  window: ChunkRow[],
  raws: Record<string, unknown>[],
  entityIdByName: Map<string, number>,
  stats: ExtractLoreResult,
): Promise<void> {
  let used = 0;
  for (const raw of raws) {
    if (used >= MAX_RELATION_RETRIES_PER_WINDOW) break;
    const fromName = String(raw.from ?? '').trim();
    const toName = String(raw.to ?? '').trim();
    const fromId = resolveEntity(db, projectId, entityIdByName, fromName);
    const toId = resolveEntity(db, projectId, entityIdByName, toName);
    if (!fromId || !toId || fromId === toId) continue;
    const chunk = chunkAt(window, raw.chunk_index);
    const passage = chunk?.text ?? window.map((c) => c.text).join('\n\n');
    if (!passage.trim()) continue;
    const from = db.get<{ name: string; aliases: string }>(
      'SELECT name, aliases FROM canon_entity WHERE project_id = ? AND id = ?',
      projectId,
      fromId,
    );
    const to = db.get<{ name: string; aliases: string }>(
      'SELECT name, aliases FROM canon_entity WHERE project_id = ? AND id = ?',
      projectId,
      toId,
    );
    if (!from || !to) continue;
    const endpoints = {
      from: { id: fromId, name: from.name, aliases: from.aliases },
      to: { id: toId, name: to.name, aliases: to.aliases },
    };
    if (quoteNamesBothEntities(endpoints.from, endpoints.to, String(raw.evidence ?? ''))) continue;
    used++;
    stats.verification.retried++;
    const sentence = await askRelationSentence(llm, passage, from.name, to.name, String(raw.kind ?? ''));
    if (
      sentence &&
      sentenceFromPassage(passage, sentence) &&
      quoteNamesBothEntities(endpoints.from, endpoints.to, sentence)
    ) {
      raw.evidence = sentence;
      stats.verification.retriedFixed++;
    } else {
      stats.verification.retriedFailed++;
    }
  }
}

/** Write the relation section. Returns how many claims were accepted. */
function applyRelations(
  db: Db,
  projectId: number,
  raws: Record<string, unknown>[],
  window: ChunkRow[],
  entityIdByName: Map<string, number>,
  stats: ExtractLoreResult,
  neighboursOf: (id: number | undefined) => ChunkRow[],
  gate: boolean,
  index?: RosterIndex,
): number {
  let accepted = 0;
  const minConfidence = projectMinConfidence(db, projectId);
  for (const raw of raws) {
    const fromName = String(raw.from ?? '').trim();
    const toName = String(raw.to ?? '').trim();
    const fromId = resolveEntity(db, projectId, entityIdByName, fromName);
    const toId = resolveEntity(db, projectId, entityIdByName, toName);
    if (!fromId || !toId || fromId === toId) {
      // A relation naming someone the bank has never seen is a recall hole,
      // not noise: keep the names, kind and quote as a hint. No entity is
      // created and nothing is promoted to a relation. Same-person claims are
      // refused by the mechanical identity check.
      if (gate) stats.verification.unresolved++;
      if (!fromId || !toId) {
        const chunk = chunkAt(window, raw.chunk_index);
        let quote = '';
        let refs: { source: string; locator: string; chunk?: number }[] = [];
        if (chunk) {
          const hintSpan = gate
            ? verifySpan(raw.evidence, chunk, neighboursOf(chunk.id))
            : { ...verifyQuote(raw.evidence, chunk, neighboursOf(chunk.id)), status: 'verified' as const };
          if (hintSpan.quote.trim()) {
            quote = hintSpan.quote;
            refs = hintSpan.chunkId !== null
              ? [{ source: hintSpan.source, locator: hintSpan.locator, chunk: hintSpan.chunkId }]
              : refsFor(chunk);
          }
        } else {
          quote = String(raw.evidence ?? '').trim();
        }
        const rawKind = String(raw.kind ?? '').trim();
        let captured = false;
        if (quote && rawKind && /[a-z]/i.test(rawKind)) {
          for (const kind of normaliseKinds(rawKind)) {
            if (captureTieHint(db, projectId, { fromName, toName, kind, quote, refs })) captured = true;
          }
        }
        if (captured) stats.verification.hinted++;
      }
      continue;
    }
    const kinds = normaliseKinds(String(raw.kind ?? ''));
    const chunk = chunkAt(window, raw.chunk_index);
    const span = spanFor(raw.evidence, chunk, neighboursOf(chunk?.id), gate, stats.verification);
    const refs = span.status !== 'dropped' && span.chunkId !== null
      ? [{ source: span.source, locator: span.locator, chunk: span.chunkId }]
      : refsFor(chunk);
    const passageText = span.status !== 'dropped' && span.chunkId !== null
      ? pageEvidenceText(db, span.chunkId) ??
        db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', span.chunkId)?.text ??
        chunk?.text ??
        ''
      : chunk?.text ?? '';

    // Check 1: the quote must exist in the cited passage. A fabrication is a
    // case file, never a row.
    const quoteVerbatim =
      span.status !== 'dropped' &&
      span.quote.trim().length > 0 &&
      passageText.length > 0 &&
      normalise(passageText).includes(normalise(span.quote));
    if (!quoteVerbatim) {
      stats.verification.unsupported++;
      persistTieNote(
        db,
        projectId,
        fromId,
        toId,
        kinds[0] ?? 'related to',
        'unsupported-citation',
        String(raw.evidence ?? '').trim(),
        toJson(refs),
      );
      continue;
    }

    // Check 1 also covers the anchor: it is part of the citation.
    const anchorRaw = String(raw.anchor ?? '').trim();
    const anchorVerbatim =
      anchorRaw.length > 0 && passageText.length > 0 && normalise(passageText).includes(normalise(anchorRaw));
    if (anchorRaw && !anchorVerbatim) {
      stats.verification.unsupported++;
      persistTieNote(db, projectId, fromId, toId, kinds[0] ?? 'related to', 'unsupported-citation', anchorRaw, toJson(refs));
      continue;
    }
    const anchorEvidence = anchorVerbatim ? anchorRaw : '';

    // The model's own judgement, recorded as provenance. The confidence alone
    // decides the tier; none of the assessment fields are a grammar gate.
    const assessment = readClaimAssessment(raw);
    const confidence = assessment.strength;
    const supporting = assessmentSupporting(assessment);
    const rowReview = claimTier(confidence, minConfidence);
    if (rowReview === 'provisional') stats.provisional++;

    const kindSourceRaw = String(raw.kind_source ?? '').trim();
    const kindSource =
      kindSourceRaw &&
      (normalise(span.quote).includes(normalise(kindSourceRaw)) ||
        (anchorEvidence.length > 0 && normalise(anchorEvidence).includes(normalise(kindSourceRaw))))
        ? kindSourceRaw
        : '';

    for (const kind of kinds) {
      // Moments are not ties: the happening banks as an event with both people
      // attached, and the tie question stays in the queue. Routed before the
      // citation check so a denied moment still reaches the event index.
      if (isMomentKind(kind)) {
        stats.verification.moment++;
        bankMomentEvent(db, projectId, fromId, toId, kind, String(raw.description ?? '').trim(), span, chunk);
        persistTieNote(db, projectId, fromId, toId, kind, 'moment', span.quote, toJson(refs), '', kindSource);
        continue;
      }
      // Citation honesty: a quoted sub-span may not hide a hedge or denial in
      // the sentence that holds it. This is the only grammatical check left,
      // and it protects the source, not a theory of relationships.
      const citationReason = provenQuoteReason(
        { fromId, toId, fromName, toName, kind, evidence: span.quote, kindSource, anchorEvidence },
        passageText,
        index,
      );
      if (citationReason) {
        stats.verification.unsupported++;
        persistTieNote(db, projectId, fromId, toId, kind, 'unsupported-citation', span.quote, toJson(refs), '', kindSource);
        continue;
      }
      // A generic kinship word repeats a specific one: "parent of" beside
      // "father of" says nothing new. Pure dedupe, not a meaning judgment.
      const lk = kind.toLowerCase();
      const specifics = GENERIC_KINSHIP.get(lk);
      if (specifics) {
        const dup = db.get<{ id: number }>(
          `SELECT id FROM canon_relation WHERE project_id = ? AND lower(kind) IN (${[...specifics].map(() => '?').join(',')})
             AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?)) LIMIT 1`,
          projectId,
          ...[...specifics].map((s) => s.toLowerCase()),
          fromId,
          toId,
          toId,
          fromId,
        );
        if (dup) {
          stats.verification.redundant++;
          continue;
        }
      } else {
        for (const [generic, genericKinds] of GENERIC_KINSHIP) {
          if (!genericKinds.has(lk)) continue;
          const stale = db.all<{ id: number }>(
            'SELECT id FROM canon_relation WHERE project_id = ? AND lower(kind) = ? AND review_status != ? AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?))',
            projectId,
            generic,
            'user_confirmed',
            fromId,
            toId,
            toId,
            fromId,
          );
          if (stale.length) {
            for (const row of stale) db.run('DELETE FROM canon_relation WHERE id = ?', row.id);
            stats.verification.redundant += stale.length;
          }
          break;
        }
      }
      // The same claim in two words: one pair, one quote, one head verb.
      const headWord = (k: string): string => {
        const stop = new Set(['a', 'an', 'the', 'to', 'of', 'with', 'by', 'for', 'in', 'on', 'at']);
        return k.toLowerCase().split(/[^a-z]+/).filter((w) => w && !stop.has(w))[0] ?? '';
      };
      const rivals = db.all<{
        id: number;
        kind: string;
        description: string;
        evidence: string;
        source_refs: string;
        review_status: string;
        confidence: number;
        supporting_evidence: string;
      }>(
        `SELECT id, kind, description, evidence, source_refs, review_status, confidence, supporting_evidence
           FROM canon_relation
          WHERE project_id = ? AND evidence = ? AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?))
          ORDER BY id`,
        projectId,
        span.quote,
        fromId,
        toId,
        toId,
        fromId,
      );
      const twin = rivals.find((r) => headWord(r.kind) === headWord(kind) && headWord(kind).length > 0);
      if (twin) {
        const description = String(raw.description ?? '').trim();
        const sentence = description.length > twin.description.length ? description : twin.description;
        const quote = span.quote.length > twin.evidence.length ? span.quote : twin.evidence;
        const sourceRefs = earliestRefs(db, toJson(refs), twin.source_refs);
        const twinReview = maxTrust(rowReview, twin.review_status);
        const twinConfidence = Math.max(Number(twin.confidence) || 0, confidence);
        db.transaction(() => {
          db.run(
            `UPDATE canon_relation
                SET kind = ?, description = ?, evidence = ?, source_refs = ?, review_status = ?,
                    confidence = ?, supporting_evidence = ?,
                    kind_source = CASE WHEN ? <> '' THEN ? ELSE kind_source END,
                    anchor_evidence = CASE WHEN ? <> '' THEN ? ELSE anchor_evidence END
              WHERE id = ?`,
            twin.kind,
            sentence,
            quote,
            sourceRefs,
            twinReview,
            twinConfidence,
            appendAssessment(twin.supporting_evidence, assessment),
            kindSource,
            kindSource,
            anchorEvidence,
            anchorEvidence,
            twin.id,
          );
          if (twinReview !== twin.review_status) {
            recordRuling(db, projectId, {
              relationId: twin.id,
              role: 'appeal',
              actor: 'guard',
              standard: 'merge',
              fromStatus: twin.review_status,
              toStatus: twinReview,
              basis: 'same quote merged into the rival claim',
              quote,
            });
          }
        });
        accepted++;
        continue;
      }
      const existing = db.get<{
        id: number;
        kind: string;
        description: string;
        evidence: string;
        source_refs: string;
        review_status: string;
        confidence: number;
        supporting_evidence: string;
      }>(
        `SELECT id, kind, description, evidence, source_refs, review_status, confidence, supporting_evidence
           FROM canon_relation
          WHERE project_id = ? AND lower(kind) = ?
            AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?))
          ORDER BY id LIMIT 1`,
        projectId,
        kind.toLowerCase(),
        fromId,
        toId,
        toId,
        fromId,
      );
      if (existing) {
        // One relation per pair and label, whichever side named it: merge
        // rather than bank the same tie twice in opposite directions.
        const description = String(raw.description ?? '').trim();
        const sentence = description.length > existing.description.length ? description : existing.description;
        const quote = span.quote.length > existing.evidence.length ? span.quote : existing.evidence;
        const sourceRefs = earliestRefs(db, toJson(refs), existing.source_refs);
        const mergedReview = maxTrust(rowReview, existing.review_status);
        const mergedConfidence = Math.max(Number(existing.confidence) || 0, confidence);
        db.transaction(() => {
          db.run(
            `UPDATE canon_relation
                SET description = ?, evidence = ?, source_refs = ?, review_status = ?,
                    confidence = ?, supporting_evidence = ?,
                    kind_source = CASE WHEN ? <> '' THEN ? ELSE kind_source END,
                    anchor_evidence = CASE WHEN ? <> '' THEN ? ELSE anchor_evidence END
              WHERE id = ?`,
            sentence,
            quote,
            sourceRefs,
            mergedReview,
            mergedConfidence,
            appendAssessment(existing.supporting_evidence, assessment),
            kindSource,
            kindSource,
            anchorEvidence,
            anchorEvidence,
            existing.id,
          );
          if (mergedReview !== existing.review_status) {
            recordRuling(db, projectId, {
              relationId: existing.id,
              role: 'appeal',
              actor: 'guard',
              standard: 'merge',
              fromStatus: existing.review_status,
              toStatus: mergedReview,
              basis: 'duplicate claim merged',
              quote,
            });
          }
        });
        accepted++;
        continue;
      }
      insertRelation(db, projectId, {
        fromEntity: fromId,
        toEntity: toId,
        kind,
        description: String(raw.description ?? '').trim(),
        evidence: span.quote,
        sourceRefs: toJson(refs),
        kindSource,
        anchorEvidence,
        modality: normaliseModality(raw.modality),
        reviewStatus: rowReview,
        confidence,
        supportingEvidence: supporting,
      });
      stats.relations++;
      accepted++;
    }
  }
  return accepted;
}

/** Write the timeline section. Returns how many claims were accepted. */
function applyTimeline(
  db: Db,
  projectId: number,
  raws: Record<string, unknown>[],
  window: ChunkRow[],
  stats: ExtractLoreResult,
  neighboursOf: (id: number | undefined) => ChunkRow[],
  gate: boolean,
): number {
  let accepted = 0;
  for (const raw of raws) {
    const title = String(raw.title ?? '').trim();
    if (!title) continue;
    const chunk = chunkAt(window, raw.chunk_index);
    const span = spanFor(raw.evidence, chunk, neighboursOf(chunk?.id), gate, stats.verification);
    if (span.status === 'dropped') continue;
    const dup = db.get<{ id: number }>('SELECT id FROM canon_timeline WHERE project_id = ? AND title = ?', projectId, title);
    if (dup) {
      accepted++;
      continue;
    }
    const refs = span.chunkId !== null
      ? [{ source: span.source, locator: span.locator, chunk: span.chunkId }]
      : refsFor(chunk);
    const seq = db.get<{ n: number | null }>('SELECT MAX(seq) AS n FROM canon_timeline WHERE project_id = ?', projectId);
    db.run(
      `INSERT INTO canon_timeline (project_id, canon_event, seq, title, summary, time_label, participants, location, evidence, source_refs, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      (seq?.n ?? 0) + 1,
      title,
      String(raw.summary ?? '').trim(),
      String(raw.when ?? '').trim(),
      toJson(toStringArray(raw.participants)),
      String(raw.location ?? '').trim(),
      span.quote,
      toJson(refs),
      nowIso(),
    );
    stats.timeline++;
    accepted++;
  }
  return accepted;
}

/**
 * The pre-Phase-1 window: one prompt for entities, relations, facts and
 * timeline. Kept as the rollback path while the split extractor is validated.
 */
async function extractWindowLegacy(
  db: Db,
  llm: LlmClient,
  projectId: number,
  window: ChunkRow[],
  entityIdByName: Map<string, number>,
  stats: ExtractLoreResult,
  neighboursOf: (id: number | undefined) => ChunkRow[] = () => [],
  maxTokens = 3000,
  nameIndex?: RosterIndex,
): Promise<void> {
  let parsed: {
    entities: Record<string, unknown>[];
    relations: Record<string, unknown>[];
    facts: Record<string, unknown>[];
    timeline: Record<string, unknown>[];
  } = { entities: [], relations: [], facts: [], timeline: [] };
  try {
    const res = await llm.chat({
      system: EXTRACT_SYSTEM,
      messages: [{ role: 'user', content: passageBlock(window) }],
      temperature: 0.1,
      maxTokens,
    });
    parsed = parseExtraction(res.text);
  } catch {
    return; // a bad window should not abort the whole extraction
  }

  applyEntities(db, projectId, parsed.entities, window, entityIdByName, stats, neighboursOf, false);
  applyRelations(db, projectId, parsed.relations, window, entityIdByName, stats, neighboursOf, false, nameIndex);
  applyFacts(db, projectId, parsed.facts, window, stats, neighboursOf, false);
  applyTimeline(db, projectId, parsed.timeline, window, stats, neighboursOf, false);
  stats.passages += window.length;
}

/**
 * One window, three small calls: entities and facts, then relations between
 * the names that exist, then the events. Each answer is gated against the
 * source before anything is written.
 */
async function extractWindowSplit(
  db: Db,
  llm: LlmClient,
  projectId: number,
  window: ChunkRow[],
  entityIdByName: Map<string, number>,
  stats: ExtractLoreResult,
  neighboursOf: (id: number | undefined) => ChunkRow[],
  maxTokens: number,
  index: number,
  roster?: NameRoster,
  nameIndex?: RosterIndex,
): Promise<void> {
  const passages = passageBlock(window);
  const answers: string[] = [];
  let failed = false;

  const ask = async (system: string, maxTok: number, temp = 0.1): Promise<string | null> => {
    try {
      const res = await llm.chat({
        system,
        messages: [{ role: 'user', content: passages }],
        temperature: temp,
        maxTokens: maxTok,
      });
      answers.push(res.text);
      return res.text;
    } catch {
      failed = true;
      return null;
    }
  };

  let accepted = 0;
  let parsedClaims = 0;

  // (a) The things the passages establish, and the facts they state.
  const first = await ask(EXTRACT_ENTITIES_SYSTEM, Math.min(1600, maxTokens));
  if (first !== null) {
    const entities = parseSection(first, 'entities');
    const facts = parseSection(first, 'facts');
    parsedClaims += entities.length + facts.length;
    accepted += applyEntities(db, projectId, entities, window, entityIdByName, stats, neighboursOf, true);
    accepted += applyFacts(db, projectId, facts, window, stats, neighboursOf, true);
  }

  // (b) Relationships between names that already exist. Names go in the
  //     system prompt, so the model cannot quietly widen the cast.
  const names = process.env.FANFABLE_REL_ROSTER === '1' && roster
    ? windowRosterNames(window, roster)
    : windowEntityNames(db, projectId, window, roster);
  if (names.length) {
    const system = `${relationsSystemPrompt()}\n\nKNOWN ENTITIES:\n${names.map((n) => `- ${n}`).join('\n')}`;
    const second = await ask(system, Math.min(3000, maxTokens), 0);
    if (second !== null) {
      let relations = parseSection(second, 'relations');
      if (strictRelationsEnabled()) {
        relations = relations.map((raw) => ({
          ...raw,
          kind: strictRelationKind(String(raw.kind ?? '')),
        }));
        await retryRelationQuotes(db, llm, projectId, window, relations, entityIdByName, stats);
      }
      parsedClaims += relations.length;
      accepted += applyRelations(db, projectId, relations, window, entityIdByName, stats, neighboursOf, true, nameIndex);
    }
  }

  // (c) What happens, in order.
  const third = await ask(EXTRACT_EVENTS_SYSTEM, Math.min(1200, maxTokens));
  if (third !== null) {
    const timeline = parseSection(third, 'timeline');
    parsedClaims += timeline.length;
    accepted += applyTimeline(db, projectId, timeline, window, stats, neighboursOf, true);
  }

  stats.passages += window.length;
  if (accepted > 0) return;

  // A window that wrote nothing must say why. A well-formed answer with empty
  // arrays is an empty window, not a truncation: only an answer that carries
  // claims but parses to nothing (cut off mid-array) is truncated.
  const hasContent = answers.some((t) => !answerIsEmpty(t));
  const reason: EmptyWindowReport['reason'] = failed
    ? 'error'
    : answers.length === 0
      ? 'error'
      : parsedClaims > 0
        ? 'gate-dropped'
        : hasContent
          ? 'truncated-answer'
          : 'empty-answer';
  stats.emptyWindows.push({
    index,
    locator: window[0]?.locator ?? '',
    reason,
    detail: failed ? 'a model call failed' : `parsed ${parsedClaims} claims, wrote 0 rows`,
  });
}

/** Is an extraction answer well-formed but empty (all arrays empty)? */
function answerIsEmpty(text: string): boolean {
  const stripped = (text ?? '').replace(/```/g, '').replace(/^json/i, '').trim();
  if (stripped === '{}' || stripped === '') return true;
  try {
    const value = JSON.parse(stripped) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.values(value as Record<string, unknown>);
      return entries.length > 0 && entries.every((v) => Array.isArray(v) && v.length === 0);
    }
  } catch {
    /* not JSON at all: it carries something, or it is cut off */
  }
  return false;
}

/**
 * Keep an evidence quote only if it really appears in the source.
 *
 * Models paraphrase when they are asked for a quote, and they often quote a
 * neighbouring passage while citing the current one. Both are recoverable:
 * a quote that is not in the cited passage is looked for in the passages
 * around it, and the reference is corrected to where it actually is.
 *
 * A quote that appears nowhere is dropped: a fabricated citation is worse
 * than no citation.
 */
function verifyQuote(
  raw: unknown,
  chunk: ChunkRow | undefined,
  neighbours: ChunkRow[] = [],
): { quote: string; chunkId: number | null; source: string; locator: string } {
  const text = String(raw ?? '').trim();
  const empty = { quote: '', chunkId: chunk?.id ?? null, source: chunk?.source_title ?? '', locator: chunk?.locator ?? '' };
  if (!text || !chunk) return empty;

  const needle = normalise(text);
  if (!needle) return empty;

  const search = (target: ChunkRow | undefined): boolean => {
    if (!target) return false;
    return normalise(target.text).includes(needle);
  };

  if (search(chunk)) {
    return { quote: text, chunkId: chunk.id, source: chunk.source_title, locator: chunk.locator };
  }
  // The model may have added a prefix or a trailing full stop.
  const words = needle.split(' ').slice(0, 6).join(' ');
  if (words.length > 8) {
    const partial = (target: ChunkRow | undefined): boolean => {
      if (!target) return false;
      return normalise(target.text).includes(words);
    };
    if (partial(chunk)) {
      return { quote: text, chunkId: chunk.id, source: chunk.source_title, locator: chunk.locator };
    }
    // Look in the passages around the cited one.
    for (const candidate of neighbours) {
      if (candidate.id === chunk.id) continue;
      if (partial(candidate)) {
        return {
          quote: text,
          chunkId: candidate.id,
          source: candidate.source_title,
          locator: candidate.locator,
        };
      }
    }
  }
  return empty;
}

/** Normalise a string for comparison: letters and digits, single spaces. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A character name that is a description, not a proper name.
 *
 * "The Potters' son" describes a person instead of naming one. Banking it
 * as a new entity splits one person into two and invents relations like
 * "Harry Potter is the brother of The Potters' son". Proper names pass;
 * determiner + possessive + kinship phrases ("the ...'s son/daughter/child")
 * do not. "The Bloody Baron" passes: no possessive, no kinship ending.
 */
export function isDescriptiveCharacterName(raw: string): boolean {
  const lower = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!/^(the|a|an)\s+.+/.test(lower)) return false;
  if (!lower.includes("'s") && !lower.includes("s'")) return false;
  const last = lower.split(' ').pop() ?? '';
  return (
    'sibling brother sister mother father son daughter parent child aunt uncle cousin nephew niece husband wife spouse grandmother grandfather grandson granddaughter boy girl man woman family kin'.split(
      ' ',
    ).includes(last)
  );
}

/**
 * A character name joining two people with "and".
 *
 * "Lily and James Potter" is two entries, never one entity. Banking it as
 * one person invents ties no one holds. No proper person name contains
 * " and ", so anything matching is a conjunction to split, not a name.
 */
export function isConjoinedCharacterName(raw: string): boolean {
  return /\band\b/i.test(String(raw ?? '').trim());
}

/**
 * A family group banked as a character.
 *
 * "the Potters" names a household, not a person. Proper people are not
 * "the" plus a plural. "The Bloody Baron" passes: singular ending, no
 * plural. Groups belong to factions, never to characters.
 */
export function isGroupCharacterName(raw: string): boolean {
  const lower = String(raw ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!/^(the|a|an)\s+.+/.test(lower)) return false;
  if (lower.includes("'s") || lower.includes("s'")) return false;
  return /s$/.test(lower);
}

const SPEAKER_VERBS =
  'said|asked|replied|answered|whispered|shouted|cried|muttered|added|continued|repeated|snapped|murmured|yelled|called';

/** The names used as dialogue speakers in a passage, lowercased. */
export function speakersIn(text: string): string[] {
  const out: string[] = [];
  const before = new RegExp(`(?:^|[.!?\\n]\\s*)([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})\\s+(?:${SPEAKER_VERBS})\\b`, 'g');
  const after = new RegExp(`\\b(?:${SPEAKER_VERBS})\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,2})`, 'g');
  for (const re of [before, after]) {
    for (const match of text.matchAll(re)) {
      const name = canonicalName(match[1] ?? '');
      if (name) out.push(name);
    }
  }
  return out;
}

/**
 * Which passages each entity speaks in.
 *
 * Two names that speak in the same passage are two different people, even if
 * one looks like a shorter version of the other: that is the veto the alias
 * merge needs.
 */
export function speakerChunksByEntity(db: Db, projectId: number): Map<number, Set<number>> {
  const byEntity = new Map<number, Set<number>>();
  const entities = listEntities(db, projectId).map((e) => ({
    id: e.id,
    variants: [e.name, ...e.aliases].map(nameTokens).filter((t) => t.length),
  }));
  const chunks = db.all<{ id: number; text: string }>('SELECT id, text FROM canon_chunk WHERE project_id = ?', projectId);
  for (const chunk of chunks) {
    const tags = speakersIn(chunk.text);
    if (!tags.length) continue;
    for (const tag of tags) {
      const tagTokens = tag.split(' ').filter(Boolean);
      for (const entity of entities) {
        const hit = entity.variants.some(
          (v) =>
            v.join(' ') === tag ||
            tagTokens.every((t) => v.includes(t)),
        );
        if (!hit) continue;
        const set = byEntity.get(entity.id) ?? new Set<number>();
        set.add(chunk.id);
        byEntity.set(entity.id, set);
      }
    }
  }
  return byEntity;
}

/** Was the same passage a scene two different people spoke in? */
export function sharedSpeakerScene(
  speakers: Map<number, Set<number>>,
  a: number,
  b: number,
): boolean {
  const sa = speakers.get(a);
  const sb = speakers.get(b);
  if (!sa || !sb) return false;
  const [small, large] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
  for (const id of small) if (large.has(id)) return true;
  return false;
}

/** Closed vocabulary for the notes relabeling pass. Universal kin and role
 * words only — never book-specific. Per-book growth happens solely through
 * the human review queue, never by model invention. */
export const CLOSED_TIE_LABELS = [
  'sister of', 'brother of', 'sibling of', 'mother of', 'father of', 'parent of',
  'son of', 'daughter of', 'child of', 'husband of', 'wife of', 'spouse of',
  'uncle of', 'aunt of', 'nephew of', 'niece of', 'cousin of',
  'relative of', 'friend of', 'enemy of', 'ally of', 'teacher of', 'student of',
  'mentor of', 'leader of', 'member of', 'peer of', 'colleague of',
];

/** Closed concept list for bankable tie kinds: the allow-list the prompt and the
 * guard share. Universal kin, titled roles, the human-gated peer/colleague set,
 * and the affect family. Anything outside it parks as needs_review with reason
 * open-vocab — never banks accepted. */
export const CLOSED_ROLE_KINDS = [
  ...CLOSED_TIE_LABELS,
  'aide of', 'apprentice of', 'master of', 'operative for', 'partner',
  'guardian of', 'employer of', 'customer of', 'owner of',
  'rival of', 'acquaintance',
  'disliked', 'resented', 'feared', 'admired', 'trusted', 'distrusted',
  'bullied', 'protective of', 'jealous of', 'loyal to', 'obeyed',
];

/** Whether a concept is asserted from one side or is the same claim in either
 * order. This is data on the concept, not a special case in the matcher. */
export type KindDirection = 'directional' | 'symmetric';

/**
 * One description per concept: what it is, and how it differs from its nearest
 * neighbour. The model maps a passage's wording onto one of these; no code lists
 * the English words that express it. Direction says whether a reversed claim is
 * refused or is the same claim stored once.
 */
export const KIND_GLOSSES: Readonly<Record<string, { says: string; direction: KindDirection }>> = {
  'sister of': {
    says: 'Is a female sibling of the other person; differs from sibling of in naming the sex, and from cousin of in sharing a parent.',
    direction: 'directional',
  },
  'brother of': {
    says: 'Is a male sibling of the other person; differs from sibling of in naming the sex, and from cousin of in sharing a parent.',
    direction: 'directional',
  },
  'sibling of': {
    says: 'Shares at least one parent with the other person; differs from cousin of in closeness of blood, and from relative of in being a parent\'s child.',
    direction: 'symmetric',
  },
  'mother of': {
    says: 'Is the female parent of the other person; differs from father of in sex, and from guardian of in a parental bond rather than a duty of care.',
    direction: 'directional',
  },
  'father of': {
    says: 'Is the male parent of the other person; differs from mother of in sex, and from guardian of in a parental bond rather than a duty of care.',
    direction: 'directional',
  },
  'parent of': {
    says: 'Is a parent of the other person when the sex is unknown or irrelevant; differs from mother of and father of in not naming the sex, and from guardian of in a blood or adoptive parental bond.',
    direction: 'directional',
  },
  'son of': {
    says: 'Is the male child of the other person; differs from daughter of in sex, and from child of in naming it.',
    direction: 'directional',
  },
  'daughter of': {
    says: 'Is the female child of the other person; differs from son of in sex, and from child of in naming it.',
    direction: 'directional',
  },
  'child of': {
    says: 'Is the offspring of the other person when the sex is unknown or irrelevant; differs from son of and daughter of in not naming the sex.',
    direction: 'directional',
  },
  'husband of': {
    says: 'Is the married man in the marriage with the other person; differs from wife of in sex, and from spouse of in naming it.',
    direction: 'directional',
  },
  'wife of': {
    says: 'Is the married woman in the marriage with the other person; differs from husband of in sex, and from spouse of in naming it.',
    direction: 'directional',
  },
  'spouse of': {
    says: 'Is the married partner of the other person when the sex is unknown or irrelevant; differs from husband of and wife of in not naming the sex.',
    direction: 'directional',
  },
  'uncle of': {
    says: 'Is a sibling of the other person\'s parent, or the husband of such a sibling; differs from aunt of in sex, and from cousin of in generation.',
    direction: 'directional',
  },
  'aunt of': {
    says: 'Is a sibling of the other person\'s parent, or the wife of such a sibling; differs from uncle of in sex, and from cousin of in generation.',
    direction: 'directional',
  },
  'nephew of': {
    says: 'Is the son of the other person\'s sibling; differs from niece of in sex, and from cousin of in generation.',
    direction: 'directional',
  },
  'niece of': {
    says: 'Is the daughter of the other person\'s sibling; differs from nephew of in sex, and from cousin of in generation.',
    direction: 'directional',
  },
  'cousin of': {
    says: 'Is the child of the other person\'s aunt or uncle; differs from sibling of in not sharing a parent, and from relative of in naming the degree.',
    direction: 'symmetric',
  },
  'relative of': {
    says: 'Is kin by blood or marriage when no closer term fits; differs from sibling of and cousin of in leaving the degree of kinship unspecified.',
    direction: 'directional',
  },
  'friend of': {
    says: 'Holds personal affection and companionable regard for the other person beyond a working tie; differs from acquaintance in closeness, and from ally of in affection rather than a shared cause.',
    direction: 'symmetric',
  },
  'enemy of': {
    says: 'Actively opposes, fights or works against the other person with harm intended; differs from disliked in open conflict, and from rival of in seeking harm rather than only to outdo.',
    direction: 'directional',
  },
  'ally of': {
    says: 'Sides with the other person in a conflict or cause; differs from friend of in a shared cause rather than affection, and from colleague of in acting together under pressure rather than working alongside.',
    direction: 'symmetric',
  },
  'teacher of': {
    says: 'Instructs the other person in a subject or skill; differs from mentor of in teaching a discipline rather than guiding a life, and from student of in the direction of instruction.',
    direction: 'directional',
  },
  'student of': {
    says: 'Is instructed by the other person; differs from apprentice of in formal study rather than a trade bound to a master, and from teacher of in the direction of instruction.',
    direction: 'directional',
  },
  'mentor of': {
    says: 'Guides the other person over time, shaping judgment and character; differs from teacher of in guidance beyond instruction, and from guardian of in development rather than safety.',
    direction: 'directional',
  },
  'leader of': {
    says: 'Heads the group or body the other belongs to; differs from employer of in authority over a body rather than a contract, and from master of in leading free members rather than sworn servants.',
    direction: 'directional',
  },
  'member of': {
    says: 'Belongs to the group or organisation the other heads or embodies; differs from colleague of in membership of a body rather than a working peer, and from ally of in standing membership rather than a cause.',
    direction: 'directional',
  },
  'peer of': {
    says: 'Holds equal standing with the other person in the same body or rank; differs from colleague of in equality of rank rather than shared work, and from friend of in station rather than affection.',
    direction: 'symmetric',
  },
  'colleague of': {
    says: 'Works alongside the other person in the same organisation or calling; differs from peer of in shared work rather than formal rank, and from ally of in routine cooperation rather than a cause.',
    direction: 'symmetric',
  },
  'aide of': {
    says: 'Assists the other person in a subordinate personal role; differs from apprentice of in service rather than learning, and from colleague of in subordination.',
    direction: 'directional',
  },
  'apprentice of': {
    says: 'Is learning a trade or discipline from the other person under a binding arrangement; differs from student of in a trade bond, and from aide of in learning rather than service.',
    direction: 'directional',
  },
  'master of': {
    says: 'Has the other person bound as apprentice or sworn servant; differs from employer of in sworn or bound service rather than employment, and from teacher of in authority over a bond.',
    direction: 'directional',
  },
  'operative for': {
    says: 'Carries out assigned or covert tasks for the other person or organisation; differs from aide of in field work for an organisation rather than personal service, and from employee/employer in assigned operations.',
    direction: 'directional',
  },
  'partner': {
    says: 'Works with the other person as an equal over time in a chosen joint enterprise; differs from colleague of in a lasting joint bond, and from ally of in a working partnership rather than a cause.',
    direction: 'symmetric',
  },
  'guardian of': {
    says: 'Has a formal duty to care for and protect the other person; differs from protective of in a duty rather than a feeling, and from parent of in lacking a parental bond.',
    direction: 'directional',
  },
  'employer of': {
    says: 'Pays the other person for work and directs it; differs from master of in a working contract rather than sworn service, and from leader of in an employment relation rather than a body of followers.',
    direction: 'directional',
  },
  'customer of': {
    says: 'Buys goods or services from the other person; differs from employer of in receiving rather than directing work, and from acquaintance in being a commercial relation.',
    direction: 'directional',
  },
  'owner of': {
    says: 'Holds the other creature as property; differs from guardian of in ownership rather than care, and from employer of in owning rather than employing.',
    direction: 'directional',
  },
  'rival of': {
    says: 'Competes with the other person for the same goal, position or affection; differs from enemy of in seeking to outdo rather than to harm, and from peer of in contest rather than equal station.',
    direction: 'symmetric',
  },
  'acquaintance': {
    says: 'Knows the other person by name and has met them, without a close personal bond; differs from friend of in lacking affection, and from colleague of in lacking a shared working role.',
    direction: 'symmetric',
  },
  'disliked': {
    says: 'Holds a negative opinion of, or aversion toward, the other person without open conflict or harm sought; differs from enemy of in taking no side and pursuing no harm, and from distrusted in being about the person rather than their reliability.',
    direction: 'symmetric',
  },
  'resented': {
    says: 'Holds a lingering bitter grievance against the other person for a past wrong; differs from disliked in naming a specific injury, and from enemy of in seeking no active harm.',
    direction: 'symmetric',
  },
  'feared': {
    says: 'Feels threat or dread in the other person\'s presence; differs from distrusted in being about danger rather than honesty, and from bullied in being subjected to the threat rather than met with dread.',
    direction: 'symmetric',
  },
  'admired': {
    says: 'Regards the other person with approval and esteem for their qualities or deeds; differs from trusted in being an assessment of worth rather than reliance on conduct.',
    direction: 'symmetric',
  },
  'trusted': {
    says: 'Relies on the other person\'s conduct, honesty or competence; differs from loyal to in being confidence held by the truster rather than allegiance given by the other.',
    direction: 'symmetric',
  },
  'distrusted': {
    says: 'Doubts the other person\'s honesty or intentions; differs from feared in being doubt about reliability rather than dread of harm, and from disliked in being about trust rather than aversion.',
    direction: 'symmetric',
  },
  'bullied': {
    says: 'Subjects the other person to repeated intimidation or coercion from a position of greater power; differs from enemy of in being a pattern of domination rather than open opposition.',
    direction: 'directional',
  },
  'protective of': {
    says: 'Takes responsibility for shielding the other person from harm; differs from guardian of in acting from care or attachment rather than a formal duty, and from mentor of in safeguarding rather than developing.',
    direction: 'directional',
  },
  'jealous of': {
    says: 'Feels wounded or possessive envy toward the other person over attention, status or affection; differs from rival of in being a feeling rather than a competition, and from resented in centring on what the other has.',
    direction: 'symmetric',
  },
  'loyal to': {
    says: 'Gives steadfast allegiance to the other person and puts their interests first; differs from trusted in being allegiance given rather than reliance held.',
    direction: 'directional',
  },
  'obeyed': {
    says: 'Accepts the other person\'s authority and follows their commands; differs from loyal to in acting on orders rather than devotion, and from student of in obedience rather than learning.',
    direction: 'directional',
  },
};

/** The glossary as prompt text: one line per concept, with its direction. */
export function kindGlossaryBlock(): string {
  const lines = CLOSED_ROLE_KINDS.map((kind) => {
    const gloss = KIND_GLOSSES[kind];
    return `- ${kind} (${gloss?.direction ?? 'directional'}) — ${gloss?.says ?? ''}`;
  });
  return (
    'Defined relationship concepts. The kind must be exactly one of these labels; never invent a kind. ' +
    'A directional concept reads from the person it belongs to toward the other person, and a reversed ' +
    'claim is refused. A symmetric concept is the same claim in either order and is stored once. ' +
    'kind_source must be the passage\'s own words that express the concept, copied verbatim.\n' +
    lines.join('\n')
  );
}

/** True when the kind resolves to the closed role-noun list. */
export function isClosedRoleKind(kind: string): boolean {
  return CLOSED_ROLE_KINDS.includes((kind ?? '').trim().toLowerCase());
}

/** True when a concept's direction is enforced on promotion. A symmetric
 * concept is the same claim in either order; an unknown stored kind has no
 * direction claim (and cannot be promoted anyway). */
export function isDirectionalKind(kind: string): boolean {
  return KIND_GLOSSES[(kind ?? '').trim().toLowerCase()]?.direction === 'directional';
}


/** Kinds that record coverage only (who shared a passage), never a tie. */
const COVERAGE_KINDS = new Set(['appears with', 'appears in', 'cooccurrence', 'co-occurrence']);

/** Relationship-grade kinds: closed, never coverage, never a moment. */
export const RELATIONSHIP_GRADE_KINDS: ReadonlySet<string> = new Set(
  CLOSED_ROLE_KINDS.filter((kind) => !COVERAGE_KINDS.has(kind) && !isMomentKind(kind)),
);

export type PromoteReason =
  | 'open-vocab'
  | 'coverage-only'
  | 'ruled-park'
  | 'quote-not-verbatim'
  | 'tie-word-absent'
  | 'endpoint-unnamed'
  | 'direction-mismatch'
  | 'same-identity'
  | 'quarantined-entity'
  | 'assertion-missing'
  | 'below-threshold'
  | 'moment';

export interface PromoteRow {
  fromId: number;
  toId: number;
  fromName: string;
  toName: string;
  fromAliases?: string[];
  toAliases?: string[];
  kind: string;
  evidence: string;
  /** Verbatim words from the quote that express the kind, when the model named
   * them ("sided with" for ally of). */
  kindSource?: string;
  /** The sentence that names the other endpoint, when the quote names one. */
  anchorEvidence?: string;
  /** The model's own estimate that the passage establishes this relation. */
  confidence?: number;
}

export interface PromoteContext {
  db: Db;
  projectId: number;
  /** Text of the passage the quote cites. */
  chunkText?: string | null;
  /** Optional per-command roster index, kept for name-variant resolution. */
  index?: RosterIndex;
  /** Override the project's `minConfidence` (tests and one-off commands). */
  minConfidence?: number;
}

export interface PromoteDecision {
  ok: boolean;
  reason?: PromoteReason;
}

/** Build the per-command roster index: every entity row plus all chunk text. */
function commandRosterIndex(db: Db, projectId: number): RosterIndex {
  return buildRosterIndex(
    db.all<{ name: string; aliases: string }>('SELECT name, aliases FROM canon_entity WHERE project_id = ?', projectId)
      .map((row) => ({ name: row.name, aliases: strList(row.aliases) })),
    db.all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', projectId)
      .map((row) => row.text)
      .join(' '),
  );
}

function canonicalKind(kind: string): string {
  return (kind ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ');
}

/** The name list a matcher receives: explicit forms, widened by derived
 * variants when a roster index is supplied. With no index this is exactly
 * `[name, ...aliases]`, so non-opting callers behave byte for byte as before. */
function explicitVariants(name: string, aliases: string[], index?: RosterIndex): string[] {
  return index ? deriveNameVariants({ name, aliases }, index) : [name, ...aliases];
}

function endpointTokens(name: string, aliases: string[], index?: RosterIndex): Set<string> {
  const out = new Set<string>();
  for (const variant of explicitVariants(name, aliases, index)) {
    for (const token of nameTokens(variant)) if (token.length >= 2) out.add(token);
  }
  return out;
}

/**
 * Diagnostic only: the direction a sentence reads for a kind. Promotion does
 * not consult it (direction is the model's); the evidence-repair and audit
 * tools use it to describe what the text says.
 */
function quoteDirection(
  kind: string,
  evidence: string,
  row: PromoteRow,
  index?: RosterIndex,
): 'forward' | 'reverse' | 'unknown' {
  const words = normalise(evidence).split(' ').filter(Boolean);
  if (!words.length) return 'unknown';
  const kindWords = normalise(kind).split(' ').filter(Boolean)
    .filter((word) => !['of', 'to', 'with', 'for', 'a', 'an', 'the', 'in', 'on', 'as'].includes(word));
  const head = kindWords[0];
  if (!head) return 'unknown';
  const from = endpointTokens(row.fromName, row.fromAliases ?? [], index);
  const to = endpointTokens(row.toName, row.toAliases ?? [], index);
  const ownerOf = (token: string): 'from' | 'to' | null => {
    const base = token.replace(/['’]s$/, '');
    if (from.has(base)) return 'from';
    if (to.has(base)) return 'to';
    return null;
  };
  const bases = words.map((word) => word.replace(/['’]s$/, ''));
  const spansOf = (name: string, aliases: string[]): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (const variant of explicitVariants(name, aliases, index)) {
      const target = canonicalName(variant).split(' ').filter(Boolean);
      if (!target.length) continue;
      for (let i = 0; i + target.length <= bases.length; i++) {
        if (target.every((word, k) => bases[i + k] === word)) out.push([i, i + target.length - 1]);
      }
    }
    return out;
  };
  const fromSpans = spansOf(row.fromName, row.fromAliases ?? []);
  const toSpans = spansOf(row.toName, row.toAliases ?? []);
  const coordinatedBetween = (a: [number, number], b: [number, number]): boolean => {
    const lo = a[1] <= b[0] ? a[1] : b[1] <= a[0] ? b[1] : a[0];
    const hi = a[1] <= b[0] ? b[0] : b[1] <= a[0] ? a[0] : a[1];
    for (let at = lo; at <= hi; at++) if (words[at] === 'and' || words[at] === 'or') return true;
    return false;
  };
  const passive = new Set(['was', 'were', 'been', 'had', 'have', 'is', 'are', 'be', 'being']);
  let forward = false;
  for (let at = 0; at < words.length; at++) {
    if (words[at] !== head) continue;
    if (at > 0 && /['’]s$/.test(words[at - 1]!)) {
      const owner = ownerOf(words[at - 1]!);
      if (owner === 'to') forward = true;
      if (owner === 'from') return 'reverse';
    }
    if (words[at + 1] === 'of' && words[at + 2]) {
      const object = ownerOf(words[at + 2]!);
      if (object === 'to') forward = true;
      if (object === 'from') return 'reverse';
      continue;
    }
    let holderAt = at + 1;
    while (holderAt < words.length && (NAME_TITLE_WORDS.has(words[holderAt]!) || PROOF_TITLES.has(words[holderAt]!))) {
      holderAt++;
    }
    if (holderAt < words.length && holderAt > at + 1) {
      const holder = ownerOf(words[holderAt]!);
      if (holder === 'to') return 'reverse';
      if (holder === 'from') forward = true;
    }
    if (!passive.has(words[at - 1] ?? '') && !/['’]s$/.test(words[at - 1] ?? '')) {
      const subjectFrom = fromSpans.some(
        ([s, e]) => e >= at - 2 && e <= at - 1 && !coordinatedBetween([s, e], [at, at]),
      );
      const subjectTo = toSpans.some(
        ([s, e]) => e >= at - 2 && e <= at - 1 && !coordinatedBetween([s, e], [at, at]),
      );
      const otherInWindow = (spans: Array<[number, number]>): boolean =>
        spans.some(([s, e]) => s >= at + 1 && s <= at + 3 && !coordinatedBetween([at, at], [s, e]));
      if (subjectFrom && otherInWindow(toSpans)) forward = true;
      if (subjectTo && otherInWindow(fromSpans)) return 'reverse';
    }
  }
  return forward ? 'forward' : 'unknown';
}

/** Diagnostic only; see `quoteDirection`. */
export function relationSentenceDirection(
  kind: string,
  evidence: string,
  fromName: string,
  fromAliases: string[],
  toName: string,
  toAliases: string[],
  index?: RosterIndex,
): 'forward' | 'reverse' | 'unknown' {
  return quoteDirection(canonicalKind(kind), evidence, {
    fromId: 0,
    toId: 0,
    fromName,
    toName,
    fromAliases,
    toAliases,
    kind,
    evidence,
  }, index);
}

function sameOrInverseKind(noteKind: string, rowKind: string): boolean {
  const note = canonicalKind(noteKind);
  const row = canonicalKind(rowKind);
  if (!note || !row) return false;
  if (note === row) return true;
  const noteHead = kindHead(note);
  const rowHead = kindHead(row);
  if (noteHead === rowHead) return true;
  return inverseKinds(note).includes(rowHead) || inverseKinds(row).includes(noteHead);
}

/** Minimum model confidence a claim needs to bank, unless the project overrides it. */
export const DEFAULT_MIN_CONFIDENCE = 0.7;

/** Read the project's `minConfidence` setting, clamped to 0..1. */
export function projectMinConfidence(db: Db, projectId: number): number {
  const row = db.get<{ settings: string }>('SELECT settings FROM project WHERE id = ?', projectId);
  try {
    const value = Number((JSON.parse(row?.settings || '{}') as { minConfidence?: unknown }).minConfidence);
    if (Number.isFinite(value)) return Math.min(1, Math.max(0, value));
  } catch {
    /* a malformed setting means the default, never a crash */
  }
  return DEFAULT_MIN_CONFIDENCE;
}

/** The tier a model claim gets from its own score. */
export function claimTier(confidence: number, minConfidence = DEFAULT_MIN_CONFIDENCE): 'accepted' | 'provisional' {
  return Number.isFinite(confidence) && confidence >= minConfidence ? 'accepted' : 'provisional';
}

/** The model's assessment of one claim. Stored as provenance, never as a rule. */
export interface ClaimAssessment {
  names_both: boolean;
  other_person: 'named' | 'pronoun' | 'role' | 'absent' | '';
  asserted: boolean;
  hedge: 'certain' | 'hedged' | 'doubted' | 'denied' | '';
  kind_fit: 'yes' | 'partly' | 'no' | '';
  strength: number;
  why: string;
}

/** Read the assessment defensively. A missing score is zero, never a pass. */
export function readClaimAssessment(raw: Record<string, unknown>): ClaimAssessment {
  // `confidence` is the pre-question field; new assessments carry `strength`.
  const numeric = Number(raw.strength ?? raw.confidence);
  const strength = Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 0;
  const other = String(raw.other_person ?? '').trim().toLowerCase();
  const hedge = String(raw.hedge ?? '').trim().toLowerCase();
  const kindFit = String(raw.kind_fit ?? '').trim().toLowerCase();
  return {
    names_both: raw.names_both === true,
    other_person:
      other === 'named' || other === 'pronoun' || other === 'role' || other === 'absent' ? other : '',
    asserted: raw.asserted !== false,
    hedge:
      hedge === 'certain' || hedge === 'hedged' || hedge === 'doubted' || hedge === 'denied' ? hedge : '',
    kind_fit: kindFit === 'yes' || kindFit === 'partly' || kindFit === 'no' ? kindFit : '',
    strength,
    why: String(raw.why ?? '').trim(),
  };
}

/** The assessment carried inside `supporting_evidence` (no new column). */
export function assessmentSupporting(assessment: ClaimAssessment): string {
  return toJson([{ assessment }]);
}

/** Read the assessment back from a stored supporting_evidence blob. */
export function storedAssessment(supportingEvidence: string): ClaimAssessment | null {
  for (const item of fromJson<Record<string, unknown>[]>(supportingEvidence, [])) {
    const nested = item?.assessment;
    if (nested && typeof nested === 'object') return readClaimAssessment(nested as Record<string, unknown>);
  }
  return null;
}

/** Add one assessment to an existing supporting_evidence array. */
function appendAssessment(supportingEvidence: string, assessment: ClaimAssessment): string {
  const items = fromJson<Record<string, unknown>[]>(supportingEvidence, []);
  items.push({ assessment });
  return toJson(items);
}

/**
 * The mechanical promotion guard. It certifies only what code can see: the
 * quote and any anchor are in the cited passage, and a quoted fragment does not
 * hide a hedge or denial in the sentence that holds it. Meaning, linkage,
 * direction and label fitness are the model's and are recorded with the claim.
 */
function provenQuoteReason(row: PromoteRow, chunkText?: string | null, index?: RosterIndex): PromoteReason | null {
  const chunk = chunkText ?? '';
  if (!row.evidence.trim() || !chunk || !normalise(chunk).includes(normalise(row.evidence))) {
    return 'quote-not-verbatim';
  }
  const anchor = (row.anchorEvidence ?? '').trim();
  if (anchor && !normalise(chunk).includes(normalise(anchor))) return 'quote-not-verbatim';
  // Citation honesty, not grammar: "Mara feared Tor" may not be quoted from
  // "Perhaps Mara feared Tor" as though the hedge were not there.
  for (const span of anchor ? [row.evidence, anchor] : [row.evidence]) {
    const holding = splitSentences(chunk).find((sentence) => normalise(sentence).includes(normalise(span))) ?? span;
    if (leadingDenialOrHedge(holding, row, index)) return 'assertion-missing';
  }
  return null;
}

/**
 * Pure mechanical check plus the confidence threshold. No database access; the
 * context supplies the passage and, when needed, the threshold.
 */
export function provenRelation(
  row: PromoteRow,
  context: { chunkText?: string | null; index?: RosterIndex; minConfidence?: number },
): PromoteDecision {
  const quoteReason = provenQuoteReason(row, context.chunkText, context.index);
  if (quoteReason) return { ok: false, reason: quoteReason };
  const min = context.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  if (claimTier(row.confidence ?? 1, min) !== 'accepted') return { ok: false, reason: 'below-threshold' };
  return { ok: true };
}

/**
 * True when two character rows have nested names — "X" inside "Captain X",
 * "Surname" inside "Given Surname". That is one person the bank split, so a
 * tie between the two rows is an artefact of splitting, never a fact about the
 * book. Factions, places and items are exempt: "House X" and "X" can hold a
 * real relationship.
 */
function nestedCharacterNames(
  db: Db,
  projectId: number,
  fromId: number,
  toId: number,
  fromName: string,
  toName: string,
): boolean {
  const kinds = db.all<{ kind: string }>(
    'SELECT kind FROM canon_entity WHERE project_id = ? AND id IN (?, ?)',
    projectId,
    fromId,
    toId,
  );
  if (kinds.length !== 2 || kinds.some((row) => row.kind !== 'character')) return false;
  const a = canonicalName(fromName).split(' ').filter(Boolean);
  const b = canonicalName(toName).split(' ').filter(Boolean);
  const nests = (short: string[], long: string[]): boolean =>
    short.length > 0 &&
    short.length < long.length &&
    long.some((_, start) => short.every((word, offset) => long[start + offset] === word));
  return nests(a, b) || nests(b, a);
}

/** True when the two rows share a name or alias: one person split in two. */
function sharedIdentityRows(db: Db, projectId: number, fromId: number, toId: number): boolean {
  const rows = db.all<{ name: string; aliases: string }>(
    'SELECT name, aliases FROM canon_entity WHERE project_id = ? AND id IN (?, ?)',
    projectId,
    fromId,
    toId,
  );
  if (rows.length !== 2) return false;
  const keys = (row: { name: string; aliases: string }): Set<string> =>
    new Set([canonicalName(row.name), ...strList(row.aliases).map((alias) => canonicalName(alias))].filter(Boolean));
  const a = keys(rows[0]!);
  const b = keys(rows[1]!);
  for (const key of a) if (b.has(key)) return true;
  return false;
}

/**
 * The promotion decision: three mechanical checks, the author's PARK rulings,
 * and the author's confidence threshold. The model decides the claim; this
 * function only refuses fabrications, missing people, the same person twice,
 * author-ruled pairs, and claims below the author's bar.
 */
export function canPromote(row: PromoteRow, context: PromoteContext): PromoteDecision {
  if (row.fromId === row.toId) return { ok: false, reason: 'same-identity' };
  if (nestedCharacterNames(context.db, context.projectId, row.fromId, row.toId, row.fromName, row.toName)) {
    return { ok: false, reason: 'same-identity' };
  }
  if (sharedIdentityRows(context.db, context.projectId, row.fromId, row.toId)) {
    return { ok: false, reason: 'same-identity' };
  }
  const entities = context.db.all<{ id: number; review_status: string }>(
    'SELECT id, review_status FROM canon_entity WHERE project_id = ? AND id IN (?, ?)',
    context.projectId,
    row.fromId,
    row.toId,
  );
  if (entities.length !== 2) return { ok: false, reason: 'endpoint-unnamed' };
  // A character held back as a probable common noun cannot hold a tie either.
  if (entities.some((entity) => entity.review_status === 'quarantined')) {
    return { ok: false, reason: 'quarantined-entity' };
  }
  // An author's PARK is a ruling, not a theory of truth: it still binds the
  // pair and its inverse class.
  const parked = context.db.all<{ attempted_kind: string }>(
    `SELECT attempted_kind FROM canon_tie_note
      WHERE project_id = ? AND lower(ruling) LIKE 'park%'
        AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?))`,
    context.projectId,
    row.fromId,
    row.toId,
    row.toId,
    row.fromId,
  );
  if (parked.some((note) => sameOrInverseKind(note.attempted_kind, row.kind))) {
    return { ok: false, reason: 'ruled-park' };
  }
  const quoteReason = provenQuoteReason(row, context.chunkText, context.index);
  if (quoteReason) return { ok: false, reason: quoteReason };
  const min = context.minConfidence ?? projectMinConfidence(context.db, context.projectId);
  if (claimTier(row.confidence ?? 1, min) !== 'accepted') return { ok: false, reason: 'below-threshold' };
  return { ok: true };
}

/** Token spans of a name and its variants inside a quote. */
function mentionSpans(text: string, name: string, aliases: string[], index?: RosterIndex): Array<[number, number]> {
  const words = canonicalName(text).split(' ').filter(Boolean);
  const spans: Array<[number, number]> = [];
  for (const variant of explicitVariants(name, aliases, index)) {
    const target = canonicalName(variant).split(' ').filter(Boolean);
    if (!target.length) continue;
    for (let i = 0; i + target.length <= words.length; i++) {
      if (target.every((word, k) => words[i + k] === word)) spans.push([i, i + target.length - 1]);
    }
  }
  return spans;
}

/** Words only: possessives split out, punctuation to spaces, lowercased. */
function assertionWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/'s\b/g, " 's")
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** The label's own head word and its ordinary inflections. Used only when no
 * `kind_source` is supplied; it is morphology, never a synonym list. */
function labelHeadForms(kind: string): Set<string> {
  const head = kindHeadWord(kind);
  if (!head) return new Set();
  const forms = new Set([head, ...headForms(head)]);
  return forms;
}

/** Negation and uncertainty markers. An asserted tie cannot ride on a denied or
 * merely possible clause. Structural, not a synonym list. */
const NEGATORS = new Set(['not', 'never', 'no', 'nor', 'neither', 'without', 'hardly', 'barely']);
const HEDGES = new Set([
  'perhaps', 'possibly', 'maybe', 'might', 'may', 'could', 'probably', 'apparently',
  'seemingly', 'seemed', 'seems', 'suspected', 'suspect', 'rumoured', 'rumored',
]);

/** Grammatical words that cannot carry a relationship on their own. */
const CITATION_STOP = new Set([
  'of', 'to', 'with', 'for', 'a', 'an', 'the', 'in', 'on', 'as', 'at', 'by', 'from',
  'about', 'over', 'under', 'and', 'or', 'but', 'so', 'that', 'this', 'these', 'those',
  'then', 'when', 'while', 'after', 'before', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
  'may', 'might', 'must', 'should', 'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your',
  'he', 'him', 'his', 'she', 'her', 'it', 'its', 'they', 'them', 'their', "'s",
]);

/** The cited words with the endpoints removed. A model often quotes the whole
 * clause ("Mara loathed Tor"); the relationship words are what remains. A word
 * that is also the kind's head stays even when it appears in a name
 * ("Aunt Petunia" does not swallow the aunt in an aunt-of citation). */
function citationWords(
  source: string,
  kind: string,
  fromName: string,
  fromAliases: string[],
  toName: string,
  toAliases: string[],
  index?: RosterIndex,
): string[] {
  const head = kindHeadWord(kind);
  const keep = labelHeadForms(kind);
  const nameWords = new Set<string>();
  for (const variant of [...explicitVariants(fromName, fromAliases, index), ...explicitVariants(toName, toAliases, index)]) {
    for (const token of assertionWords(variant)) nameWords.add(token);
  }
  return assertionWords(source).filter((token) => !nameWords.has(token) || keep.has(token) || token === head);
}

/**
 * True when the clause leading up to the assertion denies or hedges it. The
 * model may quote only the positive core ("Mara feared Tor") from a sentence
 * that says "Perhaps Mara feared Tor"; the quote alone shows no hedge, so the
 * sentence in the source is checked too.
 */
function leadingDenialOrHedge(sentence: string, row: PromoteRow, index?: RosterIndex): boolean {
  const words = assertionWords(sentence);
  if (!words.length) return false;
  const cited = citationWords(
    row.kindSource ?? '',
    row.kind,
    row.fromName,
    row.fromAliases ?? [],
    row.toName,
    row.toAliases ?? [],
    index,
  ).filter((word) => !CITATION_STOP.has(word));
  const anchors = new Set<string>(cited);
  const head = kindHeadWord(row.kind);
  if (head) anchors.add(head);
  if (!anchors.size) return false;
  const at = words.findIndex((word) => anchors.has(word));
  if (at < 0) return false;
  // A hedge or negator just before the assertion softens or denies it. Looking
  // back a few tokens covers "Perhaps Mara feared Tor" and "Mara did not trust
  // Tor" without importing an unrelated clause earlier in the sentence.
  return words.slice(Math.max(0, at - 4), at).some((word) => NEGATORS.has(word) || HEDGES.has(word));
}

/** The head noun of a kind: "aunt of" gives "aunt". */
function kindHeadWord(kind: string): string {
  for (const word of (kind ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    if (!KIND_FILLER.has(word)) return word;
  }
  return '';
}

function headForms(head: string): Set<string> {
  const forms = new Set([head, `${head}s`, `${head}es`, `${head}ed`, `${head}ing`, `${head}d`]);
  if (head.endsWith('e')) forms.add(`${head.slice(0, -1)}ing`);
  if (head.endsWith('y')) {
    forms.add(`${head.slice(0, -1)}ies`);
    forms.add(`${head.slice(0, -1)}ied`);
  }
  // Irregular plurals among the closed kinship concepts.
  if (head === 'child') forms.add('children');
  if (head === 'wife') forms.add('wives');
  return forms;
}

/**
 * True when the quote names both endpoints at two different places.
 *
 * One surface string cannot stand for both sides. When two rows share an alias
 * (one row carrying the other's name as an alias), a quote that says only that
 * name would otherwise satisfy both endpoints and prove a tie between a person
 * and themself. Requiring two disjoint mentions closes that hole without
 * needing to know who is who, and without trusting model-written aliases.
 */
export function namesBothDistinctly(
  quote: string,
  fromName: string,
  fromAliases: string[],
  toName: string,
  toAliases: string[],
  index?: RosterIndex,
): boolean {
  const from = mentionSpans(quote, fromName, fromAliases, index);
  const to = mentionSpans(quote, toName, toAliases, index);
  return from.some(([s1, e1]) => to.some(([s2, e2]) => e1 < s2 || e2 < s1));
}

/** Load one relation and check only the pure proven tier (no PARK lookup). */
export function provenRelationById(
  db: Db,
  projectId: number,
  relationId: number,
  index?: RosterIndex,
): PromoteDecision {
  const guarded = loadGuardRow(db, projectId, relationId);
  if (!guarded) return { ok: false, reason: 'quote-not-verbatim' };
  return provenRelation(guarded.row, {
    chunkText: guarded.chunkText,
    index,
    minConfidence: projectMinConfidence(db, projectId),
  });
}

interface GuardedRow {
  row: PromoteRow;
  chunkText: string | null;
}

function loadGuardRow(db: Db, projectId: number, relationId: number): GuardedRow | null {
  const row = db.get<{
    from_entity: number;
    to_entity: number;
    kind: string;
    evidence: string;
    source_refs: string;
    from_name: string;
    from_aliases: string;
    to_name: string;
    to_aliases: string;
    kind_source: string;
    anchor_evidence: string;
    confidence: number;
  }>(
    `SELECT r.from_entity, r.to_entity, r.kind, r.evidence, r.source_refs, r.kind_source, r.anchor_evidence, r.confidence,
            a.name AS from_name, a.aliases AS from_aliases,
            b.name AS to_name, b.aliases AS to_aliases
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND r.id = ?`,
    projectId,
    relationId,
  );
  if (!row) return null;
  let chunkText: string | null = null;
  try {
    const refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[];
    const chunkId = refs.find((ref) => Number.isFinite(Number(ref?.chunk)) && Number(ref?.chunk) > 0)?.chunk;
    if (chunkId) {
      const citedId = Number(chunkId);
      chunkText =
        pageEvidenceText(db, citedId) ??
        db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', citedId)?.text ??
        null;
    }
  } catch {
    chunkText = null;
  }
  return {
    row: {
      fromId: row.from_entity,
      toId: row.to_entity,
      fromName: row.from_name,
      toName: row.to_name,
      fromAliases: strList(row.from_aliases),
      toAliases: strList(row.to_aliases),
      kind: row.kind,
      evidence: row.evidence,
      kindSource: row.kind_source,
      anchorEvidence: row.anchor_evidence,
      confidence: row.confidence,
    },
    chunkText,
  };
}

export interface PromoteProvisionalResult {
  checked: number;
  promoted: number;
  still: { id: number; reason: string }[];
}

/** Promote provisional rows whose stored quote passes the proven check. */
export function promoteProvisional(
  db: Db,
  projectId: number,
  opts: { ids?: number[]; dryRun?: boolean; limit?: number } = {},
): PromoteProvisionalResult {
  const ids = opts.ids?.length ? opts.ids : null;
  let rows: { id: number }[];
  if (ids) {
    rows = db.all<{ id: number }>(
      `SELECT id FROM canon_relation WHERE project_id = ? AND review_status = 'provisional' AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
      projectId,
      ...ids,
    );
  } else {
    rows = db.all<{ id: number }>(
      `SELECT id FROM canon_relation WHERE project_id = ? AND review_status = 'provisional' ORDER BY id${opts.limit ? ' LIMIT ?' : ''}`,
      projectId,
      ...(opts.limit ? [Math.max(1, opts.limit)] : []),
    );
  }
  const result: PromoteProvisionalResult = { checked: rows.length, promoted: 0, still: [] };
  // One index for the whole pass: the proof matchers see given/surname forms.
  const index = commandRosterIndex(db, projectId);
  for (const row of rows) {
    // Promotion uses the full guard, PARK included: a provisional row cannot
    // walk around a human ruling that the pure proven check does not see.
    const decision = canPromoteRelation(db, projectId, row.id, index);
    if (decision.ok) {
      result.promoted++;
      if (!opts.dryRun) {
        db.transaction(() => {
          const changed = db.run(
            "UPDATE canon_relation SET review_status = 'accepted' WHERE id = ? AND project_id = ? AND review_status = 'provisional'",
            row.id,
            projectId,
          ).changes;
          if (changed) {
            recordRuling(db, projectId, {
              relationId: row.id,
              role: 'appeal',
              actor: 'guard',
              standard: 'sentence-proof',
              fromStatus: 'provisional',
              toStatus: 'accepted',
              basis: 'proven quote and threshold',
            });
          }
        });
      }
    } else {
      result.still.push({ id: row.id, reason: decision.reason ?? 'unproven' });
    }
  }
  return result;
}

export interface ReclassifyAcceptedResult {
  checked: number;
  demoted: number;
  reasons: Record<string, number>;
}

/**
 * Move accepted rows that fail the proven check to provisional. Only the
 * user-confirmed tier is exempt; demotion is never automatic except for this
 * one-time reclassification of machine-accepted rows.
 */
export function reclassifyAccepted(
  db: Db,
  projectId: number,
  opts: { dryRun?: boolean } = {},
): ReclassifyAcceptedResult {
  const rows = db.all<{ id: number }>(
    "SELECT id FROM canon_relation WHERE project_id = ? AND review_status = 'accepted' ORDER BY id",
    projectId,
  );
  const result: ReclassifyAcceptedResult = { checked: rows.length, demoted: 0, reasons: {} };
  const index = commandRosterIndex(db, projectId);
  for (const row of rows) {
    const decision = provenRelationById(db, projectId, row.id, index);
    if (decision.ok) continue;
    result.demoted++;
    const reason = decision.reason ?? 'unproven';
    result.reasons[reason] = (result.reasons[reason] ?? 0) + 1;
    if (!opts.dryRun) {
      db.transaction(() => {
        const changed = db.run(
          "UPDATE canon_relation SET review_status = 'provisional' WHERE id = ? AND project_id = ? AND review_status = 'accepted'",
          row.id,
          projectId,
        ).changes;
        if (changed) {
          recordRuling(db, projectId, {
            relationId: row.id,
            role: 'appeal',
            actor: 'guard',
            standard: 'strict-verbatim',
            fromStatus: 'accepted',
            toStatus: 'provisional',
            basis: `reclassify: ${reason}`,
          });
        }
      });
    }
  }
  return result;
}

export interface AcceptedAuditRow {
  id: number;
  fromName: string;
  kind: string;
  toName: string;
  guard: 'ok' | PromoteReason | 'unproven';
  direction: 'forward' | 'reverse' | 'unknown';
  cannotJudge: boolean;
  action: 'keep' | 'demote';
}

export interface AcceptedAuditResult {
  audited: number;
  passing: number;
  failing: Record<string, number>;
  cannotJudge: number;
  changed: number;
  backupPath?: string;
  rows: AcceptedAuditRow[];
}

/**
 * Recheck every accepted relation against the current guard.
 *
 * Two standards, strict wins: `canPromote` uses word-level `normalise`
 * (punctuation stripped) while keeper integrity (`findUnverifiedKeepers`)
 * demands a contiguous verbatim span under `auditNormalize` (presentation
 * only). A row the guard passes but strict integrity fails is still a
 * failure with reason `quote-not-verbatim` (strict `no-ref` maps to the same
 * audit code, matching the audit's existing missing-quote reporting).
 * Direction is reported separately: a row the guard
 * passes while the direction check returns `unknown` is counted as one it
 * cannot judge, never as proven direction.
 *
 * Dry run by default. With `write`, failing rows are demoted from `accepted`
 * to `provisional` in one transaction after a consistent snapshot backup; no
 * evidence, source ref or kind is touched, rows are never deleted, and
 * `user_confirmed` is never read.
 */
export function auditAcceptedRelations(
  db: Db,
  projectId: number,
  opts: { write?: boolean; limit?: number } = {},
): AcceptedAuditResult {
  const rows = db
    .all<{
      id: number;
      from_entity: number;
      to_entity: number;
      kind: string;
      evidence: string;
      source_refs: string;
      kind_source: string;
      anchor_evidence: string;
      confidence: number;
      from_name: string;
      from_aliases: string;
      to_name: string;
      to_aliases: string;
    }>(
      `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.evidence, r.source_refs,
              r.kind_source, r.anchor_evidence, r.confidence,
              a.name AS from_name, a.aliases AS from_aliases,
              b.name AS to_name, b.aliases AS to_aliases
         FROM canon_relation r
         JOIN canon_entity a ON a.id = r.from_entity
         JOIN canon_entity b ON b.id = r.to_entity
        WHERE r.project_id = ? AND r.review_status = 'accepted'
        ORDER BY r.id`,
      projectId,
    )
    .slice(0, opts.limit === undefined ? undefined : Math.max(0, Math.floor(opts.limit)));
  // Strict keeper integrity wins over the word-level guard: a quoted span
  // that normalise() forgives (extra quotes, ellipsis) still fails when the
  // cited chunk does not contain it verbatim.
  const strictById = new Map(findUnverifiedKeepers(db, projectId).map((r) => [r.id, r.reason]));
  const needle = (evidence: string): string => normalise(evidence);
  const chunkTextFor = (row: { evidence: string; source_refs: string }): string | null => {
    const want = needle(row.evidence);
    let claimed: string | null = null;
    const refs = fromJson<{ chunk?: unknown }[]>(row.source_refs, []);
    const chunkId = refs
      .map((ref) => Number(ref?.chunk))
      .find((id) => Number.isFinite(id) && id > 0);
    if (chunkId !== undefined) {
      claimed =
        pageEvidenceText(db, chunkId) ??
        db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', chunkId)?.text ??
        null;
    }
    if (want && claimed && needle(claimed).includes(want)) return claimed;
    if (!want) return claimed;
    // Empty or stale refs: locate the evidence in any chunk, as replay does.
    const found = loadOrderedChunks(db, projectId).find((chunk) => needle(chunk.text).includes(want));
    return found?.text ?? claimed;
  };

  const result: AcceptedAuditResult = {
    audited: rows.length,
    passing: 0,
    failing: {},
    cannotJudge: 0,
    changed: 0,
    rows: [],
  };
  const failing: number[] = [];
  const failReason = new Map<number, string>();
  for (const row of rows) {
    const fromAliases = strList(row.from_aliases);
    const toAliases = strList(row.to_aliases);
    const chunkText = chunkTextFor(row);
    const promoteRow: PromoteRow = {
      fromId: row.from_entity,
      toId: row.to_entity,
      fromName: row.from_name,
      toName: row.to_name,
      fromAliases,
      toAliases,
      kind: row.kind,
      evidence: row.evidence,
      kindSource: row.kind_source,
      anchorEvidence: row.anchor_evidence,
      confidence: row.confidence,
    };
    const decision = canPromote(promoteRow, { db, projectId, chunkText });
    // Direction is the model's now, so the audit reports no grammar verdict.
    const direction = 'unknown' as const;
    const cannotJudge = false;
    // Strict wins: a strict integrity failure demotes even when the
    // word-level guard passes. Strict `no-ref` reports as the audit's
    // existing `quote-not-verbatim` code.
    const strictHit = strictById.get(row.id);
    const effective: { ok: boolean; reason?: string } = strictHit
      ? { ok: false, reason: 'quote-not-verbatim' }
      : decision.ok
        ? { ok: true }
        : { ok: false, reason: decision.reason ?? 'unproven' };
    if (effective.ok) result.passing++;
    else {
      const reason = effective.reason ?? 'unproven';
      result.failing[reason] = (result.failing[reason] ?? 0) + 1;
      failReason.set(row.id, reason);
      failing.push(row.id);
    }
    if (cannotJudge) result.cannotJudge++;
    result.rows.push({
      id: row.id,
      fromName: row.from_name,
      kind: row.kind,
      toName: row.to_name,
      guard: effective.ok ? 'ok' : ((effective.reason as PromoteReason | 'unproven') ?? 'unproven'),
      direction,
      cannotJudge,
      action: effective.ok ? 'keep' : 'demote',
    });
  }

  if (opts.write && failing.length) {
    const stamp = nowIso().replace(/[:.]/g, '-');
    const backupPath = `${db.path}.audit-backup-${stamp}.db`;
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    result.backupPath = backupPath;
    db.transaction(() => {
      for (const id of failing) {
        const changed = db.run(
          "UPDATE canon_relation SET review_status = 'provisional' WHERE id = ? AND project_id = ? AND review_status = 'accepted'",
          id,
          projectId,
        ).changes;
        result.changed += changed;
        if (changed) {
          recordRuling(db, projectId, {
            relationId: id,
            role: 'appeal',
            actor: 'guard',
            standard: 'strict-verbatim',
            fromStatus: 'accepted',
            toStatus: 'provisional',
            basis: `audit: ${failReason.get(id) ?? 'unproven'}`,
          });
        }
      }
    });
  }
  return result;
}

/* ------------------------------------------------------- attested tier */

/**
 * The attested tier (audit open decision #1, 2026-10-28): a citable middle
 * tier between keeper and provisional. A row is attested when its quote is
 * verbatim in its cited chunk, both endpoints are named anywhere in that
 * chunk, the endpoints are not one identity, and no PARK ruling binds the
 * pair. Still quoted, still checkable, never invented.
 *
 * The label is not a gate. The concept vocabulary names and queries claims;
 * it no longer decides whether a passage proves one, because a correct claim
 * worded as "his master" was being refused for the author's phrasing rather
 * than for its evidence. Co-presence and one-off moments are still excluded:
 * they are not relationships at all.
 *
 * Keeper-grade is frozen: `canPromote`, extraction tiers (`claimTier`) and
 * `promoteProvisional` are untouched, so sentence-proof rows stay
 * keeper-grade. This pass only moves provisional/needs_review rows that are
 * passage-proof but not sentence-proof to `attested`. Direction and identity
 * rules are the same helpers the keeper guard uses.
 */

export type AttestedReason = PromoteReason | 'keeper-track' | 'assessment-missing' | 'moment';

export interface AttestedCheck {
  attested: boolean;
  reason: AttestedReason | 'ok';
}

export interface AttestedRow {
  fromId: number;
  toId: number;
  fromName: string;
  toName: string;
  fromAliases: string[];
  toAliases: string[];
  kind: string;
  evidence: string;
  kindSource?: string;
  anchorEvidence?: string;
  /** Raw supporting_evidence JSON carrying the model's assessment. */
  supportingEvidence: string;
  fromStatus: string;
  toStatus: string;
}

function chunkNamesEndpoint(chunkText: string, name: string, aliases: string[]): boolean {
  return (
    nameMentionedExact(name, chunkText) ||
    aliases.some((a) => a.trim() !== '' && nameMentionedExact(a, chunkText))
  );
}

/**
 * Passage-level proof for one row. Pure and read-only: no writes, no model.
 * `chunkText` must be the raw cited chunk: verbatim here is the strict
 * auditNormalize standard integrity enforces, so assignment and integrity
 * agree exactly. provenQuoteReason still runs for hedge/anchor honesty.
 */
export function checkAttested(
  db: Db,
  projectId: number,
  row: AttestedRow,
  chunkText: string | null,
): AttestedCheck {
  const canonical = canonicalKind(row.kind);
  // Co-presence and one-off actions are not relationship evidence, whatever
  // the quote says. Every other label is the model's call: the concept
  // vocabulary is for naming and querying, never a promotion gate.
  if (COVERAGE_KINDS.has(canonical)) return { attested: false, reason: 'coverage-only' };
  if (isMomentKind(canonical)) return { attested: false, reason: 'moment' };
  // A positive stored assessment clearing the bar is required: a row
  // without one is unjudged evidence, never attested. Denial, a wrong-kind
  // verdict, or a sub-bar strength all refuse, reusing existing reasons only.
  const assessment = storedAssessment(row.supportingEvidence);
  if (!assessment) {
    return { attested: false, reason: 'assertion-missing' };
  }
  if (assessment.asserted === false || assessment.hedge === 'denied' || assessment.hedge === 'doubted') {
    return { attested: false, reason: 'assertion-missing' };
  }
  if (assessment.kind_fit === 'no' || assessment.strength < DEFAULT_MIN_CONFIDENCE) {
    return { attested: false, reason: 'below-threshold' };
  }
  if (row.fromId === row.toId) return { attested: false, reason: 'same-identity' };
  if (nestedCharacterNames(db, projectId, row.fromId, row.toId, row.fromName, row.toName)) {
    return { attested: false, reason: 'same-identity' };
  }
  if (sharedIdentityRows(db, projectId, row.fromId, row.toId)) {
    return { attested: false, reason: 'same-identity' };
  }
  if (row.fromStatus === 'quarantined' || row.toStatus === 'quarantined') {
    return { attested: false, reason: 'quarantined-entity' };
  }
  // Same ruling as canPromote: an author's PARK binds the pair and its
  // inverse class.
  const parked = db.all<{ attempted_kind: string }>(
    'SELECT attempted_kind FROM canon_tie_note WHERE project_id = ? AND lower(ruling) LIKE \'park%\' AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?))',
    projectId,
    row.fromId,
    row.toId,
    row.toId,
    row.fromId,
  );
  if (parked.some((note) => sameOrInverseKind(note.attempted_kind, row.kind))) {
    return { attested: false, reason: 'ruled-park' };
  }
  if (!chunkText) return { attested: false, reason: 'quote-not-verbatim' };
  if (!auditNormalize(chunkText).includes(auditNormalize(row.evidence))) {
    return { attested: false, reason: 'quote-not-verbatim' };
  }
  const quoteReason = provenQuoteReason(
    {
      fromId: row.fromId,
      toId: row.toId,
      fromName: row.fromName,
      toName: row.toName,
      fromAliases: row.fromAliases,
      toAliases: row.toAliases,
      kind: row.kind,
      evidence: row.evidence,
      kindSource: row.kindSource,
      anchorEvidence: row.anchorEvidence,
    },
    chunkText,
  );
  if (quoteReason) return { attested: false, reason: quoteReason };
  // Sentence-proof rows belong to the keeper track (promoteProvisional), not here.
  if (namesBothDistinctly(row.evidence, row.fromName, row.fromAliases, row.toName, row.toAliases)) {
    return { attested: false, reason: 'keeper-track' };
  }
  if (!chunkNamesEndpoint(chunkText, row.fromName, row.fromAliases)) {
    return { attested: false, reason: 'endpoint-unnamed' };
  }
  if (!chunkNamesEndpoint(chunkText, row.toName, row.toAliases)) {
    return { attested: false, reason: 'endpoint-unnamed' };
  }
  return { attested: true, reason: 'ok' };
}

export interface AnchorFillResult {
  checked: number;
  filled: number;
  changed: number;
  skipped: Record<'both-named' | 'neither-named' | 'no-chunk' | 'no-sentence' | 'ambiguous', number>;
  backupPath?: string;
}

/**
 * Fill `anchor_evidence` for claims whose quote names one person.
 *
 * The quote states the tie; the anchor is the sentence in the same chunk that
 * names the other person. Code-only and deterministic: exactly one candidate
 * sentence, or the nearest one to the quote, or nothing. This is the missing
 * half of a one-name citation, not a new judgement about the claim.
 */
export function populateAnchors(
  db: Db,
  projectId: number,
  opts: { write?: boolean; limit?: number } = {},
): AnchorFillResult {
  const rows = db
    .all<{
      id: number;
      evidence: string;
      source_refs: string;
      review_status: string;
      a_name: string;
      a_aliases: string;
      b_name: string;
      b_aliases: string;
    }>(
      `SELECT r.id, r.evidence, r.source_refs, r.review_status,
              a.name AS a_name, a.aliases AS a_aliases,
              b.name AS b_name, b.aliases AS b_aliases
         FROM canon_relation r
         JOIN canon_entity a ON a.id = r.from_entity
         JOIN canon_entity b ON b.id = r.to_entity
        WHERE r.project_id = ? AND r.anchor_evidence = '' AND trim(r.evidence) <> ''
        ORDER BY r.id`,
      projectId,
    )
    .slice(0, opts.limit === undefined ? undefined : Math.max(0, Math.floor(opts.limit)));
  const result: AnchorFillResult = {
    checked: rows.length,
    filled: 0,
    changed: 0,
    skipped: { 'both-named': 0, 'neither-named': 0, 'no-chunk': 0, 'no-sentence': 0, ambiguous: 0 },
  };
  const picks: { id: number; anchor: string; basis: string }[] = [];
  for (const row of rows) {
    const quote = normalise(row.evidence);
    const formsA = [row.a_name, ...strList(row.a_aliases)].map((f) => f.toLowerCase()).filter(Boolean);
    const formsB = [row.b_name, ...strList(row.b_aliases)].map((f) => f.toLowerCase()).filter(Boolean);
    const names = (forms: string[]): boolean => forms.some((form) => quote.includes(form));
    const inA = names(formsA);
    const inB = names(formsB);
    if (inA && inB) {
      result.skipped['both-named']++;
      continue;
    }
    let chunkText: string | null = null;
    try {
      const refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[];
      const chunkId = refs.find((ref) => Number.isFinite(Number(ref?.chunk)) && Number(ref?.chunk) > 0)?.chunk;
      if (chunkId !== undefined) {
        chunkText = db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', Number(chunkId))?.text ?? null;
      }
    } catch {
      chunkText = null;
    }
    if (!chunkText) {
      result.skipped['no-chunk']++;
      continue;
    }
    const sentences = splitSentences(chunkText);
    const quoteAt = sentences.findIndex((sentence) => normalise(sentence).includes(quote));
    if (quoteAt < 0) {
      result.skipped['no-sentence']++;
      continue;
    }
    const wanted = inA ? formsB : formsA;
    const candidates = !inA && !inB
      ? sentences
          .map((sentence, index) => ({ sentence, index }))
          .filter(
            ({ sentence }) =>
              formsA.some((form) => sentence.toLowerCase().includes(form)) &&
              formsB.some((form) => sentence.toLowerCase().includes(form)),
          )
      : sentences
          .map((sentence, index) => ({ sentence, index }))
          .filter(({ sentence, index }) => index !== quoteAt && wanted.some((form) => sentence.toLowerCase().includes(form)));
    if (!candidates.length) {
      result.skipped['no-sentence']++;
      continue;
    }
    const nearest = candidates.reduce((best, current) =>
      Math.abs(current.index - quoteAt) < Math.abs(best.index - quoteAt) ? current : best,
    );
    const tied = candidates.filter(
      (candidate) => Math.abs(candidate.index - quoteAt) === Math.abs(nearest.index - quoteAt) && candidate.index !== nearest.index,
    );
    if (tied.length) {
      result.skipped.ambiguous++;
      continue;
    }
    result.filled++;
    picks.push({
      id: row.id,
      anchor: nearest.sentence,
      basis: !inA && !inB ? 'anchor names both' : `anchor names ${inA ? row.b_name : row.a_name}`,
    });
  }
  if (opts.write && picks.length) {
    const stamp = nowIso().replace(/[:.]/g, '-');
    const backupPath = `${db.path}.anchor-backup-${stamp}.db`;
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    result.backupPath = backupPath;
    db.transaction(() => {
      for (const pick of picks) {
        const changed = db.run(
          'UPDATE canon_relation SET anchor_evidence = ? WHERE id = ? AND project_id = ? AND anchor_evidence = ?',
          pick.anchor,
          pick.id,
          projectId,
          '',
        ).changes;
        if (!changed) continue;
        result.changed++;
        recordRuling(db, projectId, {
          relationId: pick.id,
          role: 'clue',
          actor: 'chain',
          standard: 'anchor',
          basis: pick.basis,
          quote: pick.anchor,
        });
      }
    });
  }
  return result;
}

export interface AttestedAssignRow {
  id: number;
  fromName: string;
  kind: string;
  toName: string;
  result: 'attest' | 'accept' | 'leave';
  reason: AttestedReason | 'ok';
}

export interface AttestedAssignResult {
  checked: number;
  attested: number;
  keeperTrack: number;
  /** Of the keeper-track rows, those the proven check passed and moved to `accepted`. */
  keeperPromoted: number;
  /** Rows whose quote was replaced by the cited chunk's own bytes before grading. */
  repaired: number;
  still: Record<string, number>;
  changed: number;
  backupPath?: string;
  rows: AttestedAssignRow[];
}

/**
 * The cited chunk's own bytes for a quote that differs only in presentation.
 *
 * Word-level match: the quote's words, in order, separated by any run of
 * punctuation or space. Used only to repair a citation whose words are
 * already right, so integrity and the attested tier can agree on one string.
 * Returns null when the words are not there, so a paraphrase is still refused.
 */
function exactSpanInChunk(chunkText: string, quote: string): string | null {
  const words = String(quote ?? '').match(/[A-Za-z0-9']+/g) ?? [];
  if (words.length < 2) return null;
  const pattern = words
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join("[^A-Za-z0-9']+");
  const match = new RegExp(pattern, 'i').exec(chunkText);
  return match ? match[0] : null;
}

/**
 * Move passage-proof provisional/needs_review rows to `attested`.
 *
 * Dry run by default. With `write`, attested rows move from
 * provisional/needs_review to `attested` in one transaction after a
 * consistent snapshot backup; no source ref, kind or assessment is touched,
 * rows are never deleted, and accepted/user_confirmed rows are never read.
 * Evidence is only replaced by the cited chunk's own bytes for the same
 * words, and only when `repairQuotes` asks for it.
 *
 * `promoteKeeper` also sends sentence-proof rows (both names in the quote)
 * through the existing proven guard to `accepted` instead of leaving them for
 * a `promote` pass that only reads `provisional`. Off by default, so the
 * library's keeper-track contract is unchanged.
 *
 * `repairQuotes` fixes a quote whose words are in the chunk but whose
 * punctuation is not (a straight vs curly apostrophe, a dropped full stop).
 * Integrity kept refusing those as not verbatim while the bank had already
 * accepted them under the word-level guard; repairing to the chunk's bytes
 * makes both agree without weakening the check.
 */
export function assignAttestedTiers(
  db: Db,
  projectId: number,
  opts: { write?: boolean; limit?: number; promoteKeeper?: boolean; repairQuotes?: boolean } = {},
): AttestedAssignResult {
  const rows = db
    .all<{
      id: number;
      from_entity: number;
      to_entity: number;
      kind: string;
      evidence: string;
      source_refs: string;
      kind_source: string;
      anchor_evidence: string;
      supporting_evidence: string;
      confidence: number;
      review_status: string;
      from_name: string;
      from_aliases: string;
      from_status: string;
      to_name: string;
      to_aliases: string;
      to_status: string;
    }>(
      'SELECT r.id, r.from_entity, r.to_entity, r.kind, r.evidence, r.source_refs, r.kind_source, r.anchor_evidence, r.supporting_evidence, r.confidence, r.review_status, a.name AS from_name, a.aliases AS from_aliases, a.review_status AS from_status, b.name AS to_name, b.aliases AS to_aliases, b.review_status AS to_status FROM canon_relation r JOIN canon_entity a ON a.id = r.from_entity JOIN canon_entity b ON b.id = r.to_entity WHERE r.project_id = ? AND r.review_status IN (\'provisional\',\'needs_review\') ORDER BY r.id',
      projectId,
    )
    .slice(0, opts.limit === undefined ? undefined : Math.max(0, Math.floor(opts.limit)));
  const result: AttestedAssignResult = {
    checked: rows.length,
    attested: 0,
    keeperTrack: 0,
    keeperPromoted: 0,
    repaired: 0,
    still: {},
    changed: 0,
    rows: [],
  };
  const attest: number[] = [];
  const promote: number[] = [];
  const repairs = new Map<number, string>();
  const priorStatus = new Map<number, string>();
  for (const row of rows) {
    priorStatus.set(row.id, row.review_status);
    // Passage-level means the raw cited chunk: no page-text expansion and no
    // anywhere-fallback, so this agrees exactly with integrity.
    let chunkText: string | null = null;
    try {
      const refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[];
      const chunkId = refs.find((ref) => Number.isFinite(Number(ref?.chunk)) && Number(ref?.chunk) > 0)?.chunk;
      if (chunkId !== undefined) {
        chunkText =
          db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', Number(chunkId))?.text ?? null;
      }
    } catch {
      chunkText = null;
    }
    let evidence = row.evidence;
    if (opts.repairQuotes && chunkText && !auditNormalize(chunkText).includes(auditNormalize(evidence))) {
      const exact = exactSpanInChunk(chunkText, evidence);
      if (exact) {
        evidence = exact;
        repairs.set(row.id, exact);
      }
    }
    const check = checkAttested(
      db,
      projectId,
      {
        fromId: row.from_entity,
        toId: row.to_entity,
        fromName: row.from_name,
        toName: row.to_name,
        fromAliases: strList(row.from_aliases),
        toAliases: strList(row.to_aliases),
        kind: row.kind,
        evidence,
        kindSource: row.kind_source,
        anchorEvidence: row.anchor_evidence,
        supportingEvidence: row.supporting_evidence,
        fromStatus: row.from_status,
        toStatus: row.to_status,
      },
      chunkText,
    );
    if (check.attested) {
      result.attested++;
      if (repairs.has(row.id)) result.repaired++;
      attest.push(row.id);
      result.rows.push({ id: row.id, fromName: row.from_name, kind: row.kind, toName: row.to_name, result: 'attest', reason: 'ok' });
    } else if (check.reason === 'keeper-track') {
      result.keeperTrack++;
      // Sentence-proof rows belong to the keeper track. When the caller asks
      // for it, the same proven guard that `promote` uses decides, and a pass
      // moves the row to `accepted` instead of stranding it at needs_review.
      const decision = opts.promoteKeeper
        ? canPromote(
            {
              fromId: row.from_entity,
              toId: row.to_entity,
              fromName: row.from_name,
              toName: row.to_name,
              fromAliases: strList(row.from_aliases),
              toAliases: strList(row.to_aliases),
              kind: row.kind,
              evidence,
              kindSource: row.kind_source,
              anchorEvidence: row.anchor_evidence,
              confidence: row.confidence,
            },
            { db, projectId, chunkText },
          )
        : null;
      if (decision?.ok) {
        result.keeperPromoted++;
        if (repairs.has(row.id)) result.repaired++;
        promote.push(row.id);
        result.rows.push({ id: row.id, fromName: row.from_name, kind: row.kind, toName: row.to_name, result: 'accept', reason: 'ok' });
      } else {
        const reason = decision?.reason ?? 'keeper-track';
        result.still[reason] = (result.still[reason] ?? 0) + 1;
        result.rows.push({ id: row.id, fromName: row.from_name, kind: row.kind, toName: row.to_name, result: 'leave', reason });
      }
    } else {
      result.still[check.reason] = (result.still[check.reason] ?? 0) + 1;
      result.rows.push({ id: row.id, fromName: row.from_name, kind: row.kind, toName: row.to_name, result: 'leave', reason: check.reason });
    }
  }
  if (opts.write && (attest.length || promote.length)) {
    const stamp = nowIso().replace(/[:.]/g, '-');
    const backupPath = `${db.path}.attested-backup-${stamp}.db`;
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    result.backupPath = backupPath;
    db.transaction(() => {
      for (const id of attest) {
        const fixed = repairs.get(id);
        if (fixed !== undefined) {
          db.run('UPDATE canon_relation SET evidence = ? WHERE id = ? AND project_id = ?', fixed, id, projectId);
        }
        const changed = db.run(
          "UPDATE canon_relation SET review_status = 'attested' WHERE id = ? AND project_id = ? AND review_status IN ('provisional','needs_review')",
          id,
          projectId,
        ).changes;
        result.changed += changed;
        if (changed) {
          recordRuling(db, projectId, {
            relationId: id,
            role: 'appeal',
            actor: 'guard',
            standard: 'passage-proof',
            fromStatus: priorStatus.get(id) ?? '',
            toStatus: 'attested',
            basis: fixed !== undefined ? 'passage proof, quote repaired to chunk' : 'passage proof',
          });
        }
      }
      for (const id of promote) {
        const fixed = repairs.get(id);
        if (fixed !== undefined) {
          db.run('UPDATE canon_relation SET evidence = ? WHERE id = ? AND project_id = ?', fixed, id, projectId);
        }
        const changed = db.run(
          "UPDATE canon_relation SET review_status = 'accepted' WHERE id = ? AND project_id = ? AND review_status IN ('provisional','needs_review')",
          id,
          projectId,
        ).changes;
        result.changed += changed;
        if (changed) {
          recordRuling(db, projectId, {
            relationId: id,
            role: 'appeal',
            actor: 'guard',
            standard: 'sentence-proof',
            fromStatus: priorStatus.get(id) ?? '',
            toStatus: 'accepted',
            basis: 'proven quote and threshold',
          });
        }

      }
    });
  }
  return result;
}

export interface FindEvidenceResult extends PromoteProvisionalResult {
  returned: number;
  verified: number;
  failed: { id: number; reason: string }[];
}

/**
 * Optional evidence finder: one narrow model call per provisional row asks for
 * the sentence naming both endpoints and stating the tie. Only the returned
 * sentence's verification matters; the model's opinion never does. The stored
 * quote is not rewritten (the boundary forbids quote changes), so promotion
 * means the returned sentence passed the same proven check.
 */
export async function promoteProvisionalWithEvidence(
  db: Db,
  llm: LlmClient,
  projectId: number,
  opts: { limit?: number; dryRun?: boolean } = {},
): Promise<FindEvidenceResult> {
  const rows = db.all<{ id: number }>(
    `SELECT id FROM canon_relation WHERE project_id = ? AND review_status = 'provisional' ORDER BY id LIMIT ?`,
    projectId,
    Math.max(1, opts.limit ?? 5),
  );
  const result: FindEvidenceResult = {
    checked: rows.length,
    promoted: 0,
    still: [],
    returned: 0,
    verified: 0,
    failed: [],
  };
  const index = commandRosterIndex(db, projectId);
  for (const row of rows) {
    const guarded = loadGuardRow(db, projectId, row.id);
    if (!guarded || !guarded.chunkText) {
      result.still.push({ id: row.id, reason: 'quote-not-verbatim' });
      continue;
    }
    let sentence = '';
    try {
      const res = await llm.chat({
        system: `You find one proving sentence. Reply with JSON only: {"sentence":"..."} or {"sentence":"NONE"}.
Return ONE contiguous sentence copied VERBATIM from the passage that names a form of BOTH ${guarded.row.fromName} and ${guarded.row.toName} and states that ${guarded.row.fromName} is ${guarded.row.toName}'s ${guarded.row.kind}.
If no single sentence does, reply {"sentence":"NONE"}. Never paraphrase or use outside knowledge.`,
        messages: [{
          role: 'user',
          content: `PASSAGE:\n${guarded.chunkText}`,
        }],
        temperature: 0,
        maxTokens: 200,
        format: 'json',
      });
      const body = String(res.text ?? '').replace(/```json|```/g, '').trim();
      const start = body.indexOf('{');
      const end = body.lastIndexOf('}');
      const parsed = start >= 0 && end >= start ? JSON.parse(body.slice(start, end + 1)) : null;
      sentence = String(parsed?.sentence ?? '').trim();
    } catch {
      sentence = '';
    }
    if (!sentence || /^none$/i.test(sentence)) {
      result.still.push({ id: row.id, reason: 'quote-not-verbatim' });
      continue;
    }
    result.returned++;
    const candidate = { ...guarded.row, evidence: sentence };
    const decision = canPromote(candidate, { db, projectId, chunkText: guarded.chunkText, index });
    if (!decision.ok) {
      result.failed.push({ id: row.id, reason: decision.reason ?? 'unproven' });
      result.still.push({ id: row.id, reason: decision.reason ?? 'unproven' });
      continue;
    }
    result.verified++;
    result.promoted++;
    if (!opts.dryRun) {
      const previous = db.get<{ evidence: string; source_refs: string; supporting_evidence: string }>(
        'SELECT evidence, source_refs, supporting_evidence FROM canon_relation WHERE id = ? AND project_id = ?',
        row.id,
        projectId,
      );
      if (previous) {
        const supporting = fromJson<Record<string, unknown>[]>(previous.supporting_evidence, []);
        supporting.push({
          quote: previous.evidence,
          source_refs: fromJson<unknown[]>(previous.source_refs, []),
          reason: 'superseded',
          moved_at: nowIso(),
        });
        db.run(
          `UPDATE canon_relation
              SET evidence = ?, supporting_evidence = ?, review_status = 'accepted'
            WHERE id = ? AND project_id = ? AND review_status = 'provisional'`,
          sentence,
          toJson(supporting),
          row.id,
          projectId,
        );
      }
    }
  }
  return result;
}

/** Load one relation row and run the guard against its own passage. */
export function canPromoteRelation(
  db: Db,
  projectId: number,
  relationId: number,
  index?: RosterIndex,
): PromoteDecision {
  const row = db.get<{
    from_entity: number;
    to_entity: number;
    kind: string;
    evidence: string;
    source_refs: string;
    from_name: string;
    from_aliases: string;
    to_name: string;
    to_aliases: string;
    kind_source: string;
    confidence: number;
  }>(
    `SELECT r.from_entity, r.to_entity, r.kind, r.evidence, r.source_refs, r.kind_source, r.confidence,
            a.name AS from_name, a.aliases AS from_aliases,
            b.name AS to_name, b.aliases AS to_aliases
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND r.id = ?`,
    projectId,
    relationId,
  );
  if (!row) return { ok: false, reason: 'quote-not-verbatim' };
  let chunkText: string | null = null;
  try {
    const refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[];
    const chunkId = refs.find((ref) => Number.isFinite(Number(ref?.chunk)) && Number(ref?.chunk) > 0)?.chunk;
    if (chunkId) {
      const citedId = Number(chunkId);
      chunkText =
        pageEvidenceText(db, citedId) ??
        db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', citedId)?.text ??
        null;
    }
  } catch {
    chunkText = null;
  }
  return canPromote(
    {
      fromId: row.from_entity,
      toId: row.to_entity,
      fromName: row.from_name,
      toName: row.to_name,
      fromAliases: strList(row.from_aliases),
      toAliases: strList(row.to_aliases),
      kind: row.kind,
      evidence: row.evidence,
      kindSource: row.kind_source,
      confidence: row.confidence,
    },
    { db, projectId, chunkText, index },
  );
}

export interface RelationInsert {
  fromEntity: number;
  toEntity: number;
  kind: string;
  description?: string;
  evidence: string;
  sourceRefs: string;
  /** The words in the quote that express the kind, when the label's own word
   * is absent ("sided with" for ally of). Verbatim by construction. */
  kindSource?: string;
  /** The sentence that asserts the relationship, when the quote is context. */
  anchorEvidence?: string;
  modality?: string;
  reviewStatus?: string;
  confidence?: number;
  /** Provenance: the model's assessment, stored as JSON. */
  supportingEvidence?: string;
}

/**
 * The one relation insert. Every relation must carry a numeric chunk id so it
 * can be quoted, adjudicated and repaired; a locator alone is not enough.
 */
export function insertRelation(
  db: Db,
  projectId: number,
  row: RelationInsert,
): number {
  const refs = fromJson<{ chunk?: unknown }[]>(row.sourceRefs, []);
  if (!refs.some((ref) => {
    const id = Number(ref?.chunk);
    return Number.isFinite(id) && id > 0;
  })) {
    throw new Error('relation insert refused: source_refs must contain a numeric chunk id');
  }
  return db.transaction(() => {
    const id = Number(
      db.run(
        `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, confidence, modality, review_status, kind_source, anchor_evidence, supporting_evidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        row.fromEntity,
        row.toEntity,
        row.kind,
        row.description ?? '',
        row.evidence,
        row.sourceRefs,
        row.confidence ?? 1.0,
        row.modality ?? 'asserted',
        row.reviewStatus ?? 'accepted',
        row.kindSource ?? '',
        row.anchorEvidence ?? '',
        row.supportingEvidence ?? '[]',
        nowIso(),
      ).lastInsertRowid,
    );
    recordRuling(db, projectId, {
      relationId: id,
      role: 'charge',
      actor: 'bank',
      standard: 'claim',
      toStatus: row.reviewStatus ?? 'accepted',
      basis: `inserted ${row.kind}`,
      quote: row.evidence,
    });
    return id;
  });
}

/** Read-only audit: relations whose refs name a source/locator but no chunk. */
export function findLocatorOnlyRefs(db: Db, projectId: number): number[] {
  const rows = db.all<{ id: number; source_refs: string }>(
    'SELECT id, source_refs FROM canon_relation WHERE project_id = ? ORDER BY id',
    projectId,
  );
  const out: number[] = [];
  for (const row of rows) {
    let refs: { source?: unknown; locator?: unknown; chunk?: unknown }[] = [];
    try {
      const parsed = JSON.parse(row.source_refs || '[]');
      if (Array.isArray(parsed)) refs = parsed;
    } catch {
      refs = [];
    }
    if (!refs.length) continue;
    const hasChunk = refs.some((ref) => {
      const id = Number(ref?.chunk);
      return Number.isFinite(id) && id > 0;
    });
    const hasLocator = refs.some((ref) => String(ref?.locator ?? '').trim() || String(ref?.source ?? '').trim());
    if (!hasChunk && hasLocator) out.push(row.id);
  }
  return out;
}

export interface UnverifiedKeeper {
  id: number;
  fromName: string;
  toName: string;
  kind: string;
  reviewStatus: string;
  reason: 'no-ref' | 'quote-not-verbatim' | 'endpoint-unnamed';
}

/** Normalise only presentation: quotes, dashes, case and whitespace. */
function auditNormalize(text: string): string {
  return (text ?? '')
    .replace(/[“”«»]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—−]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Keeper rows whose evidence is not a contiguous verbatim span of a cited
 * chunk. Spliced or paraphrased text fails: normalisation never joins or
 * reorders sentences, it only flattens presentation. Attested rows are
 * checked too: they must pass the same verbatim check plus both endpoints
 * named in the cited chunk (the passage-level check).
 */
export function findUnverifiedKeepers(db: Db, projectId: number): UnverifiedKeeper[] {
  const chunks = db.all<{ id: number; text: string }>(
    'SELECT id, text FROM canon_chunk WHERE project_id = ?',
    projectId,
  );
  const textById = new Map(chunks.map((chunk) => [chunk.id, auditNormalize(chunk.text)]));
  const rows = db.all<{
    id: number;
    kind: string;
    evidence: string;
    source_refs: string;
    review_status: string;
    from_name: string;
    to_name: string;
  }>(
    `SELECT r.id, r.kind, r.evidence, r.source_refs, r.review_status,
            a.name AS from_name, b.name AS to_name
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND r.review_status IN ('accepted','user_confirmed','attested')
      ORDER BY r.id`,
    projectId,
  );
  const out: UnverifiedKeeper[] = [];
  const aliasByName = new Map(
    db
      .all<{ name: string; aliases: string }>('SELECT name, aliases FROM canon_entity WHERE project_id = ?', projectId)
      .flatMap((e) => [[e.name, e.aliases] as const, ...strList(e.aliases).map((a) => [a, e.aliases] as const)]),
  );
  const aka = (name: string): string[] => strList(aliasByName.get(name) ?? '[]');
  for (const row of rows) {
    let refs: { chunk?: unknown }[] = [];
    try {
      const parsed = JSON.parse(row.source_refs || '[]');
      if (Array.isArray(parsed)) refs = parsed;
    } catch {
      refs = [];
    }
    const chunkIds = refs
      .map((ref) => Number(ref?.chunk))
      .filter((id) => Number.isFinite(id) && textById.has(id));
    const needle = auditNormalize(row.evidence);
    if (!chunkIds.length) {
      out.push({ id: row.id, fromName: row.from_name, toName: row.to_name, kind: row.kind, reviewStatus: row.review_status, reason: 'no-ref' });
      continue;
    }
    const holding = !!needle && chunkIds.find((id) => textById.get(id)!.includes(needle));
    if (!holding) {
      out.push({ id: row.id, fromName: row.from_name, toName: row.to_name, kind: row.kind, reviewStatus: row.review_status, reason: 'quote-not-verbatim' });
      continue;
    }
    if (row.review_status === 'attested') {
      const holdingText = chunks.find((c) => c.id === holding)?.text ?? '';
      const named = (name: string): boolean =>
        nameMentionedExact(name, holdingText) || aka(name).some((a) => a.trim() !== '' && nameMentionedExact(a, holdingText));
      if (!named(row.from_name) || !named(row.to_name)) {
        out.push({ id: row.id, fromName: row.from_name, toName: row.to_name, kind: row.kind, reviewStatus: row.review_status, reason: 'endpoint-unnamed' });
      }
    }
  }
  return out;
}

/** Park a dropped tie for the batched relabeling pass. Reruns collide on
 * the pair-plus-label index and add nothing. */
export function persistTieNote(
  db: Db,
  projectId: number,
  fromId: number,
  toId: number,
  attemptedKind: string,
  reason: 'moment' | 'unsupported' | 'unsupported-citation' | 'open-vocab' | 'evaluation' | 'no-ref',
  evidence: string,
  sourceRefs: string,
  ruling = '',
  kindSource = '',
): void {
  // A note is a case file, not a relation. The model's citation rides along in
  // the span JSON (no schema change) so an accumulated note can be re-proved
  // under the same citation rule as a fresh relation.
  const withSource = (refs: string): string => {
    if (!kindSource) return refs;
    try {
      const parsed = JSON.parse(refs || '[]');
      if (!Array.isArray(parsed)) return refs;
      return toJson(parsed.map((ref) => ({ ...(ref as Record<string, unknown>), kind_source: kindSource })));
    } catch {
      return refs;
    }
  };
  const firstRefs = withSource(sourceRefs);
  const courtFor = (basis: string, quote: string): void => {
    const relation = db.get<{ id: number }>(
      `SELECT id FROM canon_relation
        WHERE project_id = ? AND lower(kind) = lower(?)
          AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?))
        ORDER BY id LIMIT 1`,
      projectId,
      attemptedKind,
      fromId,
      toId,
      toId,
      fromId,
    );
    recordRuling(db, projectId, {
      relationId: relation?.id ?? null,
      subject: relation
        ? undefined
        : `pair:${Math.min(fromId, toId)}:${Math.max(fromId, toId)}`,
      role: 'objection',
      actor: reason === 'evaluation' ? 'assessor' : 'guard',
      standard: 'tie-note',
      toStatus: 'pending',
      basis,
      quote,
    });
  };
  // One note per pair and kind, accumulating spans: evidence found in a later
  // window is added to the same note instead of being ignored, so two pages
  // can together prove one tie.
  const existing = db.get<{ id: number; evidence: string; source_refs: string }>(
    `SELECT id, evidence, source_refs FROM canon_tie_note
      WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND attempted_kind = ?`,
    projectId,
    fromId,
    toId,
    attemptedKind,
  );
  if (!existing) {
    db.run(
      `INSERT OR IGNORE INTO canon_tie_note (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status, ruling, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      projectId,
      fromId,
      toId,
      attemptedKind,
      reason,
      evidence,
      firstRefs,
      ruling,
      nowIso(),
    );
    courtFor(`objection ${reason}`, evidence);
    return;
  }
  const spans = noteSpans({ evidence: existing.evidence, source_refs: existing.source_refs });
  const incoming = noteSpans({ evidence, source_refs: firstRefs });
  const seen = new Set(spans.map((span) => `${span.chunk}|${normalise(span.quote)}`));
  let added = false;
  for (const span of incoming) {
    const key = `${span.chunk}|${normalise(span.quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push(span);
    added = true;
  }
  if (!added) return;
  db.run(
    'UPDATE canon_tie_note SET evidence = ?, source_refs = ? WHERE id = ?',
    spans[0]?.quote ?? existing.evidence,
    toJson(
      spans.map((span) => ({
        source: span.source ?? '',
        locator: span.locator ?? '',
        chunk: span.chunk,
        quote: span.quote,
        ...(span.kindSource ? { kind_source: span.kindSource } : {}),
      })),
    ),
    existing.id,
  );
  courtFor(`objection ${reason} evidence appended (note ${existing.id})`, spans[0]?.quote ?? evidence);
}

/** Spans held by a tie note: quote plus the passage it was copied from, and
 * optionally the model's citation for the concept. */
export interface NoteSpan {
  quote: string;
  source?: string;
  locator?: string;
  chunk?: number;
  kindSource?: string;
}

/** Read a note's spans, accepting the old single-quote shape. */
export function noteSpans(note: { evidence: string; source_refs: string }): NoteSpan[] {
  const out: NoteSpan[] = [];
  try {
    const refs = JSON.parse(note.source_refs || '[]');
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        const quote = String(ref?.quote ?? '').trim();
        const chunk = Number(ref?.chunk);
        if (quote && Number.isFinite(chunk) && chunk > 0) {
          out.push({
            quote,
            chunk,
            source: String(ref?.source ?? ''),
            locator: String(ref?.locator ?? ''),
            kindSource: String(ref?.kind_source ?? '').trim(),
          });
        }
      }
    }
  } catch {
    /* fall through to the legacy shape */
  }
  if (!out.length && note.evidence.trim()) {
    try {
      const refs = JSON.parse(note.source_refs || '[]');
      const first = Array.isArray(refs) ? refs[0] : undefined;
      const chunk = Number(first?.chunk);
      if (Number.isFinite(chunk) && chunk > 0) {
        out.push({
          quote: note.evidence,
          chunk,
          source: String(first?.source ?? ''),
          locator: String(first?.locator ?? ''),
        });
      }
    } catch {
      /* no usable span */
    }
  }
  return out;
}

/** Everything a sentence could use to state a relationship: the concepts' own
 * labels and their ordinary inflections. No synonym list; the model maps the
 * passage's wording onto a concept elsewhere. */
function tiePhrases(): string[] {
  const out = new Set<string>();
  for (const kind of CLOSED_ROLE_KINDS) {
    const head = kindHeadWord(kind);
    for (const phrase of [kind, head, ...(head ? headForms(head) : [])]) {
      const cleaned = normalise(phrase.replace(/\([^)]*\)/g, '').replace(/"/g, ''));
      if (cleaned.length > 2) out.add(cleaned);
    }
  }
  return [...out];
}

export interface SentenceCandidate {
  sentence: string;
  chunkId: number;
  locator: string;
  fromId: number;
  fromName: string;
  toId: number;
  toName: string;
}

/**
 * Find, without a model, every sentence that names two known people and uses a
 * relationship word. This is the searchable universe for name-anchored reading:
 * the model's job is then to judge one sentence, not to notice a tie across a
 * window and hope it emits both names.
 */
export function scanSentenceCandidates(db: Db, projectId: number): SentenceCandidate[] {
  const chunkRows = db.all<{ id: number; locator: string; text: string }>(
    'SELECT id, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    projectId,
  );
  // One roster index per scan: collisions and title frequency span every
  // entity in the project, not just the characters a candidate can name.
  const allRows = db.all<{ name: string; aliases: string }>(
    'SELECT name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  ).map((row) => ({ name: row.name, aliases: strList(row.aliases) }));
  const index = buildRosterIndex(allRows, chunkRows.map((chunk) => chunk.text).join(' '));
  const entities = db.all<{ id: number; name: string; aliases: string }>(
    "SELECT id, name, aliases FROM canon_entity WHERE project_id = ? AND kind = 'character' AND review_status != 'quarantined'",
    projectId,
  )
    .map((row) => ({
      id: row.id,
      name: row.name,
      tokens: canonicalName(row.name).split(' ').filter(Boolean),
      variants: deriveNameVariants({ name: row.name, aliases: strList(row.aliases) }, index)
        .map((variant) => canonicalName(variant).split(' ').filter(Boolean))
        .filter((tokens) => tokens.length > 0),
    }))
    .filter((row) => row.variants.length > 0);
  const phrases = tiePhrases()
    .map((phrase) => phrase.split(' ').filter(Boolean))
    .filter((tokens) => tokens.length > 0);
  const out: { candidate: SentenceCandidate; distance: number }[] = [];
  const seen = new Set<string>();

  const positions = (tokens: string[], target: string[]): number[] => {
    const at: number[] = [];
    for (let i = 0; i + target.length <= tokens.length; i++) {
      if (target.every((word, k) => tokens[i + k] === word)) at.push(i);
    }
    return at;
  };

  const chunks = chunkRows;
  for (const chunk of chunks) {
    for (const sentence of splitSentences(chunk.text)) {
      const tokens = canonicalName(sentence).split(' ').filter(Boolean);
      if (tokens.length < 3) continue;
      const phraseAt: { start: number; end: number }[] = [];
      for (const phrase of phrases) {
        for (const start of positions(tokens, phrase)) {
          phraseAt.push({ start, end: start + phrase.length - 1 });
        }
      }
      if (!phraseAt.length) continue;
      const present = entities
        .map((entity) => ({
          ...entity,
          at: entity.variants.flatMap((variant) =>
            positions(tokens, variant).map((start) => ({ start, end: start + variant.length - 1 })),
          ),
        }))
        .filter((entity) => entity.at.length > 0);
      if (present.length < 2) continue;
      const nests = (x: string[], y: string[]): boolean =>
        x.length > 0 && x.length < y.length && y.some((_, at) => x.every((word, k) => y[at + k] === word));
      for (let i = 0; i < present.length; i++) {
        for (let j = i + 1; j < present.length; j++) {
          const a = present[i]!;
          const b = present[j]!;
          if (nests(a.tokens, b.tokens) || nests(b.tokens, a.tokens)) continue;
          // The pair must sit in one clause with the tie word: 25 tokens from
          // first name to last, and a tie phrase within 10 tokens of that run.
          // A list of names spread across a sentence is not a statement about
          // two of them.
          let closest = Number.POSITIVE_INFINITY;
          for (const startA of a.at) {
            for (const startB of b.at) {
              const lo = Math.min(startA.start, startB.start);
              const hi = Math.max(startA.end, startB.end);
              const span = hi - lo;
              if (span > 25) continue;
              const near = phraseAt.some((phrase) => phrase.start >= lo - 10 && phrase.start <= hi + 10);
              if (!near) continue;
              if (span < closest) closest = span;
            }
          }
          if (!Number.isFinite(closest)) continue;
          const key = `${a.id}|${b.id}|${tokens.join(' ')}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            distance: closest,
            candidate: {
              sentence: sentence.trim(),
              chunkId: chunk.id,
              locator: chunk.locator,
              fromId: a.id,
              fromName: a.name,
              toId: b.id,
              toName: b.name,
            },
          });
        }
      }
    }
  }
  return out.sort((x, y) => x.distance - y.distance).map((entry) => entry.candidate);
}

export interface ScanResult {
  checked: number;
  accepted: number;
  parked: number;
  refused: number;
}

/**
 * Judge scanned sentences one at a time. The scan already guarantees a
 * sentence with two known names and a relationship word; the model only has to
 * say whether it states a lasting tie and which kind it is.
 */
export async function verifySentenceCandidates(
  db: Db,
  llm: LlmClient,
  projectId: number,
  candidates: SentenceCandidate[],
  opts: { max?: number; dryRun?: boolean; onProgress?: (message: string) => void } = {},
): Promise<ScanResult> {
  const list = candidates.slice(0, opts.max ?? candidates.length);
  const result: ScanResult = { checked: 0, accepted: 0, parked: 0, refused: 0 };
  // One index for the whole verification pass.
  const index = commandRosterIndex(db, projectId);
  for (const candidate of list) {
    opts.onProgress?.(`${candidate.fromName} / ${candidate.toName} — ${candidate.locator}`);
    let verdict: { tie?: unknown; kind?: unknown; from?: unknown; to?: unknown; anchor?: unknown } | null = null;
    try {
      const res = await llm.chat({
        system:
          'You judge one sentence from a novel. Reply with JSON only: ' +
          '{"tie": false} or {"tie": true, "kind": one of [' +
          `${CLOSED_ROLE_KINDS.join(', ')}], "from": "<name>", "to": "<name>", ` +
          '"anchor": "<the sentence from the passage that names the person a pronoun refers to>"}.',
        messages: [
          {
            role: 'user',
            content:
              `Sentence: ${candidate.sentence}\n` +
              `Question: does this sentence say that ${candidate.fromName} and ${candidate.toName} ` +
              'have a lasting relationship (family, lasting role, friend or enemy)? ' +
              'If it does, give the kind, then "from" for the one who has the relationship and "to" for the other: ' +
              'for "X was Y\'s mentor", Y is the mentor and X is the one mentored. ' +
              'If the sentence names only one of them, give in "anchor" the sentence from the passage that names the other. ' +
              'Answer {"tie":false} when the sentence states no lasting relationship.',
          },
        ],
        format: 'json',
        temperature: 0.1,
        maxTokens: 160,
      });
      const raw = String(res.text ?? '').replace(/```json|```/g, '');
      verdict = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
        tie?: unknown;
        kind?: unknown;
        from?: unknown;
        to?: unknown;
        anchor?: unknown;
      };
    } catch {
      result.refused++;
      continue;
    }
    result.checked++;
    if (verdict?.tie !== true) {
      result.refused++;
      continue;
    }
    const kind = canonicalKind(String(verdict.kind ?? ''));
    if (!isClosedRoleKind(kind)) {
      result.refused++;
      continue;
    }
    // Direction comes from the answer, not from the order the scan happened to
    // list the pair in. If the model names neither endpoint, the row is not
    // usable: guessing here is how a mentor becomes the mentee.
    const saidFrom = String(verdict.from ?? '').trim().toLowerCase();
    const saidTo = String(verdict.to ?? '').trim().toLowerCase();
    const forward = saidFrom === candidate.fromName.toLowerCase() && saidTo === candidate.toName.toLowerCase();
    const reverse = saidFrom === candidate.toName.toLowerCase() && saidTo === candidate.fromName.toLowerCase();
    if (!forward && !reverse) {
      result.refused++;
      continue;
    }
    const fromId = forward ? candidate.fromId : candidate.toId;
    const toId = forward ? candidate.toId : candidate.fromId;
    const chunk = db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', candidate.chunkId);
    if (!chunk || !normalise(chunk.text).includes(normalise(candidate.sentence))) {
      result.refused++;
      continue;
    }
    const anchorRaw = String(verdict.anchor ?? '').trim();
    const anchorEvidence =
      anchorRaw && normalise(chunk.text).includes(normalise(anchorRaw)) ? anchorRaw : '';
    const from = db.get<{ name: string; aliases: string }>('SELECT name, aliases FROM canon_entity WHERE id = ?', fromId);
    const to = db.get<{ name: string; aliases: string }>('SELECT name, aliases FROM canon_entity WHERE id = ?', toId);
    if (!from || !to) {
      result.refused++;
      continue;
    }
    const decision = canPromote(
      {
        fromId,
        toId,
        fromName: from.name,
        toName: to.name,
        fromAliases: strList(from.aliases),
        toAliases: strList(to.aliases),
        kind,
        evidence: candidate.sentence,
        anchorEvidence,
      },
      { db, projectId, chunkText: chunk.text, index },
    );
    const existing = db.get<{ id: number }>(
      'SELECT id FROM canon_relation WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND kind = ?',
      projectId,
      fromId,
      toId,
      kind,
    );
    if (existing) {
      // Already banked for this pair and kind: the scan adds no second row.
      result.parked++;
      continue;
    }
    const reviewStatus = decision.ok ? 'accepted' : 'provisional';
    if (decision.ok) result.accepted++;
    else result.parked++;
    if (!opts.dryRun) {
      insertRelation(db, projectId, {
        fromEntity: fromId,
        toEntity: toId,
        kind,
        description: '',
        evidence: candidate.sentence,
        anchorEvidence,
        sourceRefs: JSON.stringify([{ source: '', locator: candidate.locator, chunk: candidate.chunkId }]),
        reviewStatus,
      });
    }
  }
  return result;
}

/**
 * Anchored candidates: a sentence that names one character and refers to
 * another by pronoun ("his master", "my wife"), paired with a neighbouring
 * sentence that names the other. This is the shape the prose actually uses.
 */
export interface AnchoredCandidate {
  sentence: string;
  anchor: string;
  chunkId: number;
  locator: string;
  fromId: number;
  fromName: string;
  toId: number;
  toName: string;
}

const PRONOUNS = new Set([
  'he','she','him','her','his','hers','they','them','their','theirs',
  'my','mine','our','ours','your','yours','its',
]);

export function scanAnchoredCandidates(db: Db, projectId: number): AnchoredCandidate[] {
  const entities = db.all<{ id: number; name: string }>(
    "SELECT id, name FROM canon_entity WHERE project_id = ? AND kind = 'character' AND review_status != 'quarantined'",
    projectId,
  ).map((row) => ({ id: row.id, name: row.name, tokens: canonicalName(row.name).split(' ').filter(Boolean) }))
    .filter((row) => row.tokens.length > 0);
  const phrases = tiePhrases().map((p) => p.split(' ').filter(Boolean));
  const chunks = db.all<{ id: number; locator: string; text: string }>(
    'SELECT id, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    projectId,
  );
  const sentences: { text: string; chunkId: number; locator: string; words: string[]; who: { id: number; name: string }[] }[] = [];
  for (const chunk of chunks) {
    for (const sentence of splitSentences(chunk.text)) {
      const words = canonicalName(sentence).split(' ').filter(Boolean);
      const who = entities
        .filter((e) => e.tokens.length <= words.length && words.some((_, i) => e.tokens.every((w, k) => words[i + k] === w)))
        .map((e) => ({ id: e.id, name: e.name }));
      sentences.push({ text: sentence.trim(), chunkId: chunk.id, locator: chunk.locator, words, who });
    }
  }
  const hasPhrase = (words: string[]): boolean =>
    phrases.some((phrase) => phrase.length > 0 && words.some((_, i) => phrase.every((w, k) => words[i + k] === w)));
  const out: AnchoredCandidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]!;
    if (!hasPhrase(s.words)) continue;
    if (!s.words.some((w) => PRONOUNS.has(w))) continue;
    const uniqueWho = [...new Map(s.who.map((x) => [x.id, x])).values()];
    if (uniqueWho.length !== 1) continue;
    const subject = uniqueWho[0]!;
    for (const j of [i - 1, i + 1]) {
      const neighbour = sentences[j];
      if (!neighbour) continue;
      for (const other of new Map(neighbour.who.map((x) => [x.id, x])).values()) {
        if (other.id === subject.id) continue;
        const key = `${subject.id}|${other.id}|${normalise(s.text)}|${normalise(neighbour.text)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          sentence: s.text,
          anchor: neighbour.text,
          chunkId: s.chunkId,
          locator: s.locator,
          fromId: subject.id,
          fromName: subject.name,
          toId: other.id,
          toName: other.name,
        });
      }
    }
  }
  return out;
}

export interface TieHint {
  id: number;
  projectId: number;
  fromName: string;
  toName: string;
  kind: string;
  evidence: string;
  sourceRefs: { source: string; locator: string; chunk?: number }[];
  status: string;
  note: string;
  createdAt: string;
  locator: string;
}

/** A hint name must look like a name, not a sentence or a stopword list. */
function isHintName(name: string): boolean {
  const clean = name.trim();
  if (!clean || !/[a-z]/i.test(clean)) return false;
  if (clean.split(/\s+/).filter(Boolean).length > 6) return false;
  const words = normalise(clean).split(' ').filter(Boolean);
  return words.length > 0 && !words.every((word) => STOPWORDS.has(word));
}

/** A hint kind is a short, non-empty phrase. */
function isHintKind(kind: string): boolean {
  const clean = kind.trim();
  return clean.length > 1 && clean.length <= 40 && /[a-z]/i.test(clean) && !clean.includes('...');
}

/**
 * Keep a tie whose endpoints are not in the bank as a hint, never a relation.
 *
 * The row carries the original names, the attempted kind, the verbatim quote
 * and its refs. A duplicate key keeps the longer quote; it never creates an
 * entity and never promotes anything.
 */
export function captureTieHint(
  db: Db,
  projectId: number,
  hint: {
    fromName: string;
    toName: string;
    kind: string;
    quote: string;
    refs: { source: string; locator: string; chunk?: number }[];
  },
): boolean {
  const fromName = hint.fromName.trim();
  const toName = hint.toName.trim();
  const kind = hint.kind.trim();
  const quote = hint.quote.trim();
  if (!isHintName(fromName) || !isHintName(toName)) return false;
  if (fromName.toLowerCase() === toName.toLowerCase()) return false;
  if (!isHintKind(kind) || !quote) return false;
  const refs = Array.isArray(hint.refs) ? hint.refs : [];
  const inserted = db.run(
    `INSERT OR IGNORE INTO canon_tie_hint
       (project_id, from_name, to_name, kind, evidence, source_refs, status, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', '', ?)`,
    projectId,
    fromName,
    toName,
    kind,
    quote,
    toJson(refs),
    nowIso(),
  );
  if (inserted.changes > 0) return true;
  const updated = db.run(
    `UPDATE canon_tie_hint SET evidence = ?, source_refs = ?
      WHERE project_id = ? AND from_name = ? AND to_name = ? AND kind = ? AND length(?) > length(evidence)`,
    quote,
    toJson(refs),
    projectId,
    fromName,
    toName,
    kind,
    quote,
  );
  return updated.changes > 0;
}

/** Pending hints, read-only, newest last. */
export function listTieHints(
  db: Db,
  projectId: number,
  opts: { status?: string; limit?: number } = {},
): TieHint[] {
  const status = opts.status ?? 'pending';
  const limit = Math.max(1, Math.floor(opts.limit ?? 50));
  const rows = db.all<{
    id: number;
    project_id: number;
    from_name: string;
    to_name: string;
    kind: string;
    evidence: string;
    source_refs: string;
    status: string;
    note: string;
    created_at: string;
  }>(
    `SELECT id, project_id, from_name, to_name, kind, evidence, source_refs, status, note, created_at
       FROM canon_tie_hint WHERE project_id = ? AND status = ? ORDER BY id LIMIT ?`,
    projectId,
    status,
    limit,
  );
  return rows.map((row) => {
    const refs = fromJson<{ source?: unknown; locator?: unknown; chunk?: unknown }[]>(row.source_refs, []);
    const first = refs.find((ref) => ref && ref.locator !== undefined);
    return {
      id: row.id,
      projectId: row.project_id,
      fromName: row.from_name,
      toName: row.to_name,
      kind: row.kind,
      evidence: row.evidence,
      sourceRefs: refs as TieHint['sourceRefs'],
      status: row.status,
      note: row.note,
      createdAt: row.created_at,
      locator: String(first?.locator ?? ''),
    };
  });
}

export function countTieHints(db: Db, projectId: number, status = 'pending'): number {
  return db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_tie_hint WHERE project_id = ? AND status = ?',
    projectId,
    status,
  )?.n ?? 0;
}

/** A cheap "these two look like the same person" test for quarantine. */
export function looksAlike(a: string, b: string): { alike: boolean; reason: string } {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return { alike: false, reason: '' };
  if (ta[0] === tb[0] && ta.length > 1 && tb.length > 1) {
    return { alike: true, reason: 'same first name' };
  }
  const fa = ta[0]!;
  const fb = tb[0]!;
  if (fa.length >= 4 && fb.length >= 4 && (fa.startsWith(fb) || fb.startsWith(fa))) {
    return { alike: true, reason: 'one name starts with the other' };
  }
  return { alike: false, reason: '' };
}

/**
 * Merge entities that are the same thing under two names.
 *
 * Deterministic rules only, and the conservative ones first:
 *
 *  - the same name up to case, possessives and a plural ("Dursley" and
 *    "Dursleys") is merged;
 *  - a shorter name whose every word is in a longer name ("Harry" and "Harry
 *    Potter") is merged only when the two are never speakers in the same
 *    passage, because two people in a scene keep their names distinct;
 *  - anything that merely looks similar goes to the quarantine list, which is
 *    returned and never merged. A wrong merge invents a person.
 */
/**
 * Fold one entity into another: aliases, relations, facts, tie notes, then
 * delete.
 *
 * Shared by the rule-based merge and the quarantine judge. The judge may
 * only confirm into this path, never invent around it.
 *
 * Tie notes are audit records, so a merge carries them to the survivor rather
 * than letting the entity delete cascade them away. An exact key collision
 * keeps the resolved note and copies its ruling over a pending duplicate.
 */
export interface MergeTieNoteCounts {
  /** Notes re-pointed to the survivor. */
  moved: number;
  /** Incoming notes deleted because the same key already existed. */
  collapsed: number;
  /** Pending notes whose two endpoints both collapsed to the survivor. */
  droppedSelf: number;
  /** Resolved self-notes kept for audit, re-pointed to the survivor. */
  keptSelf: number;
}

export function mergeEntityPair(
  db: Db,
  projectId: number,
  keep: CanonEntity,
  drop: CanonEntity,
): MergeTieNoteCounts {
  const noteCounts: MergeTieNoteCounts = { moved: 0, collapsed: 0, droppedSelf: 0, keptSelf: 0 };
  db.transaction(() => {
    const aliases = [...keep.aliases, drop.name, ...drop.aliases].filter(
      (al, i, arr) =>
        al.toLowerCase() !== keep.name.toLowerCase() &&
        arr.findIndex((x) => x.toLowerCase() === al.toLowerCase()) === i,
    );
    db.run(
      'UPDATE canon_entity SET aliases = ?, summary = ?, role = ?, status = ?, mentions = mentions + ?, updated_at = ? WHERE id = ?',
      toJson(aliases),
      keep.summary || drop.summary,
      keep.role || drop.role,
      keep.status || drop.status,
      drop.mentions,
      nowIso(),
      keep.id,
    );
    // Move relations over, and drop the ones that would now be duplicates.
    const rels = db.all<{ id: number; from_entity: number; to_entity: number; kind: string; description: string; evidence: string; review_status: string }>(
      'SELECT id, from_entity, to_entity, kind, description, evidence, review_status FROM canon_relation WHERE project_id = ? AND (from_entity = ? OR to_entity = ?)',
      projectId,
      drop.id,
      drop.id,
    );
    for (const r of rels) {
      const from = r.from_entity === drop.id ? keep.id : r.from_entity;
      const to = r.to_entity === drop.id ? keep.id : r.to_entity;
      if (from === to) {
        // A tie to self proves merging went too far for this row, but a
        // human-confirmed row is parked for review, never silently dropped.
        if (r.review_status === 'user_confirmed') {
          recordRuling(db, projectId, {
            relationId: r.id,
            role: 'appeal',
            actor: 'guard',
            standard: 'merge',
            fromStatus: 'user_confirmed',
            toStatus: 'needs_review',
            basis: 'merge collapsed the pair to one entity',
            quote: r.evidence,
          });
          db.run("UPDATE canon_relation SET review_status = 'needs_review' WHERE id = ?", r.id);
        } else {
          recordRuling(db, projectId, {
            relationId: r.id,
            role: 'removal',
            actor: 'guard',
            standard: 'merge',
            fromStatus: r.review_status,
            toStatus: 'merged',
            basis: 'merge collapsed the pair to one entity',
            quote: r.evidence,
          });
          db.run('DELETE FROM canon_relation WHERE id = ?', r.id);
        }
        continue;
      }
      const existing = db.get<{ id: number }>(
        'SELECT id FROM canon_relation WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND kind = ?',
        projectId,
        from,
        to,
        r.kind,
      );
      if (existing) {
        db.run('DELETE FROM canon_relation WHERE id = ?', r.id);
      } else {
        db.run('UPDATE canon_relation SET from_entity = ?, to_entity = ? WHERE id = ?', from, to, r.id);
      }
    }
    db.run('UPDATE canon_fact SET subject = ? WHERE project_id = ? AND subject = ?', keep.name, projectId, drop.name);
    // Carry tie notes to the survivor before the entity delete. The FK is
    // ON DELETE CASCADE, so leaving them attached would destroy audit rows.
    const notes = db.all<{
      id: number;
      from_entity: number;
      to_entity: number;
      attempted_kind: string;
      status: string;
      ruling: string;
      ruled_at: string;
    }>(
      'SELECT id, from_entity, to_entity, attempted_kind, status, ruling, ruled_at FROM canon_tie_note WHERE project_id = ? AND (from_entity = ? OR to_entity = ?) ORDER BY id',
      projectId,
      drop.id,
      drop.id,
    );
    for (const note of notes) {
      const from = note.from_entity === drop.id ? keep.id : note.from_entity;
      const to = note.to_entity === drop.id ? keep.id : note.to_entity;
      const existing = db.get<{ id: number; status: string }>(
        'SELECT id, status FROM canon_tie_note WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND attempted_kind = ? AND id <> ?',
        projectId,
        from,
        to,
        note.attempted_kind,
        note.id,
      );
      if (existing) {
        if (note.status === 'resolved' && existing.status !== 'resolved') {
          db.run(
            "UPDATE canon_tie_note SET status = 'resolved', ruling = ?, ruled_at = ? WHERE id = ?",
            note.ruling,
            note.ruled_at,
            existing.id,
          );
        }
        db.run('DELETE FROM canon_tie_note WHERE id = ?', note.id);
        noteCounts.collapsed++;
        continue;
      }
      if (from === to) {
        if (note.status === 'resolved') {
          db.run('UPDATE canon_tie_note SET from_entity = ?, to_entity = ? WHERE id = ?', from, to, note.id);
          noteCounts.keptSelf++;
        } else {
          db.run('DELETE FROM canon_tie_note WHERE id = ?', note.id);
          noteCounts.droppedSelf++;
        }
        continue;
      }
      db.run('UPDATE canon_tie_note SET from_entity = ?, to_entity = ? WHERE id = ?', from, to, note.id);
      noteCounts.moved++;
    }
    db.run('DELETE FROM canon_entity WHERE id = ?', drop.id);
  });
  return noteCounts;
}

/**
 * Persist quarantine pairs for later judgment. Idempotent: reruns add only
 * genuinely new pairs. Never touches merge behavior.
 */
export function persistQuarantine(
  db: Db,
  projectId: number,
  quarantined: QuarantinedAlias[],
): { written: number; skipped: number } {
  let written = 0;
  let skipped = 0;
  const now = nowIso();
  for (const q of quarantined) {
    const r = db.run(
      `INSERT OR IGNORE INTO quarantine_alias (project_id, name, candidate, reason, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      projectId,
      q.name,
      q.candidate,
      q.reason,
      now,
    );
    if (r.changes) written++;
    else skipped++;
  }
  return { written, skipped };
}

export function mergeCanonEntities(
  db: Db,
  projectId: number,
): { merged: string[]; quarantined: QuarantinedAlias[] } {
  const merged: string[] = [];
  const quarantined: QuarantinedAlias[] = [];
  const speakers = speakerChunksByEntity(db, projectId);
  const vetoed = new Set<string>();

  for (let guard = 0; guard < 200; guard++) {
    const entities = listEntities(db, projectId);
    if (entities.length < 2) break;

    let pair: { keep: CanonEntity; drop: CanonEntity } | null = null;
    outer: for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const a = entities[i]!;
        const b = entities[j]!;
        // A person and a place can share a name; they are not the same thing.
        if (a.kind !== b.kind) continue;
        const relation = nameRelation(a.name, b.name);
        if (!relation) continue;
        if (relation === 'containment' && sharedSpeakerScene(speakers, a.id, b.id)) {
          vetoed.add(quarantineKey(a.name, b.name));
          continue;
        }
        const keep = a.name.length >= b.name.length ? a : b;
        const drop = keep === a ? b : a;
        pair = { keep, drop };
        break outer;
      }
    }
    if (!pair) break;

    const { keep, drop } = pair;
    mergeEntityPair(db, projectId, keep, drop);
    merged.push(`${drop.name} -> ${keep.name}`);
  }

  // What is left that looks like a duplicate but was not merged. This is a
  // list for a person (or a model asked later) to judge, not an edit.
  const remaining = listEntities(db, projectId);
  const seen = new Set<string>();
  for (let i = 0; i < remaining.length; i++) {
    for (let j = i + 1; j < remaining.length; j++) {
      const a = remaining[i]!;
      const b = remaining[j]!;
      if (a.kind !== b.kind) continue;
      const relation = nameRelation(a.name, b.name);
      const key = quarantineKey(a.name, b.name);
      if (seen.has(key)) continue;
      if (relation === 'containment') {
        seen.add(key);
        quarantined.push({
          name: a.name,
          candidate: b.name,
          reason: vetoed.has(key) ? 'both speak in the same passage' : 'containment not confirmed',
        });
        continue;
      }
      if (relation) continue;
      const alike = looksAlike(a.name, b.name);
      if (!alike.alike) continue;
      seen.add(key);
      quarantined.push({ name: a.name, candidate: b.name, reason: alike.reason });
    }
  }

  return { merged, quarantined: quarantined.slice(0, 100) };
}

function quarantineKey(a: string, b: string): string {
  return [canonicalName(a), canonicalName(b)].sort().join(' :: ');
}

export interface QuarantineRuling {
  name: string;
  candidate: string;
  /** Terminal verdict: merged, ruled different, or skipped with a reason. */
  verdict: 'merged' | 'ruled' | 'skipped' | 'pending';
  reason: string;
  quote: string;
}

const JUDGE_SYSTEM =
  'For each pair answer same:true/false with the exact quote proving sameness. ' +
  'No quote, no merge. Reply JSON only: {rulings:[{name, candidate, same, quote}]}.';

/** Evidence an entity brings to its quarantine hearing: quote + passages. */
function entityDossier(db: Db, projectId: number, entity: CanonEntity): { evidence: string; chunks: ChunkRow[] } {
  const chunks: ChunkRow[] = [];
  for (const ref of entity.sourceRefs) {
    if (chunks.length >= 2) break;
    if (typeof ref.chunk !== 'number') continue;
    const row = db.get<ChunkRow>(
      `SELECT c.id, c.seq, c.heading, c.locator, c.text, s.title AS source_title, s.path, c.source_id
       FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
       WHERE c.id = ? AND c.project_id = ?`,
      ref.chunk,
      projectId,
    );
    if (row) chunks.push(row);
  }
  return { evidence: entity.evidence, chunks };
}

/**
 * Does the quote appear in either entity's evidence or passages?
 *
 * verifySpan is the only checker for passages; a normalized substring hit in
 * recorded evidence counts the same way. Anything else is unproven.
 */
function quoteSupported(
  quote: string,
  a: { evidence: string; chunks: ChunkRow[] },
  b: { evidence: string; chunks: ChunkRow[] },
): boolean {
  const needle = normalise(quote);
  if (!needle) return false;
  for (const entity of [a, b]) {
    if (entity.evidence && normalise(entity.evidence).includes(needle)) return true;
    for (const chunk of entity.chunks) {
      const others = entity.chunks.filter((c) => c.id !== chunk.id);
      if (verifySpan(quote, chunk, others).status !== 'dropped') return true;
    }
  }
  return false;
}

/**
 * Rule on quarantined nickname pairs, one model call for the batch.
 *
 * same:true merges ONLY with a verifying quote and no co-speaker veto — the
 * veto overrules the model, always. Application reuses mergeEntityPair, so a
 * confirmed pair merges exactly like a rule-based one. Anything uncertain
 * stays pending for a later run; judged outcomes are terminal.
 */
export async function judgeQuarantine(
  llm: LlmClient,
  db: Db,
  projectId: number,
  opts: { maxPairs?: number } = {},
): Promise<{ rulings: QuarantineRuling[]; checked: number; pending: number }> {
  const maxPairs = Math.max(1, opts.maxPairs ?? 20);
  const pending = db.all<{ name: string; candidate: string; reason: string }>(
    'SELECT name, candidate, reason FROM quarantine_alias WHERE project_id = ? AND status = ? ORDER BY id LIMIT ?',
    projectId,
    'pending',
    maxPairs,
  );
  const rulings: QuarantineRuling[] = [];
  const remaining = (): number =>
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM quarantine_alias WHERE project_id = ? AND status = 'pending'",
      projectId,
    )?.n ?? 0;
  if (!pending.length) return { rulings, checked: 0, pending: 0 };

  const settle = (
    name: string,
    candidate: string,
    verdict: QuarantineRuling['verdict'],
    reason: string,
    quote = '',
  ): void => {
    db.run(
      'UPDATE quarantine_alias SET status = ?, ruling = ?, ruled_at = ? WHERE project_id = ? AND name = ? AND candidate = ?',
      verdict === 'pending' ? 'pending' : verdict,
      verdict === 'pending' ? '' : reason,
      verdict === 'pending' ? '' : nowIso(),
      projectId,
      name,
      candidate,
    );
    rulings.push({ name, candidate, verdict, reason, quote });
  };

  // Resolve both names to live entities first: renames and deletions since
  // quarantining end the question without spending a model call.
  const live = new Map<string, CanonEntity[]>();
  for (const row of listEntities(db, projectId)) {
    live.set(row.name, [...(live.get(row.name) ?? []), row]);
  }
  const speakers = speakerChunksByEntity(db, projectId);
  const judged: { name: string; candidate: string; dossier: string }[] = [];
  const skippedEarly: { name: string; candidate: string; reason: string }[] = [];
  for (const pair of pending) {
    const a = live.get(pair.name) ?? [];
    const b = live.get(pair.candidate) ?? [];
    if (a.length !== 1 || b.length !== 1) {
      skippedEarly.push({ ...pair, reason: 'ambiguous-names' });
      continue;
    }
    if (a[0]!.kind !== b[0]!.kind) {
      skippedEarly.push({ ...pair, reason: 'kind-changed' });
      continue;
    }
    const da = entityDossier(db, projectId, a[0]!);
    const dbb = entityDossier(db, projectId, b[0]!);
    const lines = [
      `Pair: ${pair.name} / ${pair.candidate} (${pair.reason})`,
      `${pair.name}: ${da.evidence || '(no recorded evidence)'}`,
      ...da.chunks.map((q, i) => `  passage ${i + 1} (${q.locator}): ${truncate(q.text, 600)}`),
      `${pair.candidate}: ${dbb.evidence || '(no recorded evidence)'}`,
      ...dbb.chunks.map((q, i) => `  passage ${i + 1} (${q.locator}): ${truncate(q.text, 600)}`),
    ];
    judged.push({ name: pair.name, candidate: pair.candidate, dossier: lines.join('\n') });
  }
  for (const s of skippedEarly) {
    settle(s.name, s.candidate, 'skipped', s.reason);
  }
  if (!judged.length) return { rulings, checked: 0, pending: remaining() };

  let verdicts = new Map<string, { same: boolean; quote: string }>();
  try {
    const res = await llm.chat({
      system: JUDGE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: judged.map((j) => j.dossier).join('\n\n---\n\n'),
        },
      ],
      temperature: 0.0,
      maxTokens: 2000,
    });
    const parsed = extractJson<{ rulings?: unknown }>(res.text);
    if (Array.isArray(parsed?.rulings)) {
      for (const raw of parsed.rulings) {
        const item = raw as { name?: unknown; candidate?: unknown; same?: unknown; quote?: unknown };
        if (typeof item?.name !== 'string' || typeof item?.candidate !== 'string') continue;
        if (typeof item.same !== 'boolean') continue;
        verdicts.set(`${item.name}::${item.candidate}`, {
          same: item.same,
          quote: typeof item.quote === 'string' ? item.quote : '',
        });
      }
    }
  } catch {
    return { rulings, checked: 0, pending: remaining() };
  }
  if (!verdicts.size) return { rulings, checked: judged.length, pending: remaining() };

  for (const j of judged) {
    const verdict = verdicts.get(`${j.name}::${j.candidate}`);
    if (!verdict) continue; // Unanswered pairs stay pending: fail-open per pair.
    const a = live.get(j.name)![0]!;
    const b = live.get(j.candidate)![0]!;
    if (!verdict.same) {
      settle(j.name, j.candidate, 'ruled', 'different');
      continue;
    }
    if (!quoteSupported(verdict.quote, entityDossier(db, projectId, a), entityDossier(db, projectId, b))) {
      settle(j.name, j.candidate, 'skipped', 'unproven', verdict.quote);
      continue;
    }
    if (sharedSpeakerScene(speakers, a.id, b.id)) {
      settle(j.name, j.candidate, 'skipped', 'vetoed', verdict.quote);
      continue;
    }
    const keep = a.name.length >= b.name.length ? a : b;
    const drop = keep === a ? b : a;
    mergeEntityPair(db, projectId, keep, drop);
    settle(j.name, j.candidate, 'merged', `${drop.name} -> ${keep.name}`, verdict.quote);
    // Later pairs in this batch re-resolve: refresh the live map.
    live.set(
      keep.name,
      listEntities(db, projectId).filter((e) => e.name === keep.name),
    );
    live.set(drop.name, []);
  }
  return { rulings, checked: judged.length, pending: remaining() };
}

/* ------------------------------------------------- tie-note relabeling */

export interface TiePriority {
  id: number;
  fromName: string;
  toName: string;
  kind: string;
  evidence: string;
  locator: string;
  decision: PromoteDecision;
  /** Neighbouring sentence naming the endpoint the quote leaves to a
   * pronoun or role; empty when the quote stands alone. */
  anchor: string;
  /** One line: which pronoun-backtrack signals fired. */
  why: string;
  /** How many of the four fired: endpoints resolved, verbatim quote,
   * anchor present, pronoun/role reference. */
  score: number;
  /** All four fired: review this first. */
  pronounBacked: boolean;
}

/**
 * Pronoun-backtrack signal for one pending note. Read-only and model-free:
 * verbatim quote in the cited chunk, a neighbouring sentence naming an
 * endpoint the quote leaves unnamed, and a pronoun or role word in the
 * quote carrying that side. Ranking only — it never promotes or writes.
 */
function pronounSignal(args: {
  fromName: string;
  toName: string;
  fromAliases: string[];
  toAliases: string[];
  evidence: string;
  chunkText: string | null;
}): { anchor: string; why: string; score: number; pronounBacked: boolean } {
  const none = (why: string, score: number): { anchor: string; why: string; score: number; pronounBacked: boolean } =>
    ({ anchor: '', why, score, pronounBacked: false });
  if (!args.fromName.trim() || !args.toName.trim()) return none('endpoints unresolved', 0);
  let score = 1; // endpoints resolved
  if (!args.evidence.trim() || !args.chunkText || !normalise(args.chunkText).includes(normalise(args.evidence))) {
    return none('quote not verbatim in cited chunk', score);
  }
  score++; // verbatim quote
  const named = (name: string, aliases: string[], text: string): boolean =>
    nameMentionedExact(name, text) || aliases.some((a) => a.trim() !== '' && nameMentionedExact(a, text));
  const fromInQuote = named(args.fromName, args.fromAliases, args.evidence);
  const toInQuote = named(args.toName, args.toAliases, args.evidence);
  if (!fromInQuote && !toInQuote) {
    return none('quote names neither endpoint; nothing to backtrack', score);
  }
  const missing: Array<{ name: string; aliases: string[] }> = [];
  if (!fromInQuote) missing.push({ name: args.fromName, aliases: args.fromAliases });
  if (!toInQuote) missing.push({ name: args.toName, aliases: args.toAliases });
  if (missing.length === 0) {
    return none('quote names both endpoints; no backtrack needed', score);
  }
  const sentences = splitSentences(args.chunkText);
  const needle = normalise(args.evidence);
  const quoteIdx = sentences.findIndex((s) => {
    const n = normalise(s);
    return n.includes(needle) || (needle.includes(n) && n.length > 20);
  });
  const ordered: string[] = quoteIdx < 0
    ? sentences
    : [
      ...(quoteIdx > 0 ? [sentences[quoteIdx - 1]!] : []),
      ...(quoteIdx + 1 < sentences.length ? [sentences[quoteIdx + 1]!] : []),
      ...sentences.filter((_, i) => i !== quoteIdx && Math.abs(i - quoteIdx) > 1),
    ];
  let anchor = '';
  let anchoredName = '';
  for (const s of ordered) {
    if (normalise(s) === needle) continue;
    const hit = missing.find((m) => named(m.name, m.aliases, s));
    if (hit) {
      anchor = s.trim().replace(/\s+/g, ' ');
      anchoredName = hit.name;
      break;
    }
  }
  if (!anchor) {
    return none('no neighbouring sentence names the unnamed endpoint', score);
  }
  score++; // anchor present
  const tokens = new Set(needle.split(' ').filter(Boolean));
  const pronounHit = [...PRONOUNS].some((p) => tokens.has(p));
  let roleHit = false;
  if (!pronounHit) {
    for (const phrase of tiePhrases()) {
      if (!phrase.includes(' ') && tokens.has(phrase)) {
        roleHit = true;
        break;
      }
    }
  }
  if (!pronounHit && !roleHit) {
    return { anchor, why: `anchor names ${anchoredName} but the quote shows no pronoun/role reference`, score, pronounBacked: false };
  }
  score++; // pronoun/role reference
  const quoted = fromInQuote ? args.fromName : args.toName;
  return {
    anchor,
    why: `verbatim quote names ${quoted}; anchor names ${anchoredName}; quote refers to ${anchoredName} by ${pronounHit ? 'pronoun' : 'role'}`,
    score,
    pronounBacked: true,
  };
}

/**
 * Rank pending tie notes for human review.
 *
 * Read-only: no model calls and no status writes. Model agreement never
 * promotes a tie; the guard decides what a human sees first.
 */
export function prioritiseTieNotes(
  db: Db,
  projectId: number,
  opts: { limit?: number; afterId?: number } = {},
): TiePriority[] {
  const limit = Math.max(1, opts.limit ?? 50);
  const afterId = Math.max(0, opts.afterId ?? 0);
  const notes = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    attempted_kind: string;
    evidence: string;
    source_refs: string;
    from_name: string;
    from_aliases: string;
    to_name: string;
    to_aliases: string;
  }>(
    `SELECT n.id, n.from_entity, n.to_entity, n.attempted_kind, n.evidence, n.source_refs,
            fe.name AS from_name, fe.aliases AS from_aliases,
            te.name AS to_name, te.aliases AS to_aliases
       FROM canon_tie_note n
       JOIN canon_entity fe ON fe.id = n.from_entity
       JOIN canon_entity te ON te.id = n.to_entity
      WHERE n.project_id = ? AND n.status = 'pending' AND n.id > ?
      ORDER BY n.id`,
    projectId,
    afterId,
  );
  const out: TiePriority[] = [];
  // One index for the whole ranking pass.
  const index = commandRosterIndex(db, projectId);
  for (const note of notes) {
    let chunkText: string | null = null;
    let locator = '';
    try {
      const refs = JSON.parse(note.source_refs || '[]') as { chunk?: unknown }[];
      const chunkId = refs.find((ref) => Number.isFinite(Number(ref?.chunk)) && Number(ref?.chunk) > 0)?.chunk;
      if (chunkId) {
        const chunk = db.get<{ text: string; locator: string }>(
          'SELECT text, locator FROM canon_chunk WHERE id = ?',
          Number(chunkId),
        );
        chunkText = chunk?.text ?? null;
        locator = chunk?.locator ?? '';
      }
    } catch {
      chunkText = null;
    }
    const decision = canPromote(
      {
        fromId: note.from_entity,
        toId: note.to_entity,
        fromName: note.from_name,
        toName: note.to_name,
        fromAliases: strList(note.from_aliases),
        toAliases: strList(note.to_aliases),
        kind: note.attempted_kind,
        evidence: note.evidence,
        // A note carries no model confidence: it is a queue item, never a
        // claim that can clear the author's threshold.
        confidence: 0,
      },
      { db, projectId, chunkText, index },
    );
    const signal = pronounSignal({
      fromName: note.from_name,
      toName: note.to_name,
      fromAliases: strList(note.from_aliases),
      toAliases: strList(note.to_aliases),
      evidence: note.evidence,
      chunkText,
    });
    out.push({
      id: note.id,
      fromName: note.from_name,
      toName: note.to_name,
      kind: note.attempted_kind,
      evidence: note.evidence,
      locator,
      decision,
      anchor: signal.anchor,
      why: signal.why,
      score: signal.score,
      pronounBacked: signal.pronounBacked,
    });
  }
  return out
    .sort((a, b) =>
      (a.pronounBacked === b.pronounBacked ? 0 : a.pronounBacked ? -1 : 1) ||
      (a.decision.ok === b.decision.ok ? 0 : a.decision.ok ? -1 : 1) || a.id - b.id)
    .slice(0, limit);
}

export interface TieEvaluation {
  kept: number;
  parked: number;
  unproven: number;
  checked: number;
}

/**
 * Evaluate banked ties with understanding, not conditions.
 *
 * Lexical gates are cheap and blind: they drop what matches a word list and
 * wave through everything else, including wrong pairs on true quotes. This
 * pass asks the model one question per banked tie: does this sentence show
 * these two ARE this to each other, lastingly? Keep leaves the row; drop
 * removes it and parks a note for the relabeling pass, so a mislabeled but
 * real connection still gets its second chance. Malformed answers leave the
 * row untouched: fail-open, like every other batch judge here.
 */
export async function evaluateTies(
  db: Db,
  llm: LlmClient,
  projectId: number,
  opts: { maxTies?: number; afterId?: number; onProgress?: (message: string) => void } = {},
): Promise<TieEvaluation> {
  const maxTies = Math.max(1, opts.maxTies ?? 50);
  const afterId = Math.max(0, opts.afterId ?? 0);
  const rows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    description: string;
    evidence: string;
    source_refs: string;
    review_status: string;
    from_name: string;
    to_name: string;
  }>(
    `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.description, r.evidence,
            r.source_refs, r.review_status, fe.name AS from_name, te.name AS to_name
       FROM canon_relation r
       JOIN canon_entity fe ON fe.id = r.from_entity
       JOIN canon_entity te ON te.id = r.to_entity
      WHERE r.project_id = ? AND r.id > ? AND r.review_status != 'user_confirmed' ORDER BY r.id LIMIT ?`,
    projectId,
    afterId,
    maxTies,
  );
  let kept = 0;
  let parked = 0;
  let unproven = 0;
  const like = (s: string): string => s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  for (const row of rows) {
    opts.onProgress?.(`${row.from_name} / ${row.to_name} (${row.kind})`);
    const doings = db.all<{ title: string; summary: string }>(
      `SELECT title, summary FROM canon_event WHERE project_id = ? AND participants LIKE ? ESCAPE '\\' AND participants LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 5`,
      projectId,
      `%${like(row.from_name)}%`,
      `%${like(row.to_name)}%`,
    );
    const context = doings.length
      ? `WHAT THEY DID TOGETHER:\n${doings.map((d) => `- ${d.title}${d.summary ? `: ${d.summary.slice(0, 140)}` : ''}`).join('\n')}\n\n`
      : '';
    // The full dossier for the pair: every banked claim about these two
    // (rival labels included), both entity files, open identity questions,
    // and the passage the quote came from — not just the quote in isolation.
    // A judge shown one row and one line guesses; a judge shown the file rules.
    const pairRows = db.all<{ kind: string; evidence: string; review_status: string }>(
      `SELECT kind, evidence, review_status FROM canon_relation WHERE project_id = ? AND id != ?
       AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?)) ORDER BY id LIMIT 8`,
      projectId, row.id, row.from_entity, row.to_entity, row.to_entity, row.from_entity,
    );
    const dossierPair = pairRows.length
      ? `OTHER BANKED CLAIMS FOR THIS PAIR:\n${pairRows.map((o) => `- ${o.kind} [${o.review_status}]: "${truncate(o.evidence, 160)}"`).join('\n')}\n\n`
      : '';
    const dossierEnts = db.all<{ name: string; summary: string; aliases: string }>(
      'SELECT name, summary, aliases FROM canon_entity WHERE project_id = ? AND id IN (?, ?)',
      projectId, row.from_entity, row.to_entity,
    );
    const dossierFiles = dossierEnts.length
      ? `ENTITY FILES:\n${dossierEnts.map((e) => {
        let aliases: string[] = [];
        try { aliases = JSON.parse(e.aliases || '[]') as string[]; } catch { aliases = []; }
        const also = aliases.length ? ` (also filed as: ${aliases.join(', ')})` : '';
        return `- ${e.name}${also}: ${truncate(e.summary || '(no summary)', 200)}`;
      }).join('\n')}\n\n`
      : '';
    const dossierQuar = db.all<{ name: string; candidate: string; reason: string }>(
      `SELECT name, candidate, reason FROM quarantine_alias WHERE project_id = ? AND status = 'pending'
       AND (name IN (?, ?) OR candidate IN (?, ?)) LIMIT 5`,
      projectId, row.from_name, row.to_name, row.from_name, row.to_name,
    );
    const dossierIdentity = dossierQuar.length
      ? `OPEN IDENTITY QUESTIONS (unresolved — do not assume either way):\n${dossierQuar.map((q) => `- ${q.name} ~ ${q.candidate} (${q.reason})`).join('\n')}\n\n`
      : '';
    let dossierPassage = '';
    try {
      const refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[];
      const ref = refs.find((x) => Number.isFinite(Number(x?.chunk)) && Number(x?.chunk) > 0);
      const chunkId = ref ? Number((ref as { chunk: number }).chunk) : NaN;
      if (Number.isFinite(chunkId)) {
        const ch = db.get<{ text: string; locator: string }>('SELECT text, locator FROM canon_chunk WHERE id = ?', chunkId);
        if (ch?.text) dossierPassage = `PASSAGE (the quote's home; the tie must be statable from it):\n${truncate(ch.text, 900)}\n\n`;
      }
    } catch { /* refs unparseable: judge works from the quote alone */ }
    let verdict = '';
    let reason = '';
    try {
      const res = await llm.chat({
        system:
          'You judge one banked tie against its whole file. Reply with JSON only: {"verdict": "keep" or "drop", "reason": "one short phrase"}. Start with {. No other words.',
        messages: [{
          role: 'user',
          content:
            `PAIR: ${row.from_name} / ${row.to_name}\nLABEL: ${row.kind}\n` +
            `SENTENCE: ${row.description || row.kind}\nQUOTE: ${row.evidence}\n${dossierPair}${dossierFiles}${dossierIdentity}${dossierPassage}${context}` +
            `Does the file show these two ARE this to each other, lastingly? A feeling about a third person, a wrong pair, a momentary interaction, an open identity question, or a passage that never states the tie means drop. Conflicting labels for the same pair: keep at most the one the passage states.`,
        }],
        temperature: 0.1,
        maxTokens: 200,
      });
      const raw = (res.text ?? '').replace(/```json|```/g, '');
      const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as { verdict?: unknown; reason?: unknown };
      verdict = String(parsed.verdict ?? '').trim().toLowerCase();
      reason = String(parsed.reason ?? '').trim().slice(0, 140);
    } catch {
      unproven++;
      continue;
    }
    if (verdict !== 'keep' && verdict !== 'drop') {
      unproven++;
      continue;
    }
    if (verdict === 'keep') {
      kept++;
      continue;
    }
    // Flag, don't delete: the row stays visible with its badge until a human
    // or the relabeling pass rules. The parked note carries the case.
    db.transaction(() => {
      db.run(
        "UPDATE canon_relation SET review_status = 'needs_review' WHERE id = ? AND project_id = ?",
        row.id,
        projectId,
      );
      recordRuling(db, projectId, {
        relationId: row.id,
        role: 'appeal',
        actor: 'assessor',
        standard: 'dossier',
        fromStatus: row.review_status,
        toStatus: 'needs_review',
        basis: `evaluate: ${reason || 'drop'}`,
        quote: row.evidence,
      });
      persistTieNote(db, projectId, row.from_entity, row.to_entity, row.kind, 'evaluation', row.evidence, row.source_refs, reason || 'drop');
    });
    parked++;
  }
  const out = { kept, parked, unproven, checked: rows.length };
  writeAuditNote(projectId, 'evaluate', [
    `ties checked: ${out.checked}`,
    `kept: ${out.kept}, parked: ${out.parked}, untouched: ${out.unproven}`,
  ], db);
  return out;
}

/** The assessment call: the pair and kind are fixed; only the support is judged. */
export const ASSESS_RELATIONS_SYSTEM = `You assess one existing relationship claim. The pair and the kind are fixed; do not replace them and do not look for a different relationship.

Reply with JSON only:
{"names_both": false, "other_person": "named|pronoun|role|absent",
 "asserted": true, "hedge": "certain|hedged|doubted|denied",
 "kind_fit": "yes|partly|no", "strength": 0.7, "why": "one sentence"}

- names_both: does the quote itself name both people?
- other_person: how the other side is named in the quote (named, pronoun, role, absent).
- asserted: does the quote state the claim, or only suggest it?
- hedge: certain, hedged, doubted or denied.
- kind_fit: is the kind right for what the sentence says (yes, partly, no)?
- why: one sentence, stored for audit, never parsed.
${ASSESSMENT_QUESTIONS}
- No prose outside the JSON.`;

export type AssessSkip =
  | 'no-quote'
  | 'already-assessed'
  | 'entity-unresolved'
  | 'quote-not-verbatim'
  | 'model-error';

export interface AssessRow {
  id: number;
  fromName: string;
  toName: string;
  kind: string;
  reviewStatus: string;
  strength: number;
}

export interface AssessResult {
  rows: AssessRow[];
  assessed: number;
  skipped: Record<AssessSkip, number>;
  bands: Record<string, number>;
  threshold: number;
  aboveThreshold: number;
  aboveByStatus: Record<string, number>;
  userConfirmedAverage: number | null;
  wrote: number;
}

export interface AssessOptions {
  limit?: number;
  /** Report cutoff; default 0.7. Never gates a write. */
  minConfidence?: number;
  write?: boolean;
  refresh?: boolean;
  onProgress?: (message: string) => void;
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

/**
 * Score the rows already in the bank against their own quotes.
 *
 * One model call per existing claim; the pair and kind are passed in and never
 * re-derived. Dry run by default. With `write`, the assessment is appended to
 * supporting_evidence and the strength replaces `confidence`; `review_status`
 * is deliberately untouched.
 */
export async function assessRelations(
  db: Db,
  llm: LlmClient,
  projectId: number,
  opts: AssessOptions = {},
): Promise<AssessResult> {
  const threshold = clamp01(opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE);
  const bands: Record<string, number> = {
    '0.0-0.5': 0,
    '0.5-0.6': 0,
    '0.6-0.7': 0,
    '0.7-0.8': 0,
    '0.8-0.9': 0,
    '0.9-1.0': 0,
  };
  const skipped: Record<AssessSkip, number> = {
    'no-quote': 0,
    'already-assessed': 0,
    'entity-unresolved': 0,
    'quote-not-verbatim': 0,
    'model-error': 0,
  };
  const result: AssessResult = {
    rows: [],
    assessed: 0,
    skipped,
    bands,
    threshold,
    aboveThreshold: 0,
    aboveByStatus: {},
    userConfirmedAverage: null,
    wrote: 0,
  };
  // Empty quotes are not claims to score; they are counted, then excluded.
  skipped['no-quote'] =
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ? AND trim(evidence) = ''",
      projectId,
    )?.n ?? 0;

  const limit = opts.limit === undefined ? null : Math.max(1, Math.floor(opts.limit));
  const rows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    evidence: string;
    source_refs: string;
    anchor_evidence: string;
    review_status: string;
    supporting_evidence: string;
    from_name: string;
    to_name: string;
  }>(
    `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.evidence, r.source_refs,
            r.anchor_evidence, r.review_status, r.supporting_evidence,
            a.name AS from_name, b.name AS to_name
       FROM canon_relation r
       LEFT JOIN canon_entity a ON a.id = r.from_entity
       LEFT JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND trim(r.evidence) <> ''
      ORDER BY r.id${limit === null ? '' : ' LIMIT ?'}`,
    ...(limit === null ? [projectId] : [projectId, limit]),
  );

  const statusValues = new Map<string, number[]>();
  for (const row of rows) {
    opts.onProgress?.(`${row.from_name} / ${row.to_name} (${row.kind})`);
    if (!opts.refresh && storedAssessment(row.supporting_evidence)) {
      skipped['already-assessed']++;
      continue;
    }
    // Both endpoints must still be in the roster.
    const entities = db.all<{ id: number }>(
      'SELECT id FROM canon_entity WHERE project_id = ? AND id IN (?, ?)',
      projectId,
      row.from_entity,
      row.to_entity,
    );
    if (entities.length !== 2) {
      skipped['entity-unresolved']++;
      continue;
    }
    const chunkId = firstChunkOf(row.source_refs);
    const chunkText = chunkId === undefined
      ? null
      : pageEvidenceText(db, chunkId) ??
        db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', chunkId)?.text ??
        null;
    if (!chunkText || !normalise(chunkText).includes(normalise(row.evidence))) {
      skipped['quote-not-verbatim']++;
      continue;
    }

    let parsed: Record<string, unknown> = {};
    try {
      const res = await llm.chat({
        system: ASSESS_RELATIONS_SYSTEM,
        messages: [{
          role: 'user',
          content:
            `PAIR: ${row.from_name} / ${row.to_name}\n` +
            `KIND: ${row.kind}\n` +
            `QUOTE: ${row.evidence}\n` +
            `ANCHOR: ${row.anchor_evidence.trim() || '(none)'}\n\n` +
            'How strongly does the quote support this claim, for these two people, as this kind?',
        }],
        temperature: 0.1,
        maxTokens: 300,
        format: 'json',
      });
      parsed = extractJson<Record<string, unknown>>(res.text ?? '') ?? {};
    } catch {
      skipped['model-error']++;
      continue;
    }

    const strength = clamp01(Number(parsed.strength ?? parsed.confidence));
    const assessment = readClaimAssessment({ ...parsed, strength });
    result.rows.push({
      id: row.id,
      fromName: row.from_name,
      toName: row.to_name,
      kind: row.kind,
      reviewStatus: row.review_status,
      strength,
    });
    result.assessed++;
    const status = row.review_status || 'unknown';
    const values = statusValues.get(status) ?? [];
    values.push(strength);
    statusValues.set(status, values);
    if (strength >= threshold) {
      result.aboveThreshold++;
      result.aboveByStatus[status] = (result.aboveByStatus[status] ?? 0) + 1;
    }
    bands[
      strength >= 0.9 ? '0.9-1.0'
      : strength >= 0.8 ? '0.8-0.9'
      : strength >= 0.7 ? '0.7-0.8'
      : strength >= 0.6 ? '0.6-0.7'
      : strength >= 0.5 ? '0.5-0.6'
      : '0.0-0.5'
    ]++;
    if (opts.write) {
      db.transaction(() => {
        db.run(
          'UPDATE canon_relation SET confidence = ?, supporting_evidence = ? WHERE id = ? AND project_id = ?',
          strength,
          appendAssessment(row.supporting_evidence, assessment),
          row.id,
          projectId,
        );
        recordRuling(db, projectId, {
          relationId: row.id,
          role: 'verdict',
          actor: 'assessor',
          standard: 'assessment',
          fromStatus: row.review_status,
          toStatus: row.review_status,
          basis: `strength ${strength.toFixed(2)}: ${assessment.why}`,
          quote: row.evidence,
        });
      });
      result.wrote++;
    }
  }

  const confirmed = statusValues.get('user_confirmed') ?? [];
  result.userConfirmedAverage = confirmed.length
    ? Number((confirmed.reduce((sum, value) => sum + value, 0) / confirmed.length).toFixed(3))
    : null;
  return result;
}

/* ------------------------------------------------------- relabel claims */

export interface RelabelResult {
  checked: number;
  changed: number;
  skipped: Record<'none' | 'invalid' | 'duplicate' | 'same' | 'no-chunk' | 'model-error', number>;
}

/**
 * Ask the model for the relationship a claim's own quote states, and replace a
 * wrong label. The pair is fixed; only the label moves. Code checks the answer
 * is a closed kind that does not already exist for the pair. Writes a relabel
 * ruling in the same transaction as the update.
 */
export async function relabelRelations(
  db: Db,
  llm: LlmClient,
  projectId: number,
  opts: { ids?: number[]; limit?: number; write?: boolean; onProgress?: (message: string) => void } = {},
): Promise<RelabelResult> {
  const ids = opts.ids?.length ? opts.ids : null;
  const rows = db.all<{
    id: number;
    kind: string;
    evidence: string;
    source_refs: string;
    review_status: string;
    from_entity: number;
    to_entity: number;
    from_name: string;
    to_name: string;
  }>(
    `SELECT r.id, r.kind, r.evidence, r.source_refs, r.review_status, r.from_entity, r.to_entity,
            a.name AS from_name, b.name AS to_name
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND trim(r.evidence) <> ''
        AND r.review_status IN ('attested','accepted','needs_review')
        ${ids ? `AND r.id IN (${ids.map(() => '?').join(',')})` : ''}
      ORDER BY r.id
      ${opts.limit && ids === null ? 'LIMIT ?' : ''}`,
    projectId,
    ...(ids ?? []),
    ...(opts.limit && ids === null ? [Math.max(1, Math.floor(opts.limit))] : []),
  );
  const result: RelabelResult = {
    checked: rows.length,
    changed: 0,
    skipped: { none: 0, invalid: 0, duplicate: 0, same: 0, 'no-chunk': 0, 'model-error': 0 },
  };
  for (const row of rows) {
    opts.onProgress?.(`${row.from_name} / ${row.to_name} (${row.kind})`);
    let chunkText: string | null = null;
    try {
      const refs = JSON.parse(row.source_refs || '[]') as { chunk?: unknown }[];
      const chunkId = refs.find((ref) => Number.isFinite(Number(ref?.chunk)) && Number(ref?.chunk) > 0)?.chunk;
      if (chunkId !== undefined) {
        chunkText =
          pageEvidenceText(db, Number(chunkId)) ??
          db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', Number(chunkId))?.text ??
          null;
      }
    } catch {
      chunkText = null;
    }
    if (!chunkText) {
      result.skipped['no-chunk']++;
      continue;
    }
    let parsed: { kind?: unknown; why?: unknown } = {};
    try {
      const res = await llm.chat({
        system:
          'You name one relationship between two people from a novel. The pair is fixed. ' +
          'Read the quote and the passage, then reply with JSON only: ' +
          `{"kind": one of [${CLOSED_ROLE_KINDS.join(', ')}]} or {"kind":"none"}. ` +
          'If the passage states a relationship between them, choose the closest kind; ' +
          'if it states none, reply none. No prose outside the JSON.',
        messages: [
          {
            role: 'user',
            content:
              `PAIR: ${row.from_name} / ${row.to_name}\n` +
              `CURRENT LABEL: ${row.kind}\n` +
              `QUOTE: ${row.evidence}\n` +
              `PASSAGE: ${truncate(chunkText, 900)}`,
          },
        ],
        format: 'json',
        temperature: 0.1,
        maxTokens: 120,
      });
      parsed = extractJson<{ kind?: unknown; why?: unknown }>(res.text ?? '') ?? {};
    } catch {
      result.skipped['model-error']++;
      continue;
    }
    const answer = String(parsed.kind ?? '').trim().toLowerCase();
    if (answer === 'none' || answer === '') {
      result.skipped.none++;
      continue;
    }
    const kind = canonicalKind(answer);
    if (!isClosedRoleKind(kind)) {
      result.skipped.invalid++;
      continue;
    }
    if (kind === canonicalKind(row.kind)) {
      result.skipped.same++;
      continue;
    }
    const duplicate = db.get<{ id: number }>(
      `SELECT id FROM canon_relation
        WHERE project_id = ? AND id != ? AND lower(kind) = ?
          AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?)) LIMIT 1`,
      projectId,
      row.id,
      kind,
      row.from_entity,
      row.to_entity,
      row.to_entity,
      row.from_entity,
    );
    if (duplicate) {
      result.skipped.duplicate++;
      continue;
    }
    result.changed++;
    if (!opts.write) continue;
    db.transaction(() => {
      db.run('UPDATE canon_relation SET kind = ? WHERE id = ? AND project_id = ?', kind, row.id, projectId);
      recordRuling(db, projectId, {
        relationId: row.id,
        role: 'appeal',
        actor: 'assessor',
        standard: 'relabel',
        fromStatus: row.review_status,
        toStatus: row.review_status,
        basis: `relabel ${row.kind} -> ${kind}${parsed.why ? `: ${String(parsed.why).slice(0, 120)}` : ''}`,
        quote: row.evidence,
      });
    });
  }
  return result;
}

/* ------------------------------------------------- timeline ↔ event join */

/**
 * Independent-window support behind every relation row.
 *
 * Rows asserting one triple from different passages corroborate each other;
 * the count caps at CORROBORATION_CAP, so support nudges display order and
 * never overrides proof. Read-only, computed from existing references.
 */
export function relationCorroboration(db: Db, projectId: number): Map<number, number> {
  const rows = db.all<{ id: number; from_entity: number; to_entity: number; kind: string; source_refs: string }>(
    'SELECT id, from_entity, to_entity, kind, source_refs FROM canon_relation WHERE project_id = ? ORDER BY id',
    projectId,
  );
  const chunks = new Map<string, Set<number>>();
  const chunkOf = new Map<number, number>();
  for (const row of rows) {
    const key = tripleKey(row.from_entity, row.to_entity, row.kind);
    const chunk = firstChunkOf(row.source_refs) ?? -1;
    chunkOf.set(row.id, chunk);
    if (!chunks.has(key)) chunks.set(key, new Set());
    chunks.get(key)!.add(chunk);
  }
  const out = new Map<number, number>();
  for (const row of rows) {
    const key = tripleKey(row.from_entity, row.to_entity, row.kind);
    out.set(row.id, Math.min(chunks.get(key)!.size, CORROBORATION_CAP));
  }
  return out;
}

export interface TriplePosting {
  tripleKey: string;
  fromId: number;
  toId: number;
  kind: string;
  chunkId: number;
  locator: string;
  seq: number | null;
}

/**
 * Triple-to-passage index from existing pointers, no new table.
 *
 * Every banked relation already carries its proving chunk in source_refs;
 * this inverts those pointers into per-triple postings with locators that
 * resolve. Unplaced rows (no chunk) produce no posting and stay invisible
 * to ranking. Read-only, deterministic by triple then chunk.
 * Code paths are bit-deterministic; LLM text excluded from comparison.
 */
export function triplePassages(db: Db, projectId: number): TriplePosting[] {
  const rows = db.all<{ from_entity: number; to_entity: number; kind: string; source_refs: string }>(
    'SELECT from_entity, to_entity, kind, source_refs FROM canon_relation WHERE project_id = ? ORDER BY id',
    projectId,
  );
  const locByChunk = new Map(
    db.all<{ id: number; locator: string; seq: number }>('SELECT id, locator, seq FROM canon_chunk WHERE project_id = ?', projectId)
      .map((c) => [c.id, c] as [number, { locator: string; seq: number }]),
  );
  const out: TriplePosting[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const key = tripleKey(r.from_entity, r.to_entity, r.kind);
    const chunkId = firstChunkOf(r.source_refs);
    if (chunkId === undefined) continue;
    const dedupe = `${key}:${chunkId}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const loc = locByChunk.get(chunkId);
    out.push({
      tripleKey: key,
      fromId: r.from_entity,
      toId: r.to_entity,
      kind: r.kind,
      chunkId,
      locator: loc?.locator ?? '',
      seq: loc?.seq ?? null,
    });
  }
  out.sort((a, b) => (a.tripleKey < b.tripleKey ? -1 : a.tripleKey > b.tripleKey ? 1 : a.chunkId - b.chunkId));
  return out;
}

/**
 * Frozen ordering for the tie view: verified-first (unverified invisible by
 * default), then corroboration desc (capped), density 1/claims desc, id asc.
 * Scope is project_id before ordering; atSeq narrows to story position when
 * given. Deterministic by construction.
 */
export function rankedRelations(
  db: Db,
  projectId: number,
  opts: { atSeq?: number; includeUnverified?: boolean; includeFlagged?: boolean; limit?: number } = {},
): CanonRelation[] {
  const all = listRelations(db, projectId);
  const cleared = opts.includeFlagged ? all : all.filter((r) => r.reviewStatus === 'accepted' || r.reviewStatus === 'user_confirmed');
  const verified = opts.includeUnverified ? cleared : cleared.filter((r) => r.evidence.trim().length > 0);
  const refs = new Map<number, string>();
  for (const row of db.all<{ id: number; source_refs: string }>(
    'SELECT id, source_refs FROM canon_relation WHERE project_id = ? ORDER BY id',
    projectId,
  )) refs.set(row.id, row.source_refs);
  const idChunk = new Map<number, number>();
  const chunkCounts = new Map<number, number>();
  for (const r of verified) {
    const chunk = firstChunkOf(refs.get(r.id) ?? '[]') ?? -1;
    idChunk.set(r.id, chunk);
    chunkCounts.set(chunk, (chunkCounts.get(chunk) ?? 0) + 1);
  }
  const seqByChunk = new Map(
    db.all<{ id: number; seq: number }>('SELECT id, seq FROM canon_chunk WHERE project_id = ?', projectId).map((c) => [c.id, c.seq] as [number, number]),
  );
  const scoped = opts.atSeq === undefined
    ? verified
    : verified.filter((r) => {
        const seq = seqByChunk.get(idChunk.get(r.id) ?? -1);
        return seq !== undefined && seq <= opts.atSeq!;
      });
  const ordered = rankRows(
    scoped.map((r) => ({ id: r.id, a: r.fromId, b: r.toId, kind: r.kind, evidence: r.evidence, chunkSeq: null })),
    chunkCounts,
    (row) => idChunk.get(row.id) ?? -1,
  );
  const order = new Map(ordered.map((o, i) => [o.id, i] as [number, number]));
  const out = scoped.slice().sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return typeof opts.limit === 'number' ? out.slice(0, Math.max(0, opts.limit)) : out;
}

function firstChunkOf(sourceRefs: string): number | undefined {
  try {
    const refs = JSON.parse(sourceRefs || '[]') as { chunk?: unknown }[];
    for (const ref of refs) {
      const id = Number(ref?.chunk);
      if (Number.isFinite(id) && id > 0) return id;
    }
  } catch {
    /* a malformed reference is simply no reference */
  }
  return undefined;
}

/**
 * Attach the book's timeline entries to the event index.
 *
 * The two tables describe the same moments from different passes: the lore
 * extraction writes `canon_timeline`, the event extraction writes
 * `canon_event`, and until now nothing joined them. A timeline entry is joined
 * to the nearest event from the same source, by passage order, and only when
 * that event is unambiguous: two candidates at the same distance are left
 * unlinked rather than guessed.
 *
 * Participants are then written into `canon_event_participant`, which the
 * graph already reads.
 */
export function linkTimelineToEvents(
  db: Db,
  projectId: number,
  opts: { maxChunkDistance?: number } = {},
): { linked: number; participants: number; unlinked: number } {
  const maxDistance = opts.maxChunkDistance ?? 2;

  // An event has no order of its own; take it from the passage it came from,
  // so ordering and proximity mean the same thing on both sides.
  db.run(
    `UPDATE canon_event
        SET seq = (SELECT c.seq FROM canon_chunk c WHERE c.id = canon_event.chunk_id)
      WHERE project_id = ? AND chunk_id IS NOT NULL AND seq = 0`,
    projectId,
  );

  const events = db.all<{
    id: number;
    chunk_id: number;
    chunk_seq: number;
    source_id: number;
    participants: string;
  }>(
    `SELECT e.id, e.chunk_id, e.participants, c.seq AS chunk_seq, c.source_id
       FROM canon_event e JOIN canon_chunk c ON c.id = e.chunk_id
      WHERE e.project_id = ?
      ORDER BY c.source_id, c.seq, e.id`,
    projectId,
  );
  const bySource = new Map<number, typeof events>();
  for (const event of events) {
    bySource.set(event.source_id, [...(bySource.get(event.source_id) ?? []), event]);
  }

  const entityByName = new Map<string, number>();
  for (const entity of listEntities(db, projectId)) {
    entityByName.set(canonicalName(entity.name), entity.id);
    for (const alias of entity.aliases) {
      const key = canonicalName(alias);
      if (key && !entityByName.has(key)) entityByName.set(key, entity.id);
    }
  }
  const resolveName = (name: string): number | undefined => {
    const key = canonicalName(name);
    if (!key) return undefined;
    const direct = entityByName.get(key);
    if (direct) return direct;
    // "Serena" for "Serena Marsh": the passage named the short form.
    for (const [candidate, id] of entityByName) {
      if (candidate.split(' ').every((t) => key.split(' ').includes(t))) return id;
    }
    return undefined;
  };

  const addParticipants = (eventId: number, names: string[]): number => {
    let added = 0;
    for (const name of names) {
      const entityId = resolveName(name);
      if (!entityId) continue;
      const res = db.run(
        `INSERT OR IGNORE INTO canon_event_participant (canon_event_id, entity_id, role)
         VALUES (?, ?, 'participant')`,
        eventId,
        entityId,
      );
      added += res.changes;
    }
    return added;
  };

  const timelines = db.all<{
    id: number;
    canon_event: number | null;
    title: string;
    participants: string;
    source_refs: string;
  }>('SELECT id, canon_event, title, participants, source_refs FROM canon_timeline WHERE project_id = ? ORDER BY seq, id', projectId);

  let linked = 0;
  let participantRows = 0;
  let unlinked = 0;

  for (const entry of timelines) {
    let eventId = entry.canon_event ?? null;
    if (eventId === null) {
      const chunkId = firstChunkOf(entry.source_refs);
      const chunk = chunkId
        ? db.get<{ seq: number; source_id: number }>('SELECT seq, source_id FROM canon_chunk WHERE id = ?', chunkId)
        : undefined;
      if (chunk) {
        const names = strList(entry.participants).map(canonicalName);
        const scored = (bySource.get(chunk.source_id) ?? [])
          .map((event) => {
            const overlap = strList(event.participants)
              .map(canonicalName)
              .filter((n) => n && names.includes(n)).length;
            return { event, overlap, distance: Math.abs(event.chunk_seq - chunk.seq) };
          })
          .filter((c) => c.distance <= maxDistance)
          .sort((a, b) => b.overlap - a.overlap || a.distance - b.distance);
        const best = scored[0];
        const runnerUp = scored[1];
        // Only a clear winner is linked: a guess here would put an event at
        // the wrong point of the book.
        if (best && !(runnerUp && runnerUp.overlap === best.overlap && runnerUp.distance === best.distance)) {
          eventId = best.event.id;
          db.run('UPDATE canon_timeline SET canon_event = ? WHERE id = ?', eventId, entry.id);
        }
      }
    }

    if (eventId === null) {
      unlinked++;
      continue;
    }
    linked++;
    const eventRow = events.find((e) => e.id === eventId);
    participantRows += addParticipants(eventId, [
      ...strList(entry.participants),
      ...strList(eventRow?.participants ?? '[]'),
    ]);
  }

  return { linked, participants: participantRows, unlinked };
}


/**
 * Words that make a label a moment, not a tie.
 *
 * A tie stays true pages later. These verbs happen once and belong to
 * events: the model narrating an interaction instead of stating what two
 * people are to each other. Whole words only. Drawn from the bank's own
 * filler labels plus the action bucket, never from any one book: meeting,
 * giving, telling, seeing, wishing and refusing are moments everywhere.
 */
/** A generic kinship word drops when the same pair holds the specific one:
 * "parent of" says nothing once "father of" is banked. Universal sets only:
 * every generic maps to the specific words that entail it. */
const GENERIC_KINSHIP: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['parent of', new Set(['father of', 'mother of'])],
  ['sibling of', new Set(['brother of', 'sister of'])],
  ['child of', new Set(['son of', 'daughter of'])],
]);

/** True when a relation kind is named by a noun the quote must speak aloud.
 * Exported for the trials counter so the gate and the measuring stick never
 * disagree. Whole words, case-insensitive. */
export function isMomentKind(kind: string): boolean {
  // A defined relationship concept is a tie by construction, even when its
  // word also names a feeling or an action ("feared", "admired"). The moment
  // gate is for labels outside the concept set.
  if (isClosedRoleKind(kind)) return false;
  const words = (kind ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.some((w) => MOMENT_WORDS.has(w));
}

/**
 * A basic label-word check, retained for diagnostics and the note-relabel
 * pass. The promotion guard no longer uses it: it requires the model's
 * `kind_source` instead, so a concept proved by other wording passes there.
 * Open vocabulary is not this rule's job.
 */
const KIND_FILLER = new Set(['of', 'to', 'with', 'for', 'a', 'the', 'an', 'in', 'on', 'as']);

export function isUnsupportedKind(kind: string, quote: string): boolean {
  if (!isClosedRoleKind(kind)) return false;
  const quoteWords = new Set((quote ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean));
  const want = new Set<string>();
  for (const word of (kind ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    if (KIND_FILLER.has(word)) continue;
    for (const form of headForms(word)) want.add(form);
  }
  if (!want.size) return false;
  return ![...want].some((word) => quoteWords.has(word));
}

/**
 * Split a relation kind into single kinds.
 *
 * Models sometimes return several relationships in one field ("sibling of |
 * friend of"), and sometimes return the list of examples from the prompt. The
 * first is split apart; the second is dropped, because a row of every possible
 * relationship says nothing.
 */
export function normaliseKinds(kind: string): string[] {
  const raw = (kind ?? '').trim();
  if (!raw) return ['related to'];
  const parts = raw
    .split(/[|;,]/)
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const useful = parts.filter((p) => p.length > 1 && p.length <= 40 && !p.includes('...'));
  if (!useful.length) return ['related to'];
  // A row of many different relationship words is the example list, not data.
  const distinct = new Set(useful);
  if (distinct.size >= 4) return ['related to'];
  return useful;
}

/**
 * The model's kind word, defensively. Species words are a people; animal and
 * beast words are a creature; anything unrecognised keeps the historical
 * character fallback so old and stray values behave exactly as before.
 */
export function normaliseKind(kind: string): EntityKind {
  const k = kind.toLowerCase();
  if (k.includes('loc') || k.includes('place')) return 'location';
  if (k.includes('item') || k.includes('object') || k.includes('thing')) return 'item';
  if (k.includes('rule') || k.includes('law') || k.includes('magic') || k.includes('lore')) return 'rule';
  if (k.includes('faction') || k.includes('group') || k.includes('family')) return 'faction';
  if (
    k.includes('species') ||
    k.includes('race') ||
    k.includes('people') ||
    k.includes('folk') ||
    k.includes('lineage') ||
    k.includes('bloodline')
  ) {
    return 'species';
  }
  if (k.includes('creature') || k.includes('animal') || k.includes('beast')) return 'creature';
  return 'character';
}

export type ClaimModality = 'asserted' | 'denied' | 'possible' | 'suspected';

/**
 * The model's modality word, defensively: anything outside the four known
 * framings reads as asserted. A denial stored as a plain fact would be
 * worse than a wrong label, so unknown values fall back, never through.
 */
export function normaliseModality(raw: unknown): ClaimModality {
  const word = String(raw ?? '').trim().toLowerCase();
  if (word === 'denied' || word === 'possible' || word === 'suspected') return word;
  return 'asserted';
}

function key(name: string): string {
  return name.trim().toLowerCase();
}

function findEntityId(db: Db, projectId: number, kind: EntityKind, name: string): number | undefined {
  const row = db.get<{ id: number }>(
    'SELECT id FROM canon_entity WHERE project_id = ? AND kind = ? AND lower(name) = lower(?)',
    projectId,
    kind,
    name,
  );
  if (row) return row.id;
  const alias = db.get<{ id: number }>(
    `SELECT id FROM canon_entity WHERE project_id = ? AND lower(name) = lower(?)`,
    projectId,
    name,
  );
  return alias?.id;
}

function resolveEntity(
  db: Db,
  projectId: number,
  cache: Map<string, number>,
  name: string,
): number | undefined {
  const clean = name.trim();
  if (!clean) return undefined;
  const cached = cache.get(key(clean));
  if (cached) return cached;
  const found = findEntityId(db, projectId, 'character', clean)
    ?? db.get<{ id: number }>('SELECT id FROM canon_entity WHERE project_id = ? AND lower(name) = lower(?)', projectId, clean)?.id
    ?? resolveShortName(db, projectId, clean);
  if (found) cache.set(key(clean), found);
  return found;
}

/**
 * Upward short-name resolution: "Dudley" for the unique "Dudley Dursley".
 *
 * Models constantly use the short form even when the KNOWN ENTITIES list
 * holds the full name. Dropping those relations loses real hits, so a
 * single-token name that matches exactly one entity as a whole word resolves
 * to it. Zero or several matches stay unresolved — never guess a person.
 */
function shortNameHits(db: Db, projectId: number, clean: string): number[] {
  if (/\s/.test(clean)) return [];
  const needle = clean.toLowerCase();
  if (needle.length < 3) return [];
  const rows = db.all<{ id: number; name: string; aliases: string }>(
    'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  );
  return rows
    .filter((r) =>
      [r.name, ...strList(r.aliases)].some((v) =>
        v.toLowerCase().split(/[^a-z0-9']+/).includes(needle),
      ),
    )
    .map((r) => r.id);
}

function resolveShortName(db: Db, projectId: number, clean: string): number | undefined {
  const hits = shortNameHits(db, projectId, clean);
  return hits.length === 1 ? hits[0] : undefined;
}

export type SubjectEntityResolution =
  | { id: number }
  | { ambiguous: number }
  | { missing: true };

/**
 * Resolve a fact subject to an entity for canon_fact.subject_entity_id.
 *
 * Exact canonical name first, then exact canonical alias, then the existing
 * unique short-name rule. No edit-distance or substring matching: a fact
 * attached to the wrong person is worse than an unattached fact.
 */
export function resolveSubjectEntity(
  db: Db,
  projectId: number,
  subject: string,
): SubjectEntityResolution {
  const canonical = canonicalName(subject ?? '');
  if (!canonical) return { missing: true };
  const rows = db.all<{ id: number; name: string; aliases: string }>(
    'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  );
  const nameHits = rows.filter((r) => canonicalName(r.name) === canonical).map((r) => r.id);
  if (nameHits.length) {
    return nameHits.length === 1 ? { id: nameHits[0]! } : { ambiguous: nameHits.length };
  }
  const aliasHits = rows
    .filter((r) => strList(r.aliases).some((alias) => canonicalName(alias) === canonical))
    .map((r) => r.id);
  if (aliasHits.length) {
    return aliasHits.length === 1 ? { id: aliasHits[0]! } : { ambiguous: aliasHits.length };
  }
  const shortHits = shortNameHits(db, projectId, canonical);
  if (shortHits.length) {
    return shortHits.length === 1 ? { id: shortHits[0]! } : { ambiguous: shortHits.length };
  }
  return { missing: true };
}

export interface FactLinkResult {
  scanned: number;
  linked: number;
  ambiguous: number;
  unmatched: number;
}

/**
 * Link facts with no subject_entity_id, using the same conservative resolver
 * as the write path. Only canon_fact.subject_entity_id is ever written.
 */
export function linkFactSubjects(
  db: Db,
  projectId: number,
  opts: { dryRun?: boolean; limit?: number } = {},
): FactLinkResult {
  const limit = opts.limit === undefined ? -1 : Math.max(0, Math.floor(opts.limit));
  const rows = db.all<{ id: number; subject: string }>(
    'SELECT id, subject FROM canon_fact WHERE project_id = ? AND subject_entity_id IS NULL ORDER BY id LIMIT ?',
    projectId,
    limit,
  );
  const result: FactLinkResult = { scanned: rows.length, linked: 0, ambiguous: 0, unmatched: 0 };
  for (const row of rows) {
    const resolved = resolveSubjectEntity(db, projectId, row.subject);
    if ('id' in resolved) {
      if (!opts.dryRun) {
        db.run(
          'UPDATE canon_fact SET subject_entity_id = ? WHERE id = ? AND project_id = ? AND subject_entity_id IS NULL',
          resolved.id,
          row.id,
          projectId,
        );
      }
      result.linked++;
    } else if ('ambiguous' in resolved) {
      result.ambiguous++;
    } else {
      result.unmatched++;
    }
  }
  return result;
}

export interface EntityCapacityResult {
  scanned: number;
  parked: number;
  funneled: number;
  skipped: number;
  /** Candidates spared because another row/taxonomy references them. */
  skippedReferenced: number;
  /** Names of every candidate that would park / did park. */
  parkedNames: string[];
  /** Names of candidates whose quote supports a funnel fact. */
  funneledNames: string[];
}

/** A stored name counts as proper when a token starts with a capital. */
function properEntityName(name: string): boolean {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  if (!tokens.some((token) => /^[A-Z]/.test(token))) return false;
  if (tokens.length === 1 && tokens[0] === tokens[0]!.toLowerCase()) return false;
  return true;
}

/**
 * Park unproven entities: no ties, one mention, no role/status, no proper name.
 *
 * A failed candidate becomes a fact only when its own verified quote names the
 * candidate noun and exactly one other, non-parked entity. The candidate is
 * parked in every case; nothing is deleted, renamed or re-kinded.
 */
/**
 * Hold back characters that look like ordinary words.
 *
 * A character admitted from a single mention, with no alias, whose name also
 * occurs lowercase in the book is probably a common noun ("bill" on an
 * invoice). It is quarantined, not deleted: ties involving it are refused and
 * the scan ignores it, but the row and its evidence stay for review.
 *
 * Release requires real character evidence — a second mention, or a recognised
 * alias — so another occurrence of the same common noun cannot release it.
 */
export function quarantineSuspectCharacters(
  db: Db,
  projectId: number,
): { quarantined: number; released: number } {
  const text = db
    .all<{ text: string }>('SELECT text FROM canon_chunk WHERE project_id = ?', projectId)
    .map((row) => row.text)
    .join(' ');
  const rows = db.all<{ id: number; name: string; aliases: string; mentions: number; review_status: string }>(
    "SELECT id, name, aliases, mentions, review_status FROM canon_entity WHERE project_id = ? AND kind = 'character'",
    projectId,
  );
  let quarantined = 0;
  let released = 0;
  for (const row of rows) {
    if (row.review_status === 'quarantined') {
      if ((row.mentions ?? 0) >= 2 || strList(row.aliases).length > 0) {
        db.run("UPDATE canon_entity SET review_status = 'accepted', quarantine_reason = '' WHERE id = ?", row.id);
        released++;
      }
      continue;
    }
    if ((row.mentions ?? 0) > 1) continue;
    if (strList(row.aliases).length > 0) continue;
    if (!/^[A-Z][a-z]{2,}$/.test(row.name)) continue;
    const lower = lowerOccurrencesInText(text, row.name.toLowerCase());
    if (lower < 1) continue;
    db.run(
      "UPDATE canon_entity SET review_status = 'quarantined', quarantine_reason = ? WHERE id = ?",
      `single mention; the name also occurs lowercase ${lower} time(s) in the book`,
      row.id,
    );
    quarantined++;
  }
  return { quarantined, released };
}

export function checkEntityCapacity(
  db: Db,
  projectId: number,
  ids: Iterable<number>,
  opts: { write: boolean },
): EntityCapacityResult {
  const result: EntityCapacityResult = {
    scanned: 0,
    parked: 0,
    funneled: 0,
    skipped: 0,
    skippedReferenced: 0,
    parkedNames: [],
    funneledNames: [],
  };
  const unique = [...new Set(ids)];
  const all = db.all<{ id: number; name: string; aliases: string; kind: string; review_status: string }>(
    'SELECT id, name, aliases, kind, review_status FROM canon_entity WHERE project_id = ?',
    projectId,
  );
  const hasTable = (name: string): boolean =>
    !!db.get("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", name);
  const factSubjects = new Set(
    db.all<{ id: number }>('SELECT DISTINCT subject_entity_id AS id FROM canon_fact WHERE project_id = ? AND subject_entity_id IS NOT NULL', projectId)
      .map((row) => row.id),
  );
  const tieNoteEntities = new Set<number>();
  if (hasTable('canon_tie_note')) {
    for (const row of db.all<{ from_entity: number; to_entity: number }>(
      'SELECT from_entity, to_entity FROM canon_tie_note WHERE project_id = ?',
      projectId,
    )) {
      tieNoteEntities.add(row.from_entity);
      tieNoteEntities.add(row.to_entity);
    }
  }
  const eventParticipants = new Set<number>();
  if (hasTable('canon_event_participant')) {
    for (const row of db.all<{ entity_id: number }>(
      'SELECT entity_id FROM canon_event_participant WHERE entity_id IN (SELECT id FROM canon_entity WHERE project_id = ?)',
      projectId,
    )) {
      eventParticipants.add(row.entity_id);
    }
  }
  // Timeline names are free text: a JSON participant list and a location
  // phrase such as "the north wing". Match them with the exact phrase matcher
  // instead of string equality, which never sees a name embedded in a phrase.
  const timelinePhrases: string[] = [];
  for (const row of db.all<{ participants: string; location: string }>(
    'SELECT participants, location FROM canon_timeline WHERE project_id = ?',
    projectId,
  )) {
    const location = row.location.trim();
    if (location) timelinePhrases.push(location);
    const participants = row.participants.trim();
    if (!participants) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(participants);
    } catch {
      parsed = undefined;
    }
    if (Array.isArray(parsed)) {
      for (const participant of parsed) {
        if (typeof participant === 'string' && participant.trim()) {
          timelinePhrases.push(participant.trim());
        }
      }
    } else if (typeof parsed === 'string' && parsed.trim()) {
      timelinePhrases.push(parsed.trim());
    } else {
      // Malformed or non-list payload: match the raw text as a phrase.
      timelinePhrases.push(participants);
    }
  }
  const hintNames = new Set<string>();
  if (hasTable('canon_tie_hint')) {
    for (const row of db.all<{ from_name: string; to_name: string }>(
      'SELECT from_name, to_name FROM canon_tie_hint WHERE project_id = ?',
      projectId,
    )) {
      for (const name of [row.from_name, row.to_name]) {
        const canonical = canonicalName(name);
        if (canonical) hintNames.add(canonical);
      }
    }
  }
  const quarantineNames = new Set<string>();
  if (hasTable('quarantine_alias')) {
    for (const row of db.all<{ name: string; candidate: string }>(
      'SELECT name, candidate FROM quarantine_alias WHERE project_id = ?',
      projectId,
    )) {
      for (const name of [row.name, row.candidate]) {
        const canonical = canonicalName(name);
        if (canonical) quarantineNames.add(canonical);
      }
    }
  }
  for (const id of unique) {
    const entity = db.get<{
      id: number;
      name: string;
      aliases: string;
      kind: string;
      role: string;
      status: string;
      mentions: number;
      evidence: string;
      source_refs: string;
      review_status: string;
      first_chunk: number | null;
    }>(
      `SELECT id, name, aliases, kind, role, status, mentions, evidence, source_refs, review_status, first_chunk
         FROM canon_entity WHERE project_id = ? AND id = ?`,
      projectId,
      id,
    );
    if (!entity) continue;
    result.scanned++;
    // Only machine-accepted rows are candidates. Already-parked, rejected and
    // human-confirmed rows are left alone.
    if (entity.review_status !== 'accepted') continue;
    const ties = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ? AND (from_entity = ? OR to_entity = ?)',
      projectId,
      id,
      id,
    )?.n ?? 0;
    if (ties > 0) continue;
    if (Number(entity.mentions ?? 0) > 1) continue;
    if (entity.role.trim() || entity.status.trim()) continue;
    if (properEntityName(entity.name)) continue;

    const variants = [entity.name, ...strList(entity.aliases)]
      .map((name) => canonicalName(name))
      .filter(Boolean);
    const taxonomyKind = entity.kind === 'species' || entity.kind === 'faction' || entity.kind === 'rule';
    const referenced =
      taxonomyKind ||
      factSubjects.has(entity.id) ||
      eventParticipants.has(entity.id) ||
      tieNoteEntities.has(entity.id) ||
      variants.some((name) => timelinePhrases.some((phrase) => nameMentionedExact(name, phrase))) ||
      variants.some((name) => hintNames.has(name)) ||
      variants.some((name) => quarantineNames.has(name));
    if (referenced) {
      result.skippedReferenced++;
      continue;
    }

    const quote = entity.evidence.trim();
    let funneled = false;
    if (quote) {
      const refs = fromJson<{ chunk?: unknown }[]>(entity.source_refs, []);
      const refChunk = refs
        .map((ref) => Number(ref?.chunk))
        .find((value) => Number.isFinite(value) && value > 0);
      const chunkId = refChunk ?? entity.first_chunk ?? null;
      const chunk = chunkId
        ? db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', chunkId)
        : undefined;
      if (chunk && normalise(chunk.text).includes(normalise(quote))) {
        const quoteTokens = new Set(normalise(quote).split(' ').filter(Boolean));
        const ownTokens = nameTokens(entity.name);
        const namesOwn = ownTokens.some((token) => quoteTokens.has(token));
        if (namesOwn) {
          const others = all.filter(
            (other) =>
              other.id !== entity.id &&
              (nameMentionedExact(other.name, quote) ||
                strList(other.aliases).some((alias) => nameMentionedExact(alias, quote))),
          );
          if (others.length === 1) {
            const other = others[0]!;
            if (other.review_status !== 'needs_review' && other.review_status !== 'rejected') {
              const sentences = splitSentences(quote);
              const sentence = sentences.find((candidate) => {
                const tokens = new Set(normalise(candidate).split(' ').filter(Boolean));
                return (
                  ownTokens.some((token) => tokens.has(token)) &&
                  (nameMentionedExact(other.name, candidate) ||
                    strList(other.aliases).some((alias) => nameMentionedExact(alias, candidate)))
                );
              }) ?? sentences[0] ?? quote;
              const statement = sentence.trim();
              if (statement) {
                const existing = db.get<{ id: number }>(
                  'SELECT id FROM canon_fact WHERE project_id = ? AND subject_entity_id = ? AND topic = ? AND evidence = ?',
                  projectId,
                  other.id,
                  entity.name,
                  statement,
                );
                if (!existing && opts.write) {
                  db.run(
                    `INSERT INTO canon_fact
                       (project_id, topic, statement, kind, certainty, subject, evidence, source_refs, subject_entity_id, modality, created_at)
                     VALUES (?, ?, ?, 'fact', 'confirmed', ?, ?, ?, ?, 'asserted', ?)`,
                    projectId,
                    entity.name,
                    statement,
                    other.name,
                    statement,
                    entity.source_refs || '[]',
                    other.id,
                    nowIso(),
                  );
                }
                funneled = true;
              }
            }
          }
        }
      }
    }

    result.parked++;
    result.parkedNames.push(entity.name);
    if (funneled) {
      result.funneled++;
      result.funneledNames.push(entity.name);
    } else {
      result.skipped++;
    }
    if (opts.write) {
      db.run(
        "UPDATE canon_entity SET review_status = 'needs_review', updated_at = ? WHERE project_id = ? AND id = ?",
        nowIso(),
        projectId,
        entity.id,
      );
    }
  }
  return result;
}

/* ---------------------------------------------------------------- rulings */

const RULINGS_VERSION = 1 as const;

export interface RulingsExportKeeper {
  from_name: string;
  from_aliases: string[];
  to_name: string;
  to_aliases: string[];
  kind: string;
  review_status: string;
  evidence: string;
  locator: string;
  exported_at: string;
}

export interface RulingsExportNote {
  from_name: string;
  to_name: string;
  attempted_kind: string;
  status: string;
  ruling: string;
  evidence: string;
}

export interface RulingsExportIdentity {
  name: string;
  aliases: string[];
}

export interface RulingsExport {
  version: 1;
  counters: {
    project: string;
    keepers: number;
    note_rulings: number;
    identities: number;
  };
  keepers: RulingsExportKeeper[];
  note_rulings: RulingsExportNote[];
  identities: RulingsExportIdentity[];
}

export type RulingUnresolvedReason = 'name not found' | 'quote not found' | 'ambiguous name' | 'evidence-required';

export interface RulingReplayCategory {
  total: number;
  resolved: number;
  applied: number;
  already_present: number;
  unresolved: number;
}

export interface RulingReplayIssue {
  category: 'keeper' | 'note_ruling' | 'identity';
  from: string;
  to: string;
  kind: string;
  reason: RulingUnresolvedReason;
}

export interface RulingReplayResult {
  keepers: RulingReplayCategory;
  note_rulings: RulingReplayCategory;
  identities: RulingReplayCategory;
  total: RulingReplayCategory;
  issues: RulingReplayIssue[];
}

/** Codepoint order keeps exports byte-identical on every machine. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedAliases(value: unknown): string[] {
  const aliases = strList(value)
    .map((alias) => alias.trim())
    .filter(Boolean);
  return [...new Set(aliases)].sort(compareText);
}

/**
 * Every decision the author made, keyed by name rather than by row id.
 *
 * A rescan rewrites chunk and entity ids, so ids cannot travel. Names, aliases
 * and quotes can: this payload is what a fresh bank replays.
 */
export function exportRulings(
  db: Db,
  projectId: number,
  opts: { now?: string } = {},
): RulingsExport {
  const project = db.get<{ name: string }>('SELECT name FROM project WHERE id = ?', projectId);
  if (!project) throw new Error(`no project with id ${projectId}`);
  const exportedAt = opts.now ?? nowIso();
  const entities = db.all<{ id: number; name: string; aliases: string }>(
    'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  );
  const byId = new Map(entities.map((row) => [row.id, row]));

  const keepers: RulingsExportKeeper[] = [];
  for (const row of db.all<{
    from_entity: number;
    to_entity: number;
    kind: string;
    review_status: string;
    evidence: string;
    source_refs: string;
  }>(
    `SELECT from_entity, to_entity, kind, review_status, evidence, source_refs
       FROM canon_relation
      WHERE project_id = ? AND review_status IN ('accepted','user_confirmed')`,
    projectId,
  )) {
    const from = byId.get(row.from_entity);
    const to = byId.get(row.to_entity);
    if (!from || !to) continue;
    const refs = fromJson<{ locator?: unknown }[]>(row.source_refs, []);
    const locator = refs
      .map((ref) => (typeof ref?.locator === 'string' ? ref.locator.trim() : ''))
      .find(Boolean) ?? '';
    keepers.push({
      from_name: from.name,
      from_aliases: sortedAliases(from.aliases),
      to_name: to.name,
      to_aliases: sortedAliases(to.aliases),
      kind: row.kind,
      review_status: row.review_status,
      evidence: row.evidence,
      locator,
      exported_at: exportedAt,
    });
  }
  keepers.sort(
    (a, b) =>
      compareText(a.from_name, b.from_name) ||
      compareText(a.to_name, b.to_name) ||
      compareText(a.kind, b.kind) ||
      compareText(a.review_status, b.review_status) ||
      compareText(a.evidence, b.evidence) ||
      compareText(a.locator, b.locator),
  );

  const noteRulings: RulingsExportNote[] = [];
  for (const row of db.all<{
    from_entity: number;
    to_entity: number;
    attempted_kind: string;
    status: string;
    ruling: string;
    evidence: string;
  }>(
    `SELECT from_entity, to_entity, attempted_kind, status, ruling, evidence
       FROM canon_tie_note
      WHERE project_id = ? AND ruling != ''`,
    projectId,
  )) {
    const from = byId.get(row.from_entity);
    const to = byId.get(row.to_entity);
    if (!from || !to) continue;
    noteRulings.push({
      from_name: from.name,
      to_name: to.name,
      attempted_kind: row.attempted_kind,
      status: row.status,
      ruling: row.ruling,
      evidence: row.evidence,
    });
  }
  noteRulings.sort(
    (a, b) =>
      compareText(a.from_name, b.from_name) ||
      compareText(a.to_name, b.to_name) ||
      compareText(a.attempted_kind, b.attempted_kind) ||
      compareText(a.status, b.status) ||
      compareText(a.ruling, b.ruling),
  );

  const identities: RulingsExportIdentity[] = entities
    .map((row) => ({ name: row.name, aliases: sortedAliases(row.aliases) }))
    .filter((row) => row.aliases.length > 0)
    .sort((a, b) => compareText(a.name, b.name));

  return {
    version: RULINGS_VERSION,
    counters: {
      project: project.name,
      keepers: keepers.length,
      note_rulings: noteRulings.length,
      identities: identities.length,
    },
    keepers,
    note_rulings: noteRulings,
    identities,
  };
}

/** Reject anything that is not a complete rulings export, with the reason. */
export function parseRulingsExport(value: unknown): RulingsExport {
  const fail = (detail: string): never => {
    throw new Error(`not a rulings export: ${detail}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected a JSON object');
  const record = value as Record<string, unknown>;
  if (record.version !== RULINGS_VERSION) fail(`unsupported version ${String(record.version)}`);
  const counters = record.counters;
  if (!counters || typeof counters !== 'object' || Array.isArray(counters)) fail('missing counters');
  const rawProject = (counters as Record<string, unknown>).project;
  if (typeof rawProject !== 'string' || !rawProject.trim()) {
    fail('counters.project must be a non-empty string');
  }
  const project = rawProject as string;
  const asText = (raw: Record<string, unknown>, field: string, where: string): string => {
    const v = raw[field];
    if (typeof v === 'string') return v;
    return fail(`${where}.${field} must be a string`);
  };
  const asAliases = (raw: Record<string, unknown>, field: string, where: string): string[] => {
    const v = raw[field];
    if (!Array.isArray(v) || v.some((item) => typeof item !== 'string')) {
      fail(`${where}.${field} must be an array of strings`);
    }
    return (v as string[]).map((item) => item.trim()).filter(Boolean);
  };
  const asList = (field: 'keepers' | 'note_rulings' | 'identities'): Record<string, unknown>[] => {
    const v = record[field];
    if (!Array.isArray(v)) fail(`${field} must be an array`);
    return (v as unknown[]).map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        fail(`${field}[${index}] must be an object`);
      }
      return item as Record<string, unknown>;
    });
  };

  const keepers = asList('keepers').map((raw, index): RulingsExportKeeper => {
    const where = `keepers[${index}]`;
    const fromName = asText(raw, 'from_name', where).trim();
    const toName = asText(raw, 'to_name', where).trim();
    if (!fromName) fail(`${where}.from_name is empty`);
    if (!toName) fail(`${where}.to_name is empty`);
    return {
      from_name: fromName,
      from_aliases: asAliases(raw, 'from_aliases', where),
      to_name: toName,
      to_aliases: asAliases(raw, 'to_aliases', where),
      kind: asText(raw, 'kind', where),
      review_status: asText(raw, 'review_status', where),
      evidence: asText(raw, 'evidence', where),
      locator: asText(raw, 'locator', where),
      exported_at: asText(raw, 'exported_at', where),
    };
  });

  const noteRulings = asList('note_rulings').map((raw, index): RulingsExportNote => {
    const where = `note_rulings[${index}]`;
    const fromName = asText(raw, 'from_name', where).trim();
    const toName = asText(raw, 'to_name', where).trim();
    if (!fromName) fail(`${where}.from_name is empty`);
    if (!toName) fail(`${where}.to_name is empty`);
    return {
      from_name: fromName,
      to_name: toName,
      attempted_kind: asText(raw, 'attempted_kind', where),
      status: asText(raw, 'status', where),
      ruling: asText(raw, 'ruling', where),
      evidence: asText(raw, 'evidence', where),
    };
  });

  const identities = asList('identities').map((raw, index): RulingsExportIdentity => {
    const where = `identities[${index}]`;
    const name = asText(raw, 'name', where).trim();
    if (!name) fail(`${where}.name is empty`);
    return { name, aliases: asAliases(raw, 'aliases', where) };
  });

  return {
    version: RULINGS_VERSION,
    counters: {
      project,
      keepers: keepers.length,
      note_rulings: noteRulings.length,
      identities: identities.length,
    },
    keepers,
    note_rulings: noteRulings,
    identities,
  };
}

interface RulingsResolver {
  resolve(name: string, aliases: string[]): { id: number } | { reason: RulingUnresolvedReason };
  resolveName(name: string): { id: number } | { reason: RulingUnresolvedReason };
}

/**
 * Exact resolution only: stored name, canonical name, then canonical alias.
 *
 * The export's own identities are a last resort, so a survivor whose alias the
 * rescan dropped can still be named by the alias the author used.
 */
function buildRulingsResolver(
  db: Db,
  projectId: number,
  exportedIdentities: RulingsExportIdentity[],
): RulingsResolver {
  const rows = db.all<{ id: number; name: string; aliases: string }>(
    'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
    projectId,
  );
  const byRawName = new Map<string, number[]>();
  const byCanonicalName = new Map<string, number[]>();
  const byCanonicalAlias = new Map<string, number[]>();
  const push = (map: Map<string, number[]>, key: string, id: number): void => {
    if (!key) return;
    const list = map.get(key);
    if (!list) map.set(key, [id]);
    else if (!list.includes(id)) list.push(id);
  };
  for (const row of rows) {
    push(byRawName, row.name.trim().toLowerCase(), row.id);
    push(byCanonicalName, canonicalName(row.name), row.id);
    for (const alias of strList(row.aliases)) push(byCanonicalAlias, canonicalName(alias), row.id);
  }
  const exportedAlias = new Map<string, string>();
  const exportedIdentity = new Map<string, RulingsExportIdentity>();
  for (const identity of exportedIdentities) {
    const nameKey = canonicalName(identity.name);
    if (nameKey && !exportedIdentity.has(nameKey)) exportedIdentity.set(nameKey, identity);
    for (const alias of identity.aliases) {
      const key = canonicalName(alias);
      if (key && !exportedAlias.has(key)) exportedAlias.set(key, identity.name);
    }
  }
  const single = (ids: number[] | undefined): { id: number } | { reason: RulingUnresolvedReason } => {
    if (!ids || ids.length === 0) return { reason: 'name not found' };
    if (ids.length > 1) return { reason: 'ambiguous name' };
    return { id: ids[0]! };
  };
  const resolveName = (name: string): { id: number } | { reason: RulingUnresolvedReason } => {
    const clean = name.trim();
    if (!clean) return { reason: 'name not found' };
    const raw = byRawName.get(clean.toLowerCase());
    if (raw && raw.length === 1) return { id: raw[0]! };
    if (raw && raw.length > 1) return { reason: 'ambiguous name' };
    const canonical = canonicalName(clean);
    const named = byCanonicalName.get(canonical);
    if (named && named.length) return single(named);
    const aliased = byCanonicalAlias.get(canonical);
    if (aliased && aliased.length) return single(aliased);
    return { reason: 'name not found' };
  };
  const resolve = (name: string, aliases: string[]): { id: number } | { reason: RulingUnresolvedReason } => {
    const direct = resolveName(name);
    if ('id' in direct || direct.reason === 'ambiguous name') return direct;
    const viaExport = exportedAlias.get(canonicalName(name));
    if (viaExport) {
      const mapped = resolveName(viaExport);
      if ('id' in mapped || mapped.reason === 'ambiguous name') return mapped;
    }
    // The survivor may have been re-extracted under one of its old aliases.
    const identity = exportedIdentity.get(canonicalName(name));
    if (identity) {
      for (const alias of identity.aliases) {
        const hit = resolveName(alias);
        if ('id' in hit || hit.reason === 'ambiguous name') return hit;
      }
    }
    for (const alias of aliases) {
      const hit = resolveName(alias);
      if ('id' in hit || hit.reason === 'ambiguous name') return hit;
      const mappedName = exportedAlias.get(canonicalName(alias));
      if (mappedName) {
        const mapped = resolveName(mappedName);
        if ('id' in mapped || mapped.reason === 'ambiguous name') return mapped;
      }
    }
    return { reason: 'name not found' };
  };
  return { resolve, resolveName };
}

function blankReplayCategory(total = 0): RulingReplayCategory {
  return { total, resolved: 0, applied: 0, already_present: 0, unresolved: 0 };
}

function sumReplayCategories(categories: RulingReplayCategory[]): RulingReplayCategory {
  const total = blankReplayCategory();
  for (const category of categories) {
    total.total += category.total;
    total.resolved += category.resolved;
    total.applied += category.applied;
    total.already_present += category.already_present;
    total.unresolved += category.unresolved;
  }
  return total;
}

/**
 * Reapply an exported ruling file to the selected project.
 *
 * Nothing is deleted, merged, re-kinded or created except the exported
 * relations and tie notes whose quotes still verify in this bank. Writes run in
 * batches inside a transaction; `write: false` resolves and verifies only.
 */
export function replayRulings(
  db: Db,
  projectId: number,
  payload: unknown,
  opts: { write: boolean; limit?: number },
): RulingReplayResult {
  const exported = parseRulingsExport(payload);
  const now = nowIso();
  const resolver = buildRulingsResolver(db, projectId, exported.identities);
  const limit = opts.limit === undefined ? undefined : Math.max(0, Math.floor(opts.limit));
  const take = <T>(items: T[]): T[] => (limit === undefined ? items : items.slice(0, limit));
  const keepers = take(exported.keepers);
  const notes = take(exported.note_rulings);
  const identities = take(exported.identities);

  const issues: RulingReplayIssue[] = [];
  const writes: {
    sql: string;
    params: unknown[];
    /** The ruling this write must produce in the same transaction. */
    court?: {
      relationId: number | null;
      insert?: boolean;
      role?: 'appeal' | 'objection';
      subject?: string;
      fromStatus: string;
      toStatus: string;
      reference: string;
      quote: string;
    };
  }[] = [];
  let chunks: ChunkRow[] | null = null;
  const quoteRefs = (evidence: string): { source: string; locator: string; chunk: number }[] | undefined => {
    const needle = normalise(evidence);
    if (!needle) return undefined;
    chunks ??= loadOrderedChunks(db, projectId);
    const chunk = chunks.find((candidate) => normalise(candidate.text).includes(needle));
    if (!chunk) return undefined;
    return [{ source: chunk.source_title, locator: chunk.locator, chunk: chunk.id }];
  };
  const deficit = (
    report: RulingReplayCategory,
    category: RulingReplayIssue['category'],
    entry: { from: string; to: string; kind: string },
    reason: RulingUnresolvedReason,
  ): void => {
    report.unresolved++;
    issues.push({ category, from: entry.from, to: entry.to, kind: entry.kind, reason });
  };

  const keeperReport = blankReplayCategory(keepers.length);
  const seenKeepers = new Set<string>();
  for (const keeper of keepers) {
    const from = resolver.resolve(keeper.from_name, keeper.from_aliases);
    const to = resolver.resolve(keeper.to_name, keeper.to_aliases);
    const entry = { from: keeper.from_name, to: keeper.to_name, kind: keeper.kind };
    if (!('id' in from)) {
      deficit(keeperReport, 'keeper', entry, from.reason);
      continue;
    }
    if (!('id' in to)) {
      deficit(keeperReport, 'keeper', entry, to.reason);
      continue;
    }
    keeperReport.resolved++;
    const key = `${from.id}|${to.id}|${keeper.kind}`;
    if (seenKeepers.has(key)) {
      keeperReport.already_present++;
      continue;
    }
    seenKeepers.add(key);
    const existing = db.get<{ id: number; review_status: string }>(
      `SELECT id, review_status FROM canon_relation
        WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND kind = ?
        ORDER BY id LIMIT 1`,
      projectId,
      from.id,
      to.id,
      keeper.kind,
    );
    if (existing) {
      if (
        existing.review_status === keeper.review_status ||
        existing.review_status === 'user_confirmed'
      ) {
        keeperReport.already_present++;
      } else {
        keeperReport.applied++;
        writes.push({
          sql: `UPDATE canon_relation
                   SET review_status = ?,
                       confirmed_by_user = CASE WHEN ? = 'user_confirmed' THEN 1 ELSE confirmed_by_user END
                 WHERE id = ? AND project_id = ?`,
          params: [keeper.review_status, keeper.review_status, existing.id, projectId],
          court: {
            relationId: existing.id,
            fromStatus: existing.review_status,
            toStatus: keeper.review_status,
            reference: `${keeper.kind}`,
            quote: keeper.evidence ?? '',
          },
        });
      }
      continue;
    }
    const evidence = (keeper.evidence ?? '').trim();
    if (!evidence) {
      // A user's own confirmation needs no book quotation. An accepted row
      // still does: nothing may enter the accepted tier without evidence.
      if (keeper.review_status !== 'user_confirmed') {
        deficit(keeperReport, 'keeper', entry, 'evidence-required');
        continue;
      }
      keeperReport.applied++;
      writes.push({
        sql: `INSERT INTO canon_relation
                (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
                 confidence, review_status, confirmed_by_user, created_at)
              VALUES (?, ?, ?, ?, '', '', '[]', 1.0, ?, 1, ?)`,
        params: [projectId, from.id, to.id, keeper.kind, keeper.review_status, now],
        court: {
          relationId: null,
          insert: true,
          fromStatus: '',
          toStatus: keeper.review_status,
          reference: keeper.kind,
          quote: '',
        },
      });
      continue;
    }
    const refs = quoteRefs(evidence);
    if (!refs) {
      deficit(keeperReport, 'keeper', entry, 'quote not found');
      continue;
    }
    keeperReport.applied++;
    writes.push({
      sql: `INSERT INTO canon_relation
              (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
               confidence, review_status, confirmed_by_user, created_at)
            VALUES (?, ?, ?, ?, '', ?, ?, 1.0, ?, ?, ?)`,
      params: [
        projectId,
        from.id,
        to.id,
        keeper.kind,
        keeper.evidence,
        JSON.stringify(refs),
        keeper.review_status,
        keeper.review_status === 'user_confirmed' ? 1 : 0,
        now,
      ],
      court: {
        relationId: null,
        insert: true,
        fromStatus: '',
        toStatus: keeper.review_status,
        reference: keeper.kind,
        quote: keeper.evidence,
      },
    });
  }

  const noteReport = blankReplayCategory(notes.length);
  const seenNotes = new Set<string>();
  for (const note of notes) {
    const from = resolver.resolve(note.from_name, []);
    const to = resolver.resolve(note.to_name, []);
    const entry = { from: note.from_name, to: note.to_name, kind: note.attempted_kind };
    if (!('id' in from)) {
      deficit(noteReport, 'note_ruling', entry, from.reason);
      continue;
    }
    if (!('id' in to)) {
      deficit(noteReport, 'note_ruling', entry, to.reason);
      continue;
    }
    noteReport.resolved++;
    const key = `${from.id}|${to.id}|${note.attempted_kind}`;
    if (seenNotes.has(key)) {
      noteReport.already_present++;
      continue;
    }
    seenNotes.add(key);
    const existing = db.get<{ id: number; status: string; ruling: string }>(
      `SELECT id, status, ruling FROM canon_tie_note
        WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND attempted_kind = ?`,
      projectId,
      from.id,
      to.id,
      note.attempted_kind,
    );
    if (existing) {
      if (existing.status === note.status && existing.ruling === note.ruling) {
        noteReport.already_present++;
      } else {
        noteReport.applied++;
        writes.push({
          sql: `UPDATE canon_tie_note SET status = ?, ruling = ?, ruled_at = ?
                 WHERE id = ? AND project_id = ?`,
          params: [note.status, note.ruling, now, existing.id, projectId],
          court: {
            relationId: null,
            role: 'objection',
            subject: `pair:${Math.min(from.id, to.id)}:${Math.max(from.id, to.id)}`,
            fromStatus: existing.status,
            toStatus: note.status,
            reference: note.attempted_kind,
            quote: note.evidence,
          },
        });
      }
      continue;
    }
    const refs = quoteRefs(note.evidence);
    if (!refs) {
      deficit(noteReport, 'note_ruling', entry, 'quote not found');
      continue;
    }
    noteReport.applied++;
    writes.push({
      sql: `INSERT INTO canon_tie_note
              (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs,
               status, ruling, ruled_at, created_at)
            VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`,
      params: [
        projectId,
        from.id,
        to.id,
        note.attempted_kind,
        note.evidence,
        JSON.stringify(refs),
        note.status,
        note.ruling,
        now,
        now,
      ],
      court: {
        relationId: null,
        role: 'objection',
        subject: `pair:${Math.min(from.id, to.id)}:${Math.max(from.id, to.id)}`,
        fromStatus: '',
        toStatus: note.status,
        reference: note.attempted_kind,
        quote: note.evidence,
      },
    });
  }

  // Identities are read-only: they prove a merged name still reaches its
  // survivor, but replay never merges or writes aliases.
  const identityReport = blankReplayCategory(identities.length);
  for (const identity of identities) {
    const hit = resolver.resolve(identity.name, identity.aliases);
    if ('id' in hit) {
      identityReport.resolved++;
    } else {
      deficit(identityReport, 'identity', { from: identity.name, to: '', kind: '' }, hit.reason);
    }
  }

  if (opts.write && writes.length) {
    const batchSize = 100;
    for (let start = 0; start < writes.length; start += batchSize) {
      const batch = writes.slice(start, start + batchSize);
      db.transaction(() => {
        for (const write of batch) {
          const result = db.run(write.sql, ...write.params);
          if (write.court) {
            recordRuling(db, projectId, {
              relationId: write.court.insert ? Number(result.lastInsertRowid) : write.court.relationId,
              subject: write.court.subject,
              role: write.court.role ?? 'appeal',
              actor: 'human',
              standard: 'replay',
              fromStatus: write.court.fromStatus,
              toStatus: write.court.toStatus,
              basis: `replay ${write.court.role === 'objection' ? 'objection' : 'keeper'}: ${write.court.reference}`,
              quote: write.court.quote,
            });
          }
        }
      });
    }
  }

  return {
    keepers: keeperReport,
    note_rulings: noteReport,
    identities: identityReport,
    total: sumReplayCategories([keeperReport, noteReport, identityReport]),
    issues,
  };
}

/* ------------------------------------------------------------- retrieval */

export function listEntities(
  db: Db,
  projectId: number,
  kind?: EntityKind,
  statuses?: readonly string[],
): CanonEntity[] {
  const params: unknown[] = [projectId];
  let sql = 'SELECT * FROM canon_entity WHERE project_id = ?';
  if (kind) {
    sql += ' AND kind = ?';
    params.push(kind);
  }
  if (statuses?.length) {
    sql += ` AND review_status IN (${statuses.map(() => '?').join(',')})`;
    params.push(...statuses);
  }
  sql += ' ORDER BY kind, name';
  const rows = db.all<{
    id: number;
    kind: string;
    name: string;
    aliases: string;
    summary: string;
    attributes: string;
    role: string;
    status: string;
    first_chunk: number | null;
    evidence: string;
    source_refs: string;
    mentions: number;
    review_status: string | null;
  }>(sql, ...params);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as EntityKind,
    name: r.name,
    aliases: strList(r.aliases),
    summary: r.summary,
    attributes: JSON.parse(r.attributes || '{}') as Record<string, string>,
    role: r.role,
    status: r.status,
    firstChunk: r.first_chunk,
    evidence: r.evidence,
    sourceRefs: JSON.parse(r.source_refs || '[]') as { source: string; locator: string }[],
    mentions: r.mentions,
    reviewStatus: r.review_status ?? 'accepted',
  }));
}

export function listRelations(
  db: Db,
  projectId: number,
  statuses?: readonly string[],
): CanonRelation[] {
  const params: unknown[] = [projectId];
  let sql = `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.description, r.evidence,
            r.supporting_evidence,
            a.name AS from_name, b.name AS to_name, r.modality, r.conflict_status,
            r.ledger_state, r.scope, r.review_status
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
     WHERE r.project_id = ?`;
  if (statuses?.length) {
    sql += ` AND r.review_status IN (${statuses.map(() => '?').join(',')})`;
    params.push(...statuses);
  }
  sql += ' ORDER BY r.id';
  const rows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    description: string;
    evidence: string;
    supporting_evidence: string;
    from_name: string;
    to_name: string;
    modality: string | null;
    conflict_status: string | null;
    ledger_state: string | null;
    scope: string | null;
    review_status: string | null;
  }>(
    sql,
    ...params,
  );
  return rows.map((r) => ({
    id: r.id,
    fromId: r.from_entity,
    fromName: r.from_name,
    toId: r.to_entity,
    toName: r.to_name,
    kind: r.kind,
    description: r.description,
    evidence: r.evidence,
    supportingEvidence: fromJson<Record<string, unknown>[]>(r.supporting_evidence, []).map((item) => ({
      quote: String(item.quote ?? ''),
      sourceRefs: Array.isArray(item.source_refs) ? item.source_refs : [],
      reason: String(item.reason ?? ''),
      movedAt: String(item.moved_at ?? ''),
      assessment: item.assessment ? readClaimAssessment(item.assessment as Record<string, unknown>) : null,
    })),
    modality: r.modality ?? 'asserted',
    conflictStatus: r.conflict_status ?? 'none',
    ledgerState: r.ledger_state ?? 'verified',
    scope: r.scope ?? '',
    reviewStatus: r.review_status ?? 'accepted',
  }));
}

/** One tie in a pair's story, with its story position when known. */
export interface StatusRow extends CanonRelation {
  /** canon_chunk.seq of the proving passage, or null when unplaceable. */
  seq: number | null;
  /** The passage locator (chapter + page) when known. */
  locator: string | null;
}

/** A pair's relationship over the story: what it is now, what it was. */
export interface PairStatus {
  current: StatusRow | null;
  history: StatusRow[];
}

/**
 * Read-time relationship status: append-only rows in, current-vs-history out.
 *
 * Every differing label the extraction banked stays banked; this lines them up
 * by story order (the proving passage's chunk seq, falling back to row order
 * for unplaceable rows) and calls the latest plain-stated row current. Denials
 * and maybes never become status. Same-window rivals keep whatever contested
 * flag the marking pass gave them; far-apart changes simply order as history.
 * With atSeq, the line stops there (unplaceable rows are excluded: a status
 * "at chapter 3" cannot rest on a claim going nowhere).
 */
export function pairHistory(
  db: Db,
  projectId: number,
  aId: number,
  bId: number,
  atSeq?: number,
): PairStatus {
  const rows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    description: string;
    evidence: string;
    supporting_evidence: string;
    from_name: string;
    to_name: string;
    modality: string | null;
    conflict_status: string | null;
    ledger_state: string | null;
    scope: string | null;
    review_status: string | null;
    source_refs: string;
  }>(
    `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.description, r.evidence,
            r.supporting_evidence,
            a.name AS from_name, b.name AS to_name, r.modality, r.conflict_status,
            r.ledger_state, r.scope, r.review_status, r.source_refs
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
     WHERE r.project_id = ?
       AND ((r.from_entity = ? AND r.to_entity = ?) OR (r.from_entity = ? AND r.to_entity = ?))
     ORDER BY r.id`,
    projectId, aId, bId, bId, aId,
  );
  const seqByChunk = new Map(
    db
      .all<{ id: number; seq: number; locator: string }>('SELECT id, seq, locator FROM canon_chunk WHERE project_id = ?', projectId)
      .map((c) => [c.id, c] as [number, { seq: number; locator: string }]),
  );
  const placed: StatusRow[] = rows.map((r) => {
    const chunkId = firstChunkOf(r.source_refs);
    const chunk = chunkId !== undefined ? seqByChunk.get(chunkId) : undefined;
    const seq = chunk ? chunk.seq : null;
    return {
      id: r.id,
      fromId: r.from_entity,
      fromName: r.from_name,
      toId: r.to_entity,
      toName: r.to_name,
      kind: r.kind,
      description: r.description,
      evidence: r.evidence,
      supportingEvidence: fromJson<Record<string, unknown>[]>(r.supporting_evidence, []).map((item) => ({
        quote: String(item.quote ?? ''),
        sourceRefs: Array.isArray(item.source_refs) ? item.source_refs : [],
        reason: String(item.reason ?? ''),
        movedAt: String(item.moved_at ?? ''),
        assessment: item.assessment ? readClaimAssessment(item.assessment as Record<string, unknown>) : null,
      })),
      modality: r.modality ?? 'asserted',
      conflictStatus: r.conflict_status ?? 'none',
      ledgerState: r.ledger_state ?? 'verified',
      scope: r.scope ?? '',
      reviewStatus: r.review_status ?? 'accepted',
      seq,
      locator: chunk ? chunk.locator : null,
    };
  });
  // Flagged rows are invisible to status until cleared: pending review reads
  // as no current, not as a guess. Human-confirmed rows stay visible.
  const cleared = placed.filter((r) => r.reviewStatus === 'accepted' || r.reviewStatus === 'user_confirmed');
  const visible = atSeq === undefined ? cleared : cleared.filter((r) => r.seq !== null && r.seq <= atSeq);
  visible.sort((x, y) => (x.seq ?? Number.POSITIVE_INFINITY) - (y.seq ?? Number.POSITIVE_INFINITY) || x.id - y.id);
  const asserted = visible.filter((r) => r.modality === 'asserted');
  const current = asserted.length ? asserted[asserted.length - 1]! : null;
  const history = current ? visible.filter((r) => r.id !== current.id) : visible;
  return { current, history };
}

/**
 * Directed status: A→B and B→A hold separate currents.
 *
 * The undirected pairHistory stays for history views; this is the answering
 * path, where a reversed arrow must become impossible, not just unlikely.
 * Each direction filters to its own arrow, orders by story position, and
 * names the latest asserted row current. Flagged rows stay invisible per
 * direction. Deterministic by construction.
 */
export function directedPairStatus(
  db: Db,
  projectId: number,
  aId: number,
  bId: number,
  atSeq?: number,
): { forward: PairStatus; reverse: PairStatus } {
  const one = (from: number, to: number): PairStatus => {
    const { current, history } = pairHistory(db, projectId, from, to, atSeq);
    // pairHistory reads both arrows; narrow to the requested one.
    const fwd = [current, ...history].filter(Boolean).filter(
      (r) => r!.fromId === from && r!.toId === to,
    ) as StatusRow[];
    fwd.sort((x, y) => (x.seq ?? Number.POSITIVE_INFINITY) - (y.seq ?? Number.POSITIVE_INFINITY) || x.id - y.id);
    const asserted = fwd.filter((r) => r.modality === 'asserted');
    const cur = asserted.length ? asserted[asserted.length - 1]! : null;
    return { current: cur, history: cur ? fwd.filter((r) => r.id !== cur.id) : fwd };
  };
  return { forward: one(aId, bId), reverse: one(bId, aId) };
}

export function listFacts(db: Db, projectId: number, topic?: string): CanonFact[] {
  const params: unknown[] = [projectId];
  let sql = 'SELECT * FROM canon_fact WHERE project_id = ?';
  if (topic) {
    sql += ' AND (topic = ? OR lower(topic) LIKE ?)';
    params.push(topic, `%${topic.toLowerCase()}%`);
  }
  sql += ' ORDER BY id';
  const rows = db.all<{
    id: number;
    topic: string;
    statement: string;
    kind: string;
    certainty: string;
    subject: string;
    evidence: string;
    source_refs: string;
    modality: string | null;
    conflict_status: string | null;
  }>(sql, ...params);
  return rows.map((r) => ({
    id: r.id,
    topic: r.topic,
    statement: r.statement,
    kind: r.kind,
    certainty: r.certainty,
    subject: r.subject,
    evidence: r.evidence,
    sourceRefs: JSON.parse(r.source_refs || '[]') as { source: string; locator: string }[],
    modality: r.modality ?? 'asserted',
    conflictStatus: r.conflict_status ?? 'none',
  }));
}

export function listTimeline(db: Db, projectId: number): CanonTimelineEntry[] {
  const rows = db.all<{
    id: number;
    canon_event: number | null;
    seq: number;
    title: string;
    summary: string;
    time_label: string;
    participants: string;
    location: string;
    evidence: string;
  }>('SELECT * FROM canon_timeline WHERE project_id = ? ORDER BY seq, id', projectId);
  return rows.map((r) => ({
    id: r.id,
    eventId: r.canon_event,
    seq: r.seq,
    title: r.title,
    summary: r.summary,
    when: r.time_label,
    participants: strList(r.participants),
    location: r.location,
    evidence: r.evidence,
  }));
}

export function updateEntity(
  db: Db,
  projectId: number,
  id: number,
  patch: Partial<Pick<CanonEntity, 'name' | 'summary' | 'role' | 'status' | 'kind'>>,
): void {
  const existing = db.get<{ id: number }>('SELECT id FROM canon_entity WHERE id = ? AND project_id = ?', id, projectId);
  if (!existing) return;
  db.run(
    'UPDATE canon_entity SET name = ?, summary = ?, role = ?, status = ?, kind = ?, updated_at = ? WHERE id = ?',
    patch.name ?? '',
    patch.summary ?? '',
    patch.role ?? '',
    patch.status ?? '',
    patch.kind ?? 'character',
    nowIso(),
    id,
  );
}

export function deleteEntity(db: Db, projectId: number, id: number): void {
  db.run('DELETE FROM canon_entity WHERE id = ? AND project_id = ?', id, projectId);
}

/* ------------------------------------------------------------------ brief */

export interface LoreBrief {
  entities: string;
  relations: string;
  facts: string;
}

/**
 * A compact, factual brief of the book lore.
 *
 * This is what the writer gets instead of (or alongside) raw passages: names,
 * roles, states, relationships and the rules of the world, each with the
 * citation it came from.
 */
export function buildLoreBrief(
  db: Db,
  projectId: number,
  opts: { names?: string[]; maxEntities?: number; includeFacts?: boolean } = {},
): LoreBrief {
  const all = listEntities(db, projectId);
  const names = (opts.names ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean);
  const matched = names.length
    ? all.filter(
        (e) =>
          names.some((n) => e.name.toLowerCase().includes(n) || e.aliases.some((a) => a.toLowerCase().includes(n))),
      )
    : all;
  const chosen = matched.slice(0, opts.maxEntities ?? 20);
  const relations = listRelations(db, projectId).filter(
    (r) => !names.length || chosen.some((e) => e.id === r.fromId || e.id === r.toId),
  );
  const facts = opts.includeFacts === false ? [] : listFacts(db, projectId);
  return renderBrief(chosen, relations, facts, names);
}

/** Turn lore records into the three text sections used in prompts. */
export function renderBrief(
  entities: CanonEntity[],
  relations: CanonRelation[],
  facts: CanonFact[],
  names: string[] = [],
): LoreBrief {
  const entityLines = entities.map((e) => {
    const bits = [
      e.summary,
      e.role ? `role: ${e.role}` : '',
      e.status ? `status: ${e.status}` : '',
      Object.entries(e.attributes)
        .map(([k, v]) => `${k}: ${v}`)
        .join('; '),
    ].filter(Boolean);
    const refs = e.sourceRefs.map((r) => r.locator).join(', ');
    return `- ${e.name}${e.aliases.length ? ` (${e.aliases.join(', ')})` : ''} [${e.kind}]` +
      `${bits.length ? `: ${bits.join('. ')}` : ''}${refs ? ` (${refs})` : ''}`;
  });

  const relationLines = relations.slice(0, 25).map(
    (r) => `- ${r.fromName} → ${r.toName}: ${r.kind}${r.description ? ` — ${r.description}` : ''}`,
  );

  const factLines = facts
    .filter((f) => !names.length || !f.subject || names.some((n) => f.subject.toLowerCase().includes(n)))
    .slice(0, 25)
    .map((f) => `- ${f.statement}${f.topic ? ` (${f.topic})` : ''}${f.certainty === 'inferred' ? ' [inferred]' : ''}`);

  return {
    entities: entityLines.join('\n'),
    relations: relationLines.join('\n'),
    facts: factLines.join('\n'),
  };
}

/** The brief rendered for a prompt. */
export function formatLoreBrief(brief: LoreBrief): string {
  const parts: string[] = [];
  if (brief.entities) parts.push(`PEOPLE, PLACES AND THINGS:\n${brief.entities}`);
  if (brief.relations) parts.push(`RELATIONSHIPS IN THE SOURCE:\n${brief.relations}`);
  if (brief.facts) parts.push(`ESTABLISHED BY THE SOURCE:\n${brief.facts}`);
  if (!parts.length) return '';
  return (
    parts.join('\n\n') +
    '\n\nUse these names, roles, states and rules exactly as given. Do not add numbers, ' +
    'cases or rules that are not stated here or in the retrieved passages.'
  );
}

/**
 * Find the lore entry a name refers to, exactly.
 *
 * IDENTITY policy: exact name, exact alias, or a fuller name with the asked
 * name as a whole prefix. This deliberately does not use LINK/fuzzy matching;
 * a question may be loose, but identity and merge decisions must not be.
 */
export function findEntity(db: Db, projectId: number, name: string): CanonEntity | undefined {
  const clean = (name ?? '').trim().toLowerCase();
  if (!clean) return undefined;
  const all = listEntities(db, projectId);
  const exact = all.find((e) => e.name.toLowerCase() === clean);
  if (exact) return exact;
  const alias = all.find((e) => e.aliases.some((a) => a.toLowerCase() === clean));
  if (alias) return alias;
  // A fuller name that starts with what was asked for: "Harry" -> "Harry Potter".
  return all.find((e) => e.name.toLowerCase().startsWith(clean + ' '));
}

/**
 * Look up lore entries that mention a name or phrase.
 *
 * Used by the lore researcher to answer from the extracted index first, and to
 * fill in context requests about a character.
 */
export function searchLore(db: Db, projectId: number, query: string, limit = 10): {
  entities: CanonEntity[];
  relations: CanonRelation[];
  facts: CanonFact[];
  timeline: CanonTimelineEntry[];
} {
  const q = query.trim().toLowerCase();
  if (!q) return { entities: [], relations: [], facts: [], timeline: [] };
  const allEntities = listEntities(db, projectId, undefined, ['accepted', 'user_confirmed']);
  const tokenDf = new Map<string, number>();
  for (const entity of allEntities) {
    const tokens = new Set<string>();
    for (const variant of [entity.name, ...entity.aliases]) {
      for (const token of canonicalName(variant).split(' ')) {
        if (token.length >= NAME_MIN_TOKEN) tokens.add(token);
      }
    }
    for (const token of tokens) tokenDf.set(token, (tokenDf.get(token) ?? 0) + 1);
  }
  const words = tokenize(q).filter((word) => (tokenDf.get(word) ?? 0) <= NAME_DF_CAP);
  if (!words.length) return { entities: [], relations: [], facts: [], timeline: [] };
  const matches = (hay: string): boolean => linkTokensMatch(words, textTokenSet(hay));

  const entities = allEntities.filter((e) => {
    if (e.reviewStatus !== 'accepted' && e.reviewStatus !== 'user_confirmed') return false;
    return matches(`${e.name} ${e.aliases.join(' ')} ${e.summary} ${e.role}`);
  });

  const rels = listRelations(db, projectId, ['accepted', 'user_confirmed']).filter((r) => {
    return matches(`${r.fromName} ${r.toName} ${r.kind} ${r.description}`);
  });

  const facts = listFacts(db, projectId).filter((f) => {
    return matches(`${f.topic} ${f.statement} ${f.subject}`);
  });

  const timeline = listTimeline(db, projectId).filter((t) => {
    return matches(`${t.title} ${t.summary} ${t.participants.join(' ')} ${t.location}`);
  });

  return {
    entities: entities.slice(0, limit),
    relations: rels.slice(0, limit),
    facts: facts.slice(0, limit),
    timeline: timeline.slice(0, limit),
  };
}

/** How much lore has been extracted, for the UI. */
export function loreStats(db: Db, projectId: number): {
  entities: number;
  relations: number;
  facts: number;
  timeline: number;
  characters: number;
  locations: number;
  rules: number;
} {
  const count = (sql: string, ...params: unknown[]) => db.get<{ n: number }>(sql, ...params)?.n ?? 0;
  return {
    entities: count('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', projectId),
    relations: count('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', projectId),
    facts: count('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', projectId),
    timeline: count('SELECT COUNT(*) AS n FROM canon_timeline WHERE project_id = ?', projectId),
    characters: count("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'character'", projectId),
    locations: count("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'location'", projectId),
    rules: count("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'rule'", projectId),
  };
}

/** One line per relationship pair, strongest row first. */
export interface RelationshipPair {
  fromName: string;
  toName: string;
  kind: string;
  status: string;
  locator: string;
  confirmedByUser: boolean;
  rows: number;
}

const RELATION_STATUS_RANK: Record<string, number> = {
  user_confirmed: 0,
  accepted: 1,
  provisional: 2,
  needs_review: 3,
};

/**
 * Collapse the relation table to one row per pair. The same two people may be
 * stored several times (inverse directions, repealed kinds, duplicate roster
 * rows); the strongest status wins and the rest are counted.
 */
export function listRelationshipPairs(db: Db, projectId: number): RelationshipPair[] {
  const rows = db.all<{
    id: number;
    from_id: number;
    to_id: number;
    from_name: string;
    to_name: string;
    kind: string;
    review_status: string;
    confirmed_by_user: number | null;
    source_refs: string;
  }>(
    `SELECT r.id, r.from_entity AS from_id, r.to_entity AS to_id,
            a.name AS from_name, b.name AS to_name, r.kind, r.review_status,
            r.confirmed_by_user, coalesce(r.source_refs, '[]') AS source_refs
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ?`,
    projectId,
  );
  const groups = new Map<string, { best: (typeof rows)[number]; count: number }>();
  for (const row of rows) {
    const key = `${Math.min(row.from_id, row.to_id)}|${Math.max(row.from_id, row.to_id)}`;
    const rank = row.confirmed_by_user === 1 ? 0 : RELATION_STATUS_RANK[row.review_status] ?? 4;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { best: row, count: 1 });
      continue;
    }
    group.count++;
    const bestRank =
      group.best.confirmed_by_user === 1 ? 0 : RELATION_STATUS_RANK[group.best.review_status] ?? 4;
    if (rank < bestRank) group.best = row;
  }
  const locatorOf = (refs: string): string => {
    try {
      const list = JSON.parse(refs) as { locator?: unknown }[];
      return list.map((r) => (typeof r.locator === 'string' ? r.locator.trim() : '')).find(Boolean) ?? '';
    } catch {
      return '';
    }
  };
  return [...groups.values()]
    .map(({ best, count }) => ({
      fromName: best.from_name,
      toName: best.to_name,
      kind: best.kind,
      status: best.confirmed_by_user === 1 ? 'user_confirmed' : best.review_status,
      locator: locatorOf(best.source_refs),
      confirmedByUser: best.confirmed_by_user === 1,
      rows: count,
    }))
    .sort(
      (a, b) =>
        (RELATION_STATUS_RANK[a.status] ?? 4) - (RELATION_STATUS_RANK[b.status] ?? 4) ||
        a.fromName.localeCompare(b.fromName) ||
        a.toName.localeCompare(b.toName),
    );
}

/** A pair the extractor proposed that never reached the bank. */
export interface TieProposal {
  fromName: string;
  toName: string;
  kind: string;
  reason: string;
  locator: string;
  notes: number;
}

/**
 * Pending tie notes, one row per pair, excluding pairs that already hold a
 * keeper. This is the review queue: everything the extractor offered and the
 * guard refused, with the reason it gave.
 */
export function listTieProposals(db: Db, projectId: number): TieProposal[] {
  const notes = db.all<{
    id: number;
    from_id: number;
    to_id: number;
    from_name: string;
    to_name: string;
    attempted_kind: string;
    reason: string;
    source_refs: string;
  }>(
    `SELECT n.id, n.from_entity AS from_id, n.to_entity AS to_id,
            a.name AS from_name, b.name AS to_name,
            n.attempted_kind, n.reason, coalesce(n.source_refs, '[]') AS source_refs
       FROM canon_tie_note n
       JOIN canon_entity a ON a.id = n.from_entity
       JOIN canon_entity b ON b.id = n.to_entity
      WHERE n.project_id = ? AND n.status = 'pending'`,
    projectId,
  );
  const keepers = new Set(
    db
      .all<{ a: number; b: number }>(
        `SELECT from_entity AS a, to_entity AS b FROM canon_relation
          WHERE project_id = ? AND (review_status = 'user_confirmed' OR confirmed_by_user = 1)`,
        projectId,
      )
      .map((r) => `${Math.min(r.a, r.b)}|${Math.max(r.a, r.b)}`),
  );
  const locatorOf = (refs: string): string => {
    try {
      const list = JSON.parse(refs) as { locator?: unknown }[];
      return list.map((r) => (typeof r.locator === 'string' ? r.locator.trim() : '')).find(Boolean) ?? '';
    } catch {
      return '';
    }
  };
  const groups = new Map<string, { note: (typeof notes)[number]; count: number }>();
  for (const note of notes) {
    const key = `${Math.min(note.from_id, note.to_id)}|${Math.max(note.from_id, note.to_id)}`;
    if (keepers.has(key)) continue;
    const group = groups.get(key);
    if (!group) groups.set(key, { note, count: 1 });
    else group.count++;
  }
  return [...groups.values()]
    .map(({ note, count }) => ({
      fromName: note.from_name,
      toName: note.to_name,
      kind: note.attempted_kind,
      reason: note.reason,
      locator: locatorOf(note.source_refs),
      notes: count,
    }))
    .sort((a, b) => b.notes - a.notes || a.fromName.localeCompare(b.fromName));
}
