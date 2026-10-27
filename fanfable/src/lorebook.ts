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
import { lexicalScore, splitSentences, tokenize, truncate } from './text.ts';
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
  canonicalName,
  linkTokenMatch,
  linkTokensMatch,
  nameMentionedExact,
  nameMentionedFromTokens,
  nameRelation,
  nameTokens,
  NAME_DF_CAP,
  NAME_MIN_TOKEN,
  textTokenSet,
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

export interface CanonRelation {
  id: number;
  fromId: number;
  fromName: string;
  toId: number;
  toName: string;
  kind: string;
  description: string;
  evidence: string;
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

export const EXTRACT_RELATIONS_SYSTEM = `You read passages from a book and record relationships between the known entities listed below.

Reply with JSON only:
{
  "relations": [
    {"from":"a name from the list, exactly as written",
     "to":"another name from the list, exactly as written",
     "kind":"one short phrase, such as 'sibling of'",
     "description":"one sentence","chunk_index":0,"evidence":"a short exact quote",
     "modality":"asserted|denied|possible|suspected — only include when not asserted"}
  ]
}

Rules:
- "from" and "to" must both be names from the KNOWN ENTITIES list. Do not invent a name, and do not use a name that is not listed, even if it appears in the passage.
- Record only a lasting tie these passages state explicitly. A tie stays true pages later (family, lasting roles, friend or enemy). A moment happens once (met, gave, told, saw, wished, refused) and is never a tie, even when stated: moments belong to events, and a moment label is dropped and counted. A noun tie must be spoken in its quote: sister, brother, father and their kin only bank when the proving sentence says the word. Never infer one.
- Be exhaustive, not representative: list EVERY lasting tie the passages state explicitly — most windows contain several, and a long list is good while a missed tie is bad. Do not stop after the first few entries, and do not pad the list with moments. When in doubt whether a stated tie is lasting, include it with its quote and let the gates decide.
- evidence must be a phrase copied VERBATIM from the passage, long enough to state the tie on its own (a name plus the tie word), not your own words and not a two-word fragment.
- One relation per entry, with one kind. If two people have several relationships, write a separate entry for each.
- The direction matters: "from" is the one who has the relationship and "to" is the one it is to. If Harry is Petunia's nephew, it is from="Harry", to="Petunia", kind="nephew of".
- chunk_index is the number shown in front of each passage.
- evidence must be a short phrase copied from the passage, not your own words.
- If the passages state no new relationship, return an empty array.
- If the passage denies, doubts, or frames something as merely possible, record the claim normally but set modality to denied/possible/suspected with the denying quote as evidence; never store a denial as a plain fact.
- No prose outside the JSON.`;

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
  emptyWindows: EmptyWindowReport[];
  quarantinedAliases: QuarantinedAlias[];
  mergedAliases: string[];
  /** Budget selection, when a budget applied. Absent means everything ran. */
  selection?: { selected: number; total: number; skipped: number };
  /** Rival-claim rows flagged contested by this run. */
  contested?: { facts: number; relations: number };
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

