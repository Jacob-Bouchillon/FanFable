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
import { Db, nowIso, strList, toJson } from './db.ts';
import { asRecordArray, extractJson, salvageJsonArray, toStringArray } from './json.ts';
import type { LlmClient } from './llm.ts';
import { embedMissing, type EmbedFn } from './embeddings.ts';
import { splitSentences, truncate } from './text.ts';

/* ------------------------------------------------------------------ models */

export type EntityKind = 'character' | 'location' | 'item' | 'rule' | 'faction' | 'creature';

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
    {"kind":"character|location|item|rule|faction|creature",
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
     "description":"one sentence","chunk_index":0,"evidence":"a short exact quote"}
  ],
  "facts": [
    {"topic":"the subject of the fact","statement":"what the book establishes",
     "kind":"rule|fact|background","certainty":"confirmed|inferred","subject":"name it concerns",
     "chunk_index":0,"evidence":"a short exact quote"}
  ],
  "timeline": [
    {"title":"what happens","summary":"one or two sentences","when":"when it happens, in the book's words",
     "participants":["names"],"location":"where","chunk_index":0,"evidence":"a short exact quote"}
  ]
}

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

export const EXTRACT_ENTITIES_SYSTEM = `You read passages from a book and record the people, places, things, groups, creatures and rules they establish, and the facts the passages state.

Reply with JSON only:
{
  "entities": [
    {"kind":"character|location|item|rule|faction|creature",
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
     "chunk_index":0,"evidence":"a short exact quote"}
  ]
}

Rules:
- Only record what these passages support. Never fill gaps with general knowledge.
- chunk_index is the number shown in front of each passage. Use it for every entry.
- evidence must be a short phrase copied from the passage, not your own words.
- If the passages contain no new people, places or facts, return empty arrays.
- No prose outside the JSON.`;

export const EXTRACT_RELATIONS_SYSTEM = `You read passages from a book and record relationships between the known entities listed below.

Reply with JSON only:
{
  "relations": [
    {"from":"a name from the list, exactly as written",
     "to":"another name from the list, exactly as written",
     "kind":"one short phrase, such as 'sibling of'",
     "description":"one sentence","chunk_index":0,"evidence":"a short exact quote"}
  ]
}

Rules:
- "from" and "to" must both be names from the KNOWN ENTITIES list. Do not invent a name, and do not use a name that is not listed, even if it appears in the passage.
- Only record a relationship these passages state explicitly. Never infer one.
- One relation per entry, with one kind. If two people have several relationships, write a separate entry for each.
- The direction matters: "from" is the one who has the relationship and "to" is the one it is to. If Harry is Petunia's nephew, it is from="Harry", to="Petunia", kind="nephew of".
- chunk_index is the number shown in front of each passage.
- evidence must be a short phrase copied from the passage, not your own words.
- If the passages state no new relationship, return an empty array.
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

/** Words that state a relationship or a role worth extracting. */
const KINSHIP_CUES = [
  'sibling', 'brother', 'sister', 'mother', 'father', 'son', 'daughter',
  'parent', 'child', 'aunt', 'uncle', 'cousin', 'nephew', 'niece',
  'husband', 'wife', 'spouse', 'married', 'widow',
  'king', 'queen', 'prince', 'princess', 'lord', 'lady',
  'master', 'servant', 'knight', 'captain', 'commander', 'heir',
];

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
        `${candidates.length - runList.length} left unmined`,
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
  const merged = mergeCanonEntities(db, projectId);
  stats.mergedAliases = merged.merged;
  stats.quarantinedAliases = merged.quarantined;
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
  rememberExtractionReport(db, projectId, stats);

  return stats;
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
  const merged = mergeCanonEntities(db, projectId);
  stats.mergedAliases = merged.merged;
  stats.quarantinedAliases = merged.quarantined;
  linkTimelineToEvents(db, projectId);
  stats.windows = targets.length;
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
    verification: { claimed: 0, verified: 0, repointed: 0, dropped: 0, unresolved: 0 },
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
        for (const c of window) db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE id = ?', c.id);
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
      }),
    );
  } catch {
    /* diagnostics are a nicety: never fail an extraction over them */
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
} | undefined {
  const row = db.get<{ value: string }>('SELECT value FROM schema_meta WHERE key = ?', `lore-extraction:${projectId}`);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as never;
  } catch {
    return undefined;
  }
}

/** One relation per pair: keep the most detailed description. */
function dedupeRelations(db: Db, projectId: number): void {
  const rows = db.all<{ id: number; from_entity: number; to_entity: number; kind: string; description: string }>(
    'SELECT id, from_entity, to_entity, kind, description FROM canon_relation WHERE project_id = ? ORDER BY id',
    projectId,
  );
  const seen = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    // The same pair can hold several relationships, so the kind is part of the key.
    const key = `${row.from_entity}:${row.to_entity}:${row.kind}`;
    const first = seen.get(key);
    if (!first) {
      seen.set(key, row);
      continue;
    }
    if (row.description.length > first.description.length) {
      db.run('UPDATE canon_relation SET kind = ?, description = ? WHERE id = ?', row.kind, row.description, first.id);
    }
    db.run('DELETE FROM canon_relation WHERE id = ?', row.id);
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
  const parsed = extractJson<Record<string, unknown>>(text);
  if (parsed && typeof parsed === 'object') {
    const values = asRecordArray(parsed[key]);
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
function windowEntityNames(db: Db, projectId: number, window: ChunkRow[]): string[] {
  const hay = normalise(window.map((c) => c.text).join(' '));
  const names: string[] = [];
  for (const entity of listEntities(db, projectId)) {
    const variants = [entity.name, ...entity.aliases].map(normalise).filter(Boolean);
    if (variants.some((v) => hay.includes(v))) names.push(entity.name);
  }
  return names.slice(0, 60);
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
    const dup = db.get<{ id: number }>(
      'SELECT id FROM canon_fact WHERE project_id = ? AND statement = ?',
      projectId,
      statement,
    );
    if (dup) {
      accepted++;
      continue;
    }
    const refs = span.chunkId !== null
      ? [{ source: span.source, locator: span.locator, chunk: span.chunkId }]
      : refsFor(chunk);
    db.run(
      `INSERT INTO canon_fact (project_id, topic, statement, kind, certainty, subject, evidence, source_refs, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      String(raw.topic ?? '').trim(),
      statement,
      String(raw.kind ?? 'fact').trim(),
      String(raw.certainty ?? 'confirmed').trim(),
      String(raw.subject ?? '').trim(),
      span.quote,
      toJson(refs),
      nowIso(),
    );
    stats.facts++;
    accepted++;
  }
  return accepted;
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
  for (const raw of raws) {
    const fromId = resolveEntity(db, projectId, entityIdByName, String(raw.from ?? ''));
    const toId = resolveEntity(db, projectId, entityIdByName, String(raw.to ?? ''));
    if (!fromId || !toId || fromId === toId) {
      // A relation naming someone who does not exist is not a claim about the
      // source; it is a name the relations call was told not to use.
      if (gate) stats.verification.unresolved++;
      continue;
    }
    const chunk = chunkAt(window, raw.chunk_index);
    const span = spanFor(raw.evidence, chunk, neighboursOf(chunk?.id), gate, stats.verification);
    if (span.status === 'dropped') continue;
    const refs = span.chunkId !== null
      ? [{ source: span.source, locator: span.locator, chunk: span.chunkId }]
      : refsFor(chunk);
    const kinds = normaliseKinds(String(raw.kind ?? ''));
    for (const kind of kinds) {
      const existing = db.get<{ id: number; kind: string; description: string; evidence: string }>(
        'SELECT id, kind, description, evidence FROM canon_relation WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND kind = ?',
        projectId,
        fromId,
        toId,
        kind,
      );
      if (existing) {
        // One relation per pair and kind: keep the richer description rather
        // than accumulating near-duplicates across extraction runs.
        const description = String(raw.description ?? '').trim();
        db.run(
          'UPDATE canon_relation SET kind = ?, description = ?, evidence = ? WHERE id = ?',
          existing.kind || kind,
          description.length > existing.description.length ? description : existing.description,
          span.quote || existing.evidence,
          existing.id,
        );
        accepted++;
        continue;
      }
      db.run(
        `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        fromId,
        toId,
        kind,
        String(raw.description ?? '').trim(),
        span.quote,
        toJson(refs),
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

  const ask = async (system: string, maxTok: number): Promise<string | null> => {
    try {
      const res = await llm.chat({
        system,
        messages: [{ role: 'user', content: passages }],
        temperature: 0.1,
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
    const second = await ask(system, Math.min(1200, maxTokens));
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
 * A name reduced to what it is safe to compare on.
 *
 * Case, possessives, a leading article and punctuation are noise; a plural is
 * not, so "Dursley" and "Dursleys" is handled separately and a name is never
 * singularised on its own ("James" must not become "Jame").
 */
function canonicalName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameTokens(name: string): string[] {
  return canonicalName(name).split(' ').filter(Boolean);
}

/**
 * How two names relate, deterministically.
 *
 *  - same:          the same name up to case, possessives and a plural
 *  - containment:   every word of the shorter name is in the longer one
 *  - null:          not a variant by rule
 */
function nameRelation(a: string, b: string): 'same' | 'containment' | null {
  const ka = canonicalName(a);
  const kb = canonicalName(b);
  if (!ka || !kb) return null;
  if (ka === kb) return 'same';
  if (ka === `${kb}s` || kb === `${ka}s`) return 'same';
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length !== tb.length) {
    const [short, long] = ta.length < tb.length ? [ta, tb] : [tb, ta];
    if (short.length && short.every((t) => long.includes(t))) return 'containment';
  }
  return null;
}

const SPEAKER_VERBS =
  'said|asked|replied|answered|whispered|shouted|cried|muttered|added|continued|repeated|snapped|murmured|yelled|called';

/** The names used as dialogue speakers in a passage, lowercased. */
function speakersIn(text: string): string[] {
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
function speakerChunksByEntity(db: Db, projectId: number): Map<number, Set<number>> {
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
function sharedSpeakerScene(
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

/** A cheap "these two look like the same person" test for quarantine. */
function looksAlike(a: string, b: string): { alike: boolean; reason: string } {
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
      const rels = db.all<{ id: number; from_entity: number; to_entity: number; kind: string; description: string; evidence: string }>(
        'SELECT id, from_entity, to_entity, kind, description, evidence FROM canon_relation WHERE project_id = ? AND (from_entity = ? OR to_entity = ?)',
        projectId,
        drop.id,
        drop.id,
      );
      for (const r of rels) {
        const from = r.from_entity === drop.id ? keep.id : r.from_entity;
        const to = r.to_entity === drop.id ? keep.id : r.to_entity;
        if (from === to) {
          db.run('DELETE FROM canon_relation WHERE id = ?', r.id);
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
      db.run('DELETE FROM canon_entity WHERE id = ?', drop.id);
    });
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

/* ------------------------------------------------- timeline ↔ event join */

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

function normaliseKind(kind: string): EntityKind {
  const k = kind.toLowerCase();
  if (k.includes('loc') || k.includes('place')) return 'location';
  if (k.includes('item') || k.includes('object') || k.includes('thing')) return 'item';
  if (k.includes('rule') || k.includes('law') || k.includes('magic') || k.includes('lore')) return 'rule';
  if (k.includes('faction') || k.includes('group') || k.includes('family')) return 'faction';
  if (k.includes('creature') || k.includes('animal') || k.includes('beast')) return 'creature';
  return 'character';
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
    ?? db.get<{ id: number }>('SELECT id FROM canon_entity WHERE project_id = ? AND lower(name) = lower(?)', projectId, clean)?.id;
  if (found) cache.set(key(clean), found);
  return found;
}

/* ------------------------------------------------------------- retrieval */

export function listEntities(db: Db, projectId: number, kind?: EntityKind): CanonEntity[] {
  const params: unknown[] = [projectId];
  let sql = 'SELECT * FROM canon_entity WHERE project_id = ?';
  if (kind) {
    sql += ' AND kind = ?';
    params.push(kind);
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
  }));
}

export function listRelations(db: Db, projectId: number): CanonRelation[] {
  const rows = db.all<{
    id: number;
    from_entity: number;
    to_entity: number;
    kind: string;
    description: string;
    evidence: string;
    from_name: string;
    to_name: string;
  }>(
    `SELECT r.id, r.from_entity, r.to_entity, r.kind, r.description, r.evidence,
            a.name AS from_name, b.name AS to_name
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
     WHERE r.project_id = ? ORDER BY r.id`,
    projectId,
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
  }));
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
 * Loose search is useful for questions ("what does the warden know") but
 * wrong for a person: "Harry Potter" must not return Aunt Petunia.
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
  const words = q.split(/[^a-z0-9']+/).filter((w) => w.length > 2);

  const entities = listEntities(db, projectId).filter((e) => {
    const hay = `${e.name} ${e.aliases.join(' ')} ${e.summary} ${e.role}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });

  const rels = listRelations(db, projectId).filter((r) => {
    const hay = `${r.fromName} ${r.toName} ${r.kind} ${r.description}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });

  const facts = listFacts(db, projectId).filter((f) => {
    const hay = `${f.topic} ${f.statement} ${f.subject}`.toLowerCase();
    return words.some((w) => hay.includes(w));
  });

  const timeline = listTimeline(db, projectId).filter((t) => {
    const hay = `${t.title} ${t.summary} ${t.participants.join(' ')} ${t.location}`.toLowerCase();
    return words.some((w) => hay.includes(w));
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