  const selection = selectWindows(
    candidates.map(({ window }) => scoreWindow(window, docFreq)),
    opts,
  );
  const chosen = new Set(selection.selected);
  const runList = candidates.filter((_, i) => chosen.has(i));
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
  rememberExtractionReport(db, projectId, stats);
  writeAuditNote(projectId, 'extract', [
    `windows visited: ${stats.windows}`,
    `ties banked: ${stats.relations}`,
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
  await runWindowBatch(db, llm, projectId, targets, ctx, new Map<string, number>(), stats, {
    concurrency: Math.max(1, Math.min(opts.concurrency ?? 3, 4)),
    maxTokens: opts.maxTokens ?? 3000,
    singlePrompt: opts.singlePrompt === true,
    windowSize,
    totalChunks: chunks.length,
    onProgress: opts.onProgress,
    onWindow: opts.onWindow,
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
    verification: { claimed: 0, verified: 0, repointed: 0, dropped: 0, unresolved: 0, unrelated: 0, moment: 0, redundant: 0, unsupported: 0, hinted: 0 },
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
            await extractWindowLegacy(db, llm, projectId, window, entityIdByName, stats, ctx.neighboursOf, batch.maxTokens);
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
function dedupeRelations(db: Db, projectId: number): void {
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
    db.run(
      'UPDATE canon_relation SET description = ?, evidence = ?, source_refs = ?, review_status = ? WHERE id = ?',
      description,
      evidence,
      sourceRefs,
      review,
      first.id,
    );
    db.run('DELETE FROM canon_relation WHERE id = ?', row.id);
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

/** Parse one section of an answer, salvaging it when the answer was cut off. */
function parseSection(text: string, key: string): Record<string, unknown>[] {
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

/**
 * The entities this window actually mentions.
 *
 * The relations call is only allowed to use these names, so it cannot invent a
 * person and cannot attach a relation to a name it hallucinated.
 */
export function windowEntityNames(db: Db, projectId: number, window: ChunkRow[]): string[] {
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
  return names.slice(0, 60);
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
const BANK_RANK_TIER = { keeper: 3, parked: 2, mention: 1, text: 0 } as const;
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
 * A keeper is confirmed (user or accepted) and states a tie. `appears_with`
 * is a mention: two names in one passage, coverage and never evidence.
 * Everything else is parked. Mirrors the answer rule: only keeper-grade ties
 * may be stated.
 */
function relationTier(relation: BankRelationRow): BankProofTier {
  const kind = canonicalName(relation.kind);
  if (kind === 'appears with') return 'mention';
  if (relation.status === 'accepted' || relation.status === 'user_confirmed') return 'keeper';
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
  status: 'keeper' | 'none' | 'several';
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
  const a = m[1].trim().replace(/^["'“”]+|["'“”]+$/g, '');
  const b = m[2].trim().replace(/^["'“”]+|["'“”]+$/g, '');
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
  locator?: string;
}

/**
 * One keeper lookup for an explicit pair. It returns every accepted or
 * user-confirmed row between the named sides, in either direction, keeping the
 * guard's existing "any accepted tie" semantics. The answer line filters this
 * to a plain relational keeper before rendering.
 */
export function lookupKeeperPair(
  db: Db,
  projectId: number,
  a: string,
  b: string,
): PairKeeper[] {
  const entities = listEntities(db, projectId);
  const resolve = (name: string): number[] => {
    const q = (name ?? '').trim().toLowerCase();
    return entities
      .filter(
        (e) =>
          e.name.toLowerCase() === q ||
          e.aliases.some((alias) => alias.toLowerCase() === q),
      )
      .map((e) => e.id);
  };
  const idsA = resolve(a);
  const idsB = resolve(b);
  if (!idsA.length || !idsB.length) return [];
  if (idsA.some((id) => idsB.includes(id))) return [];
  const placeholders = (ids: number[]): string => ids.map(() => '?').join(',');
  const rows = db.all<{
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
  }>(
    `SELECT r.id, r.from_entity, r.to_entity, a.name AS from_name, b.name AS to_name,
            r.kind, r.evidence, r.modality, r.review_status, r.source_refs
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
     WHERE r.project_id = ?
       AND r.review_status IN ('accepted','user_confirmed')
       AND ((r.from_entity IN (${placeholders(idsA)}) AND r.to_entity IN (${placeholders(idsB)}))
         OR (r.from_entity IN (${placeholders(idsB)}) AND r.to_entity IN (${placeholders(idsA)})))
     ORDER BY r.id`,
    projectId,
    ...idsA,
    ...idsB,
    ...idsB,
    ...idsA,
  );
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
      ...(chunk !== undefined && locators.has(chunk) ? { locator: locators.get(chunk)! } : {}),
    };
  });
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
      return { status: 'none', reason: 'The bank holds no keeper for this pair.' };
    }
    const directed = directedPairStatus(db, projectId, rows[0]!.fromId, rows[0]!.toId);
    const currentId = directed.forward.current?.id ?? directed.reverse.current?.id;
    const row = rows.find((candidate) => candidate.id === currentId) ?? rows[0]!;
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
): number {
  let accepted = 0;
  // Fresh per call: entities created earlier in the same run are visible.
  const roster = rosterTokens(db, projectId);
  for (const raw of raws) {
    const fromName = String(raw.from ?? '').trim();
    const toName = String(raw.to ?? '').trim();
    const fromId = resolveEntity(db, projectId, entityIdByName, fromName);
    const toId = resolveEntity(db, projectId, entityIdByName, toName);
    if (!fromId || !toId || fromId === toId) {
      // A relation naming someone the bank has never seen is a recall hole,
      // not noise: keep the names, kind and quote as a hint. No entity is
      // created and nothing is promoted to a relation.
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
    const chunk = chunkAt(window, raw.chunk_index);
    const span = spanFor(raw.evidence, chunk, neighboursOf(chunk?.id), gate, stats.verification);
    if (span.status === 'dropped') continue;
    // Hard gate (gated path only): a quote about neither endpoint names a
    // third roster person instead. Never written — an unprovable tie is
    // worse than a missing one. The pre-gate path keeps its lenient flag.
    const relevant = proofRelevance(roster, fromId, toId, span.quote);
    // Misattached proof: the quote names a third roster person without
    // naming both endpoints (Pax Teem + Aks Moe proving Pax Teem + Kim).
    // Never accepted — at best pending until a both-endpoints quote arrives.
    const bothNamed = [fromId, toId].every((id) =>
      [...(roster.get(id) ?? [])].some((t) => proofTokens(span.quote, 3).has(t)),
    );
    let thirdParty = false;
    if (!bothNamed) {
      const words = proofTokens(span.quote, 3);
      for (const [id, toks] of roster) {
        if (id === fromId || id === toId) continue;
        for (const t of toks) {
          if (words.has(t)) { thirdParty = true; break; }
        }
        if (thirdParty) break;
      }
    }
    const misattached = thirdParty && !bothNamed;
    // A quote naming neither endpoint proves nothing about the pair, even
    // with no third party in it ("thus are lasting partnerships solidified"
    // for a tie between two named people). Pending, never accepted: pronoun and
    // scene color can be re-proved, but they must not bank.
    const anyNamed = [fromId, toId].some((id) =>
      [...(roster.get(id) ?? [])].some((t) => proofTokens(span.quote, 3).has(t)),
    );
    const review = relevant && !misattached && anyNamed ? 'accepted' : 'needs_review';
    if (!relevant && gate) {
      stats.verification.unrelated++;
      continue;
    }
    const refs = span.chunkId !== null
      ? [{ source: span.source, locator: span.locator, chunk: span.chunkId }]
      : refsFor(chunk);
    // Endpoint silence leaves a case file, not just a parked row: without a
    // note the relabel pass would never reconsider the tie. Only for closed
    // kinds — open vocabulary gets its own note below, and the unique index
    // keeps one note per pair+kind.
    if (relevant && !misattached && !anyNamed) {
      const firstKind = normaliseKinds(String(raw.kind ?? ''))[0] ?? 'related to';
      if (isClosedRoleKind(firstKind)) {
        stats.verification.unsupported++;
        persistTieNote(db, projectId, fromId, toId, firstKind, 'unsupported', span.quote, toJson(refs));
      }
    }
    const kinds = normaliseKinds(String(raw.kind ?? ''));
    for (const kind of kinds) {
      // Moments are not ties, flagged or otherwise: what happened belongs to
      // events. The happening banks as an event with both people attached;
      // the tie question parks as a note. Counted throughout, never lost.
      // Silent nouns keep a flagged tie row: the label IS relationship-
      // shaped, only its quote is silent. The judge or a human decides.
      let flagged: 'unsupported' | 'open-vocab' | null = null;
      if (isMomentKind(kind)) {
        stats.verification.moment++;
        bankMomentEvent(db, projectId, fromId, toId, kind, String(raw.description ?? '').trim(), span, chunk);
        persistTieNote(db, projectId, fromId, toId, kind, 'moment', span.quote, toJson(refs));
        continue;
      }
      if (isUnsupportedKind(kind, span.quote)) {
        stats.verification.unsupported++;
        persistTieNote(db, projectId, fromId, toId, kind, 'unsupported', span.quote, toJson(refs));
        flagged = 'unsupported';
      }
      // Open vocabulary parks: the kind is no closed role noun (kinship,
      // titled role, human-gated peer/colleague), so it can never bank
      // accepted. It stays pending with reason open-vocab-kind — the
      // encourager/acknowledger class — invisible to status until cleared.
      if (!flagged && !isClosedRoleKind(kind)) {
        stats.verification.unsupported++;
        persistTieNote(db, projectId, fromId, toId, kind, 'open-vocab', span.quote, toJson(refs));
        flagged = 'open-vocab';
      }
      // A generic kinship word repeats a specific one: "parent of" beside
      // "father of" says nothing new. Pure dedupe, not a meaning judgment:
      // the generic drops, the specific stands, the counter ticks.
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
        for (const [generic, kinds] of GENERIC_KINSHIP) {
          if (!kinds.has(lk)) continue;
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
      const rowReview = flagged ? 'needs_review' : review;
      // The same claim in two words: one pair, one quote, one head verb
      // ("trusts with life" beside "trusts with important task"). Merge into
      // the earliest row instead of banking both; the longer telling wins,
      // exactly like the same-label merge below.
      const headWord = (k: string): string => {
        const stop = new Set(['a', 'an', 'the', 'to', 'of', 'with', 'by', 'for', 'in', 'on', 'at']);
        return k.toLowerCase().split(/[^a-z]+/).filter((w) => w && !stop.has(w))[0] ?? '';
      };
      const rivals = db.all<{ id: number; kind: string; description: string; evidence: string; source_refs: string; review_status: string }>(
        `SELECT id, kind, description, evidence, source_refs, review_status FROM canon_relation
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
        const twinReview = rowReview === 'needs_review' || twin.review_status === 'needs_review' ? 'needs_review' : twin.review_status;
        db.run(
          'UPDATE canon_relation SET kind = ?, description = ?, evidence = ?, source_refs = ?, review_status = ? WHERE id = ?',
          twin.kind,
          sentence,
          quote,
          sourceRefs,
          twinReview,
          twin.id,
        );
        accepted++;
        continue;
      }
      const existing = db.get<{ id: number; kind: string; description: string; evidence: string; source_refs: string; review_status: string }>(
        `SELECT id, kind, description, evidence, source_refs, review_status
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
        db.run(
          'UPDATE canon_relation SET description = ?, evidence = ?, source_refs = ?, review_status = ? WHERE id = ?',
          sentence,
          quote,
          sourceRefs,
          mergedReview,
          existing.id,
        );
        accepted++;
        continue;
      }
      db.run(
        `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, review_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        fromId,
        toId,
        kind,
        String(raw.description ?? '').trim(),
        span.quote,
        toJson(refs),
        normaliseModality(raw.modality),
        rowReview,
        nowIso(),
      );
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
  applyRelations(db, projectId, parsed.relations, window, entityIdByName, stats, neighboursOf, false);
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
  const names = windowEntityNames(db, projectId, window);
  if (names.length) {
    const system = `${EXTRACT_RELATIONS_SYSTEM}\n\nKNOWN ENTITIES:\n${names.map((n) => `- ${n}`).join('\n')}`;
    const second = await ask(system, Math.min(3000, maxTokens), 0);
    if (second !== null) {
      const relations = parseSection(second, 'relations');
      parsedClaims += relations.length;
      accepted += applyRelations(db, projectId, relations, window, entityIdByName, stats, neighboursOf, true);
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
  'married to', 'uncle of', 'aunt of', 'nephew of', 'niece of', 'cousin of',
  'relative of', 'friend of', 'enemy of', 'ally of', 'teacher of', 'student of',
  'mentor of', 'leader of', 'member of', 'peer of', 'colleague of',
];

/** Closed role-noun list for bankable tie kinds: universal kin + titled roles +
 * the human-gated peer/colleague set. Seeded from kinds banked as accepted on
 * the frozen sheet's correct answers. Anything outside it parks as
 * needs_review with reason open-vocab-kind — never banks accepted. */
export const CLOSED_ROLE_KINDS = [
  ...CLOSED_TIE_LABELS,
  'aide of', 'apprentice of', 'assistant of', 'master of', 'operative for',
  'partner', 'partner with',
];

/** True when the kind resolves to the closed role-noun list. */
export function isClosedRoleKind(kind: string): boolean {
  return CLOSED_ROLE_KINDS.includes((kind ?? '').trim().toLowerCase());
}

/** Park a dropped tie for the batched relabeling pass. Reruns collide on
 * the pair-plus-label index and add nothing. */
function persistTieNote(
  db: Db,
  projectId: number,
  fromId: number,
  toId: number,
  attemptedKind: string,
  reason: 'moment' | 'unsupported' | 'open-vocab' | 'evaluation',
  evidence: string,
  sourceRefs: string,
  ruling = '',
): void {
  db.run(
    `INSERT OR IGNORE INTO canon_tie_note (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status, ruling, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    projectId,
    fromId,
    toId,
    attemptedKind,
    reason,
    evidence,
    sourceRefs,
    ruling,
    nowIso(),
  );
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
          db.run("UPDATE canon_relation SET review_status = 'needs_review' WHERE id = ?", r.id);
        } else {
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

export interface TieNoteResolution {
  resolved: number;
  confirmed: number;
  unproven: number;
  checked: number;
  pending: number;
}

/**
 * One closed-vocabulary pass over parked tie notes.
 *
 * Each pending note (a moment label or a quote-silent noun) is re-asked once
 * with its proving passage: name one label from the closed universal list,
 * or unresolvable, with an exact quote. Anything banked re-enters through
 * the same gates (moment, support, endpoint naming) — the pass can only
 * promote what the rules would have kept. Malformed answers stay pending:
 * fail-open per note, exactly like the quarantine judge.
 */
export async function resolveTieNotes(
  db: Db,
  llm: LlmClient,
  projectId: number,
  opts: { maxNotes?: number; afterId?: number; onProgress?: (message: string) => void } = {},
): Promise<TieNoteResolution> {
  const maxNotes = Math.max(1, opts.maxNotes ?? 25);
  const afterId = Math.max(0, opts.afterId ?? 0);
  const remaining = (): number =>
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ? AND status = 'pending'",
      projectId,
    )?.n ?? 0;
  const notes = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    attempted_kind: string;
    reason: string;
    evidence: string;
    source_refs: string;
    from_name: string;
    to_name: string;
  }>(
    `SELECT n.id, n.from_entity, n.to_entity, n.attempted_kind, n.reason, n.evidence,
            n.source_refs, fe.name AS from_name, te.name AS to_name
       FROM canon_tie_note n
       JOIN canon_entity fe ON fe.id = n.from_entity
       JOIN canon_entity te ON te.id = n.to_entity
      WHERE n.project_id = ? AND n.status = 'pending' AND n.id > ? ORDER BY n.id LIMIT ?`,
    projectId,
    afterId,
    maxNotes,
  );
  let resolved = 0;
  let confirmed = 0;
  let unproven = 0;
  const norm = (s: string): string =>
    s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  const settle = (id: number, status: 'resolved' | 'confirmed-drop', ruling: string): void => {
    db.run(
      "UPDATE canon_tie_note SET status = ?, ruling = ?, ruled_at = ? WHERE id = ? AND project_id = ?",
      status,
      ruling,
      nowIso(),
      id,
      projectId,
    );
  };
  for (const note of notes) {
    opts.onProgress?.(`note ${note.from_name} / ${note.to_name} (${note.attempted_kind})`);
    let chunkId: number | null = null;
    try {
      const refs = JSON.parse(note.source_refs || '[]') as { chunk?: unknown }[];
      for (const ref of refs) {
        const n = Number(ref?.chunk);
        if (Number.isFinite(n) && n > 0) {
          chunkId = n;
          break;
        }
      }
    } catch {
      chunkId = null;
    }
    const chunk = chunkId
      ? db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', chunkId)
      : null;
    if (!chunk?.text) {
      unproven++;
      continue;
    }
    const passage = chunk.text.slice(0, 1500);
    // What the pair did together rides along: actions are context for the
    // tie decision. Both names in the recorded participants, newest first.
    const like = (s: string): string => s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const doings = db.all<{ title: string; summary: string }>(
      `SELECT title, summary FROM canon_event WHERE project_id = ? AND participants LIKE ? ESCAPE '\\' AND participants LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 5`,
      projectId,
      `%${like(note.from_name)}%`,
      `%${like(note.to_name)}%`,
    );
    const context = doings.length
      ? `WHAT THEY DID TOGETHER:\n${doings.map((d) => `- ${d.title}${d.summary ? `: ${d.summary.slice(0, 140)}` : ''}`).join('\n')}\n\n`
      : '';
    let label = '';
    let quote = '';
    try {
      const res = await llm.chat({
        system:
          'You relabel one claimed tie using only the passage. Reply with JSON only: {"label": "exactly one of the allowed labels, or unresolvable", "quote": "an exact phrase from the passage"}. Start with {. No other words.',
        messages: [{
          role: 'user',
          content:
            `PAIR: ${note.from_name} / ${note.to_name}\nOLD LABEL: ${note.attempted_kind}\n` +
            `ALLOWED: ${CLOSED_ROLE_KINDS.join(', ')}\n\n${context}PASSAGE:\n${passage}`,
        }],
        temperature: 0.1,
        maxTokens: 300,
      });
      const raw = (res.text ?? '').replace(/```json|```/g, '');
      const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
        label?: unknown;
        quote?: unknown;
      };
      label = String(parsed.label ?? '').trim().toLowerCase();
      quote = norm(String(parsed.quote ?? ''));
    } catch {
      unproven++;
      continue;
    }
    if (!label || label === 'unresolvable') {
      // No tie here after all: clear the flagged attempt so it stops
      // showing up badged, and close the note. Accepted rows are never
      // touched — only flagged ones of the attempted label.
      db.run(
        `DELETE FROM canon_relation WHERE project_id = ? AND lower(kind) = ? AND review_status = 'needs_review'
          AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?))`,
        projectId,
        note.attempted_kind.toLowerCase(),
        note.from_entity,
        note.to_entity,
        note.to_entity,
        note.from_entity,
      );
      settle(note.id, 'confirmed-drop', label || 'unresolvable');
      confirmed++;
      continue;
    }
    if (!CLOSED_ROLE_KINDS.includes(label) || isMomentKind(label)) {
      unproven++;
      continue;
    }
    if (quote.length <= 10 || !norm(passage).includes(quote) || isUnsupportedKind(label, quote)) {
      unproven++;
      continue;
    }
    if (!quoteNamesEndpoint(db, projectId, note.from_entity, note.to_entity, quote)) {
      unproven++;
      continue;
    }
    const dup = db.get<{ id: number }>(
      'SELECT id FROM canon_relation WHERE project_id = ? AND lower(kind) = ? AND review_status = ? AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?))',
      projectId,
      label,
      'accepted',
      note.from_entity,
      note.to_entity,
      note.to_entity,
      note.from_entity,
    );
    if (!dup) {
      // The relabeled tie supersedes the flagged attempt: remove flagged rows
      // of the old label so the pair is not counted twice, then bank clean.
      // Never resolve without a row: a colliding needs_review row leaves the
      // note pending for a human rather than marking success with no bank.
      db.run(
        `DELETE FROM canon_relation WHERE project_id = ? AND lower(kind) = ? AND review_status = 'needs_review'
          AND ((from_entity = ? AND to_entity = ?) OR (from_entity = ? AND to_entity = ?))`,
        projectId,
        note.attempted_kind.toLowerCase(),
        note.from_entity,
        note.to_entity,
        note.to_entity,
        note.from_entity,
      );
      const added = db.run(
        `INSERT OR IGNORE INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, review_status, created_at)
          VALUES (?, ?, ?, ?, '', ?, ?, 'asserted', 'accepted', ?)`,
        projectId,
        note.from_entity,
        note.to_entity,
        label,
        quote,
        note.source_refs,
        nowIso(),
      );
      if (added.changes === 0) {
        unproven++;
        continue;
      }
    }
    settle(note.id, 'resolved', label);
    resolved++;
  }
  const out = { resolved, confirmed, unproven, checked: notes.length, pending: remaining() };
  writeAuditNote(projectId, 'relabel', [
    `notes checked: ${out.checked}`,
    `resolved: ${out.resolved}, confirmed drops: ${out.confirmed}, left pending: ${out.unproven}`,
    `still waiting: ${out.pending}`,
  ], db);
  return out;
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
    from_name: string;
    to_name: string;
  }>(
    `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.description, r.evidence,
            r.source_refs, fe.name AS from_name, te.name AS to_name
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
    db.run(
      "UPDATE canon_relation SET review_status = 'needs_review' WHERE id = ? AND project_id = ?",
      row.id,
      projectId,
    );
    persistTieNote(db, projectId, row.from_entity, row.to_entity, row.kind, 'evaluation', row.evidence, row.source_refs, reason || 'drop');
    parked++;
  }
  const out = { kept, parked, unproven, checked: rows.length };
  writeAuditNote(projectId, 'evaluate', [
    `ties checked: ${out.checked}`,
    `kept: ${out.kept}, parked: ${out.parked}, untouched: ${out.unproven}`,
  ], db);
  return out;
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
  const words = (kind ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words.some((w) => MOMENT_WORDS.has(w));
}

/**
 * Kin words that share one meaning. A noun tie banks only when the quote
 * itself says the word or one of its kin: "sister of" needs sister, sibling
 * or brother in the proving sentence, not merely nearby. Verb phrases and
 * unlisted words skip this check — the moment gate already handles verbs.
 */
const KIN_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['sibling', 'brother', 'sister']),
  new Set(['parent', 'mother', 'father']),
  new Set(['child', 'son', 'daughter']),
  new Set(['spouse', 'wife', 'husband', 'married', 'marriage']),
  new Set(['grandmother', 'grandfather', 'grandson', 'granddaughter']),
  new Set(['relative', 'relation', 'relationship', 'family', 'kin', 'uncle', 'aunt', 'cousin', 'nephew', 'niece']),
  new Set(['friend', 'friends', 'friendly']),
  new Set(['enemy', 'enemies', 'foe']),
  new Set(['ally', 'allies']),
  new Set(['teacher', 'student', 'mentor', 'master', 'servant', 'guardian', 'commander', 'captain']),
  new Set(['peer', 'peers', 'colleague', 'colleagues', 'coworker', 'coworkers', 'co-worker']),
];

/** The kin groups a label touches, if any. Empty means no noun to check. */
function kinGroupsOf(kind: string): ReadonlySet<string>[] {
  const words = new Set((kind ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean));
  return KIN_GROUPS.filter((g) => [...g].some((w) => words.has(w)));
}

/**
 * True when the quote fails to speak the tie's noun: the label names a kin
 * group no word of the quote belongs to. "Cousin of" proved by "What's his
 * name again?" is exactly this — true from knowledge, silent in the sentence.
 *
 * Closed role nouns outside the kin groups ("apprentice", "aide", "partner",
 * "operative", "member", "leader", "assistant") get the same treatment with
 * plain plural tolerance: an "apprentice of" proved by a quote that never
 * says the word banks nothing. Open vocabulary is not this rule's job.
 */
const KIND_FILLER = new Set(['of', 'to', 'with', 'for', 'a', 'the', 'an', 'in', 'on', 'as']);

export function isUnsupportedKind(kind: string, quote: string): boolean {
  const groups = kinGroupsOf(kind);
  const quoteWords = new Set((quote ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean));
  if (groups.length) {
    const want = new Set<string>();
    for (const g of groups) for (const w of g) want.add(w);
    return ![...want].some((w) => quoteWords.has(w));
  }
  if (!isClosedRoleKind(kind)) return false;
  const want: string[] = [];
  for (const w of (kind ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    if (KIND_FILLER.has(w)) continue;
    want.push(w, `${w}s`, `${w}es`);
  }
  if (!want.length) return false;
  return !want.some((w) => quoteWords.has(w));
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
