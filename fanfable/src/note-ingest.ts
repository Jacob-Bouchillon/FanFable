/**
 * Note ingestion: turn what the bank already holds into immutable thread notes.
 *
 * This is the layer that makes the web accumulate evidence. It reads rows the
 * extractor already wrote and records them as clues on their threads, with the
 * open ends that keep an investigation alive. It invents nothing: no model is
 * called here, and nothing the guard decided is changed.
 *
 * The one rule everything passes through is the verbatim gate: a note is
 * written only when its quote is byte-for-byte inside the chunk it cites. A
 * fabricated or repaired quote never becomes a note; it is counted and skipped.
 *
 * Identity and context notes are clues, not relationship evidence. Context
 * notes carry `is_context = 1`; identity notes live on a person thread. Neither
 * ever raises a birth's evidence score (see meetings.ts).
 */
import { createHash } from 'node:crypto';
import { Db, fromJson, nowIso } from './db.ts';
import { pickPeriodThread } from './threads.ts';
import { isClosedRoleKind, projectMinConfidence, storedAssessment } from './lorebook.ts';
import { recordRuling } from './ruling.ts';

/** Why a candidate note was not written. */
export type SkipReason =
  | 'no-thread'
  | 'no-quote'
  | 'no-chunk'
  | 'not-verbatim'
  | 'empty-claim'
  | 'no-assertable-claim'
  | 'non-person-endpoint'
  | 'no-character-endpoint'
  | 'verb-kind'
  | 'no-identity-evidence';

/** What the quote itself states, mechanically. */
export type EvidenceClass = 'asserted' | 'implied' | 'scene';

export type StrengthSource = 'assessed' | 'derived' | 'context' | 'default';

/** A relation kind that asserts nothing about two people. */
const VERB_KINDS: ReadonlySet<string> = new Set(['', 'was', 'had', 'is', 'has']);

export interface IngestCounts {
  /** Notes actually written (or, on a dry run, that would be written). */
  notes: number;
  pairNotes: number;
  identityNotes: number;
  contextNotes: number;
  openEnds: number;
  skipped: Record<SkipReason, number>;
  /** Where each note's strength came from. */
  strengthSource: Record<StrengthSource, number>;
  /** How many notes landed in each strength band. */
  strengthBands: { '0.0-0.2': number; '0.2-0.5': number; '0.5-0.8': number; '0.8-1.0': number };
  /** Notes that recorded which concept they asserted. */
  claimKinds: Record<string, number>;
  /** True when nothing was inserted. */
  dryRun: boolean;
}

export function blankIngestCounts(dryRun = false): IngestCounts {
  return {
    notes: 0,
    pairNotes: 0,
    identityNotes: 0,
    contextNotes: 0,
    openEnds: 0,
    skipped: {
      'no-thread': 0,
      'no-quote': 0,
      'no-chunk': 0,
      'not-verbatim': 0,
      'empty-claim': 0,
      'no-assertable-claim': 0,
      'non-person-endpoint': 0,
      'no-character-endpoint': 0,
      'verb-kind': 0,
      'no-identity-evidence': 0,
    },
    strengthSource: { assessed: 0, derived: 0, context: 0, default: 0 },
    strengthBands: { '0.0-0.2': 0, '0.2-0.5': 0, '0.5-0.8': 0, '0.8-1.0': 0 },
    claimKinds: {},
    dryRun,
  };
}

/** Which band a strength falls in, for reporting. */
export function strengthBand(value: number): keyof IngestCounts['strengthBands'] {
  const s = Math.min(1, Math.max(0, value));
  if (s <= 0.2) return '0.0-0.2';
  if (s <= 0.5) return '0.2-0.5';
  if (s <= 0.8) return '0.5-0.8';
  return '0.8-1.0';
}

/** Lowercase, punctuation-light, whitespace-collapsed: the dedupe normal form. */
export function normaliseForDedupe(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A note's stable identity: the normalised quote and claim together.
 *
 * The same passage read twice produces the same key and adds nothing. A
 * genuinely different claim about the same quote is a different key and is
 * allowed, because one quote can support more than one observation.
 */
export function noteDedupeKey(quote: string, claim: string): string {
  return createHash('sha256')
    .update(`${normaliseForDedupe(quote)}|${normaliseForDedupe(claim)}`)
    .digest('hex');
}

interface RefLike {
  chunk?: unknown;
  locator?: unknown;
  quote?: unknown;
}

/** First numeric chunk id in a source_refs array. */
function firstChunkId(sourceRefs: unknown): number | null {
  for (const ref of fromJson<RefLike[]>(sourceRefs as string, [])) {
    const n = Number(ref?.chunk);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function firstLocator(sourceRefs: unknown): string {
  for (const ref of fromJson<RefLike[]>(sourceRefs as string, [])) {
    const locator = String(ref?.locator ?? '').trim();
    if (locator) return locator;
  }
  return '';
}

function chunkText(db: Db, projectId: number, chunkId: number): string | null {
  const row = db.get<{ text: string }>(
    'SELECT text FROM canon_chunk WHERE id = ? AND project_id = ?',
    chunkId,
    projectId,
  );
  return row?.text ?? null;
}

/** The verbatim gate, in one place. */
export function isVerbatimInChunk(text: string | null, quote: string): boolean {
  if (!text) return false;
  const q = String(quote ?? '');
  return q.trim().length > 0 && text.includes(q);
}

/** Longest claim a note may carry; the rest is noise for a one-line clue. */
const MAX_CLAIM_CHARS = 200;

function normaliseSpace(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function wordCount(text: string): number {
  return normaliseSpace(text).split(' ').filter(Boolean).length;
}

export function truncateClaim(text: string): string {
  const clean = normaliseSpace(text);
  return clean.length <= MAX_CLAIM_CHARS ? clean : `${clean.slice(0, MAX_CLAIM_CHARS - 1).trimEnd()}…`;
}

export interface ClaimSource {
  fromName: string;
  toName: string;
  kind: string;
  why: string;
  quote: string;
}

/**
 * The assertion in words, never the pattern "<From> and <To>: <kind>".
 *
 * Order: the stored reasoning when it reads as a sentence, else the passage
 * sentence naming both people, else a kind phrase — and only when that kind is
 * one of the closed concepts. Otherwise there is nothing assertable and the
 * caller counts it instead of inventing a claim.
 */
export function assertableClaim(src: ClaimSource): { claim: string } | { claim: null } {
  const why = normaliseSpace(src.why);
  if (wordCount(why) >= 4) return { claim: truncateClaim(why) };
  const sentence = bothNamesSentence(src.quote, src.fromName, src.toName);
  if (sentence && wordCount(sentence) >= 3) return { claim: truncateClaim(sentence) };
  const kind = src.kind.trim().toLowerCase();
  if (kind && isClosedRoleKind(kind)) {
    return { claim: truncateClaim(`${src.fromName} ${kind} ${src.toName}`) };
  }
  return { claim: null };
}

interface NoteInput {
  threadId: number;
  chunkId: number;
  locator: string;
  quote: string;
  /** null when nothing assertable can be said; counted under `claimMiss`. */
  claim: string | null;
  claimMiss?: 'empty-claim' | 'no-assertable-claim' | 'no-identity-evidence';
  why: string;
  missing: string;
  strength: number;
  isContext: boolean;
  kind: 'observation' | 'context';
  strengthSource?: StrengthSource;
  /** The concept the note asserts, when it comes from a relation. */
  claimKind?: string;
  /** The relation this note came from, when it came from one. */
  relationId?: number | null;
}

/**
 * Write one note, or explain why not.
 *
 * Insert-only, exactly as M1 made it: there is no update path, and the dedupe
 * key makes a repeat a no-op rather than a duplicate.
 */
function writeNote(db: Db, projectId: number, input: NoteInput, counts: IngestCounts): number | null {
  // The gate comes first: a quote that is not in its chunk never becomes a
  // note, whatever could have been said about it.
  const text = chunkText(db, projectId, input.chunkId);
  if (!isVerbatimInChunk(text, input.quote)) {
    counts.skipped['not-verbatim']++;
    return null;
  }
  const claim = (input.claim ?? '').trim();
  if (!claim) {
    counts.skipped[input.claimMiss ?? 'empty-claim']++;
    return null;
  }
  const key = noteDedupeKey(input.quote, claim);
  const existing = db.get<{ id: number }>(
    'SELECT id FROM canon_thread_note WHERE thread_id = ? AND dedupe_key = ?',
    input.threadId,
    key,
  );
  if (existing) return existing.id;
  if (counts.dryRun) {
    counts.notes++;
    if (input.isContext) counts.contextNotes++;
    counts.strengthSource[input.strengthSource ?? 'default']++;
    counts.strengthBands[strengthBand(input.strength)]++;
    return null;
  }
  const id = Number(
    db.run(
      `INSERT INTO canon_thread_note
         (project_id, thread_id, chunk_id, locator, quote, claim, note_kind, strength,
          why, missing, is_context, supersedes_note_id, dedupe_key, strength_source, claim_kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      projectId,
      input.threadId,
      input.chunkId,
      input.locator,
      input.quote,
      claim,
      input.kind,
      Math.min(1, Math.max(0, Number(input.strength) || 0)),
      input.why,
      input.missing,
      input.isContext ? 1 : 0,
      key,
      input.strengthSource ?? 'default',
      input.claimKind ?? '',
      nowIso(),
    ).lastInsertRowid,
  );
  counts.claimKinds[input.claimKind ?? ''] = (counts.claimKinds[input.claimKind ?? ''] ?? 0) + 1;
  counts.notes++;
  if (input.isContext) counts.contextNotes++;
  counts.strengthSource[input.strengthSource ?? 'default']++;
  counts.strengthBands[strengthBand(input.strength)]++;
  recordRuling(db, projectId, {
    relationId: input.relationId ?? null,
    threadId: input.threadId,
    role: 'clue',
    actor: 'chain',
    standard: 'verbatim-quote',
    toStatus: 'note',
    basis: `note ${id} quote verbatim in chunk ${input.chunkId}`,
    quote: input.quote,
  });
  return id;
}

/** Open-end dedupe is by thread and question, so a rerun adds nothing. */
function ensureOpenEnd(
  db: Db,
  projectId: number,
  threadId: number,
  question: string,
  origin: string,
  wouldResolve: string,
  counts: IngestCounts,
): boolean {
  const existing = db.get<{ id: number }>(
    'SELECT id FROM canon_open_end WHERE thread_id = ? AND question = ?',
    threadId,
    question,
  );
  if (existing) return false;
  counts.openEnds++;
  if (counts.dryRun) return true;
  db.run(
    `INSERT INTO canon_open_end (project_id, thread_id, question, origin, would_resolve, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`,
    projectId,
    threadId,
    question,
    origin,
    wouldResolve,
    nowIso(),
  );
  return true;
}

function pairThreadId(db: Db, projectId: number, a: number, b: number): number | null {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const row = db.get<{ id: number }>(
    `SELECT id FROM canon_thread
      WHERE project_id = ? AND kind = 'pair' AND a_entity = ? AND b_entity = ? AND parent_a_thread IS NULL
      ORDER BY id LIMIT 1`,
    projectId,
    lo,
    hi,
  );
  return row?.id ?? null;
}

function personThreadId(db: Db, projectId: number, entityId: number): number | null {
  const row = db.get<{ id: number }>(
    `SELECT id FROM canon_thread
      WHERE project_id = ? AND kind = 'person' AND a_entity = ? AND b_entity IS NULL AND parent_a_thread IS NULL
      ORDER BY id LIMIT 1`,
    projectId,
    entityId,
  );
  return row?.id ?? null;
}

/**
 * Get or create the thread a note belongs on.
 *
 * Ingestion is where evidence arrives, so it cannot assume the thread already
 * exists: the first extraction of a book creates entities and relations in the
 * same run. Creating the investigation here is the same row `syncThreads` would
 * make, and its identity key keeps the two from racing into duplicates.
 * A dry run never writes, and reports the missing thread as a skip instead.
 */
function ensurePersonThread(db: Db, projectId: number, entityId: number, counts: IngestCounts): number | null {
  const found = personThreadId(db, projectId, entityId);
  if (found !== null) return found;
  if (counts.dryRun) return null;
  const at = nowIso();
  return Number(
    db.run(
      `INSERT INTO canon_thread
         (project_id, kind, a_entity, b_entity, pair_thread_id, status, birth_reason, created_at, updated_at)
       VALUES (?, 'person', ?, NULL, NULL, 'open', '', ?, ?)`,
      projectId,
      entityId,
      at,
      at,
    ).lastInsertRowid,
  );
}

function ensurePairThread(
  db: Db,
  projectId: number,
  a: number,
  b: number,
  seq: number | null,
  counts: IngestCounts,
): number | null {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const threads = db
    .all<{ id: number; period_from_seq: number | null; period_to_seq: number | null; period_label: string }>(
      `SELECT id, period_from_seq, period_to_seq, period_label FROM canon_thread
        WHERE project_id = ? AND kind = 'pair' AND a_entity = ? AND b_entity = ? AND parent_a_thread IS NULL
        ORDER BY id`,
      projectId,
      lo,
      hi,
    )
    .map((row) => ({
      id: row.id,
      periodFromSeq: row.period_from_seq ?? null,
      periodToSeq: row.period_to_seq ?? null,
      periodLabel: row.period_label,
    }));
  // One thread for the pair behaves exactly as before; several means the
  // passage decides which period of the pair the clue belongs to.
  const picked = pickPeriodThread(threads, seq);
  if (picked !== null) return picked;
  if (counts.dryRun) return null;
  const structural =
    db.get<{ id: number }>(
      'SELECT id FROM canon_pair_thread WHERE project_id = ? AND a_entity = ? AND b_entity = ?',
      projectId,
      lo,
      hi,
    )?.id ?? null;
  const at = nowIso();
  return Number(
    db.run(
      `INSERT INTO canon_thread
         (project_id, kind, a_entity, b_entity, pair_thread_id, status, birth_reason,
          period_label, period_from_seq, period_to_seq, temporal_status, created_at, updated_at)
       VALUES (?, 'pair', ?, ?, ?, 'open', '', '', ?, ?, 'unknown', ?, ?)`,
      projectId,
      lo,
      hi,
      structural,
      seq,
      seq,
      at,
      at,
    ).lastInsertRowid,
  );
}

function threadLabel(db: Db, projectId: number, threadId: number): string {
  const row = db.get<{ kind: string; a_name: string; b_name: string | null }>(
    `SELECT t.kind, COALESCE(ea.name, '') AS a_name, eb.name AS b_name
       FROM canon_thread t
       LEFT JOIN canon_entity ea ON ea.id = t.a_entity
       LEFT JOIN canon_entity eb ON eb.id = t.b_entity
      WHERE t.id = ? AND t.project_id = ?`,
    threadId,
    projectId,
  );
  if (!row) return '';
  return row.kind === 'pair' ? `${row.a_name} and ${row.b_name ?? ''}` : row.a_name;
}

/** The stored reason a row was parked, when the inbox has one. */
function parkedReason(db: Db, projectId: number, relation: { id: number; from: number; to: number; kind: string }): string {
  const row = db.get<{ reason: string }>(
    `SELECT reason FROM canon_tie_note
      WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND attempted_kind = ?
      ORDER BY id DESC LIMIT 1`,
    projectId,
    relation.from,
    relation.to,
    relation.kind,
  );
  return row?.reason?.trim() ?? '';
}

interface RelationRow {
  id: number;
  from_entity: number;
  to_entity: number;
  kind: string;
  description: string;
  evidence: string;
  source_refs: string;
  confidence: number;
  review_status: string;
  from_name: string;
  to_name: string;
  from_kind: string;
  to_kind: string;
  supporting_evidence: string;
}

/**
 * Record one relation candidate as a pair note, at any review status.
 *
 * Held-aside clues are still clues: provisional and needs_review rows become
 * notes too, with the reason they are held in `missing`. A candidate that does
 * not settle its question also gets an open end.
 */
function quoteMentions(quote: string, name: string): boolean {
  const q = quote.toLowerCase();
  const n = name.trim().toLowerCase();
  return n.length > 0 && q.includes(n);
}

/**
 * What the quote itself states, mechanically.
 *
 * There is no semantic classifier here and none is needed: the only signals
 * the code owns are whether both endpoints are named and whether anything is
 * named at all.
 */
export function classifyEvidence(args: { quote: string; namesBoth: boolean; namesOne: boolean }): EvidenceClass {
  if (!String(args.quote ?? '').trim()) return 'scene';
  if (args.namesBoth) return 'asserted';
  if (args.namesOne) return 'implied';
  return 'scene';
}

export interface DerivedStrength {
  strength: number;
  strengthSource: StrengthSource;
  isContext: boolean;
}

/**
 * A note's strength, never a default of 1.0.
 *
 * A stored assessment wins. Without one, the quote's own shape decides: a tie
 * stated about both people is strong, a one-sided mention is weak, and mere
 * co-presence is context at the bottom of the scale.
 */
export function deriveStrength(rel: RelationRow, quote: string): DerivedStrength {
  const assessment = storedAssessment(rel.supporting_evidence);
  if (assessment) {
    const value = Number(assessment.strength);
    const strength =
      Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.2;
    // The note kind follows what the assessment says the quote is, not just
    // its number: a scene is context however strong the model rated it, and a
    // one-sided assertion is still an observation.
    const namesBoth = assessment.names_both === true;
    const asserted = assessment.asserted === true;
    const otherPerson = String((assessment as { other_person?: string }).other_person ?? '');
    const namedOther = otherPerson === 'named' || otherPerson === 'role';
    const uncertain = assessment.hedge === 'hedged' || assessment.hedge === 'doubted' || assessment.hedge === 'denied';
    if (!namesBoth && (!asserted || uncertain)) {
      return { strength, strengthSource: 'assessed', isContext: true };
    }
    if (asserted && (namesBoth || namedOther)) {
      return { strength, strengthSource: 'assessed', isContext: false };
    }
    return { strength, strengthSource: 'assessed', isContext: false };
  }
  const namesBoth = bothNamesSentence(quote, rel.from_name, rel.to_name) !== null;
  const namesOne = quoteMentions(quote, rel.from_name) || quoteMentions(quote, rel.to_name);
  const cls = classifyEvidence({ quote, namesBoth, namesOne });
  if (cls === 'asserted') {
    return { strength: namesBoth ? 0.9 : 0.6, strengthSource: 'derived', isContext: false };
  }
  if (cls === 'implied') {
    return { strength: 0.35, strengthSource: 'derived', isContext: false };
  }
  return { strength: 0.2, strengthSource: 'context', isContext: true };
}

function ingestRelation(db: Db, projectId: number, rel: RelationRow, counts: IngestCounts): void {
  const chunkId = firstChunkId(rel.source_refs);
  const seq =
    chunkId === null
      ? null
      : (db.get<{ seq: number }>('SELECT seq FROM canon_chunk WHERE id = ? AND project_id = ?', chunkId, projectId)
          ?.seq ?? null);
  const quote = rel.evidence.trim();
  const why = rel.description.trim();
  const kindLower = rel.kind.trim().toLowerCase();
  const kindLabel = kindLower || 'a tie';
  const question = `does the text establish ${kindLabel} between ${rel.from_name} and ${rel.to_name}?`;
  const wouldResolve = 'a passage naming both people with the tie stated';

  const derived = deriveStrength(rel, quote);
  const strengthSource = derived.strengthSource;

  const held =
    !derived.isContext &&
    (derived.strength < projectMinConfidence(db, projectId) ||
      rel.review_status === 'provisional' ||
      rel.review_status === 'needs_review');
  const missing =
    rel.review_status === 'provisional'
      ? 'below the confidence threshold'
      : rel.review_status === 'needs_review'
        ? parkedReason(db, projectId, {
            id: rel.id,
            from: rel.from_entity,
            to: rel.to_entity,
            kind: rel.kind,
          }) || 'held for review'
        : '';
  /** File the same observation on one person's thread. */
  const writeIdentity = (entityId: number, reason: string): void => {
    if (!quote || chunkId === null) return;
    const claim = assertableClaim({
      fromName: rel.from_name,
      toName: rel.to_name,
      kind: rel.kind,
      why,
      quote,
    });
    const thread = ensurePersonThread(db, projectId, entityId, counts);
    if (thread === null) {
      counts.skipped['no-thread']++;
      return;
    }
    const before = counts.notes;
    writeNote(
      db,
      projectId,
      {
        threadId: thread,
        chunkId,
        locator: firstLocator(rel.source_refs),
        quote,
        claim: claim.claim,
        claimMiss: 'no-assertable-claim',
        why,
        missing: reason,
        strength: derived.strength,
        isContext: derived.isContext,
        kind: derived.isContext ? 'context' : 'observation',
        strengthSource,
        claimKind: kindLower,
        relationId: rel.id,
      },
      counts,
    );
    if (counts.notes > before) counts.identityNotes++;
  };

  // Attribute routing: a species, faction or item is not a relationship
  // endpoint. The fact belongs to the person it is about.
  const fromIsPerson = rel.from_kind === 'character';
  const toIsPerson = rel.to_kind === 'character';
  if (!fromIsPerson || !toIsPerson) {
    if (!fromIsPerson && !toIsPerson) {
      counts.skipped['no-character-endpoint']++;
      return;
    }
    counts.skipped['non-person-endpoint']++;
    writeIdentity(fromIsPerson ? rel.from_entity : rel.to_entity, 'non-person-endpoint');
    return;
  }

  // A verb is not a kind. Keep the property, drop the pseudo-relationship.
  if (VERB_KINDS.has(kindLower)) {
    counts.skipped['verb-kind']++;
    for (const [entityId, name] of [
      [rel.from_entity, rel.from_name],
      [rel.to_entity, rel.to_name],
    ] as const) {
      if (quoteMentions(quote, name)) writeIdentity(entityId, 'verb-kind');
    }
    return;
  }

  const threadId = ensurePairThread(db, projectId, rel.from_entity, rel.to_entity, seq, counts);

  if (threadId === null) {
    counts.skipped['no-thread']++;
    // Attach the want to a known endpoint rather than losing it.
    const fallback =
      ensurePersonThread(db, projectId, rel.from_entity, counts) ??
      ensurePersonThread(db, projectId, rel.to_entity, counts);
    if (fallback !== null) ensureOpenEnd(db, projectId, fallback, question, `relation ${rel.id}`, wouldResolve, counts);
    return;
  }

  if (!quote) {
    counts.skipped['no-quote']++;
    ensureOpenEnd(db, projectId, threadId, question, `relation ${rel.id}`, wouldResolve, counts);
    return;
  }
  if (chunkId === null) {
    counts.skipped['no-chunk']++;
    ensureOpenEnd(db, projectId, threadId, question, `relation ${rel.id}`, wouldResolve, counts);
    return;
  }

  const claim = assertableClaim({
    fromName: rel.from_name,
    toName: rel.to_name,
    kind: rel.kind,
    why,
    quote,
  });

  const before = counts.notes;
  const noteId = writeNote(
    db,
    projectId,
    {
      threadId,
      chunkId,
      locator: firstLocator(rel.source_refs),
      quote,
      claim: claim.claim,
      claimMiss: 'no-assertable-claim',
      why,
      missing,
      strength: derived.strength,
      isContext: derived.isContext,
      kind: derived.isContext ? 'context' : 'observation',
      strengthSource,
      claimKind: kindLower,
      relationId: rel.id,
    },
    counts,
  );
  if (counts.notes > before) counts.pairNotes++;

  if (held) {
    ensureOpenEnd(
      db,
      projectId,
      threadId,
      question,
      noteId !== null ? `note ${noteId}` : `relation ${rel.id}`,
      wouldResolve,
      counts,
    );
  }
}

const RELATION_SQL = `
  SELECT r.id, r.from_entity, r.to_entity, r.kind, r.description, r.evidence, r.source_refs,
         r.confidence, r.review_status, r.supporting_evidence,
         fa.name AS from_name, fb.name AS to_name,
         fa.kind AS from_kind, fb.kind AS to_kind
    FROM canon_relation r
    JOIN canon_entity fa ON fa.id = r.from_entity
    JOIN canon_entity fb ON fb.id = r.to_entity
   WHERE r.project_id = ?
   ORDER BY r.id`;

/** Entity evidence becomes an identity note on that person's thread. */
function ingestEntity(db: Db, projectId: number, entity: {
  id: number;
  name: string;
  kind: string;
  evidence: string;
  first_chunk: number | null;
  source_refs: string;
  confidence: number;
}, counts: IngestCounts): void {
  const threadId = ensurePersonThread(db, projectId, entity.id, counts);
  if (threadId === null) {
    counts.skipped['no-thread']++;
    return;
  }
  const quote = entity.evidence.trim();
  if (!quote) {
    // No quote means no note: the verbatim gate applies to identity notes too.
    counts.skipped['no-identity-evidence']++;
    return;
  }
  const chunkId = entity.first_chunk ?? firstChunkId(entity.source_refs);
  if (chunkId === null) {
    counts.skipped['no-chunk']++;
    return;
  }
  const before = counts.notes;
  // D: the claim restates what the bank knows, never our own column.
  const claim =
    normaliseSpace(entity.evidence).length > 0
      ? truncateClaim(entity.evidence)
      : normaliseSpace((entity as { summary?: string }).summary ?? '').length > 0
        ? truncateClaim(String((entity as { summary?: string }).summary))
        : null;
  if (!claim) {
    counts.skipped['no-identity-evidence']++;
    return;
  }
  writeNote(
    db,
    projectId,
    {
      threadId,
      chunkId,
      locator: firstLocator(entity.source_refs),
      quote,
      claim,
      claimMiss: 'no-identity-evidence',
      why: '',
      missing: '',
      strength: 0.6,
      isContext: false,
      kind: 'observation',
      strengthSource: 'derived',
    },
    counts,
  );
  if (counts.notes > before) counts.identityNotes++;
}

const ENTITY_SQL = `
  SELECT id, name, kind, evidence, first_chunk, source_refs, confidence
    FROM canon_entity
   WHERE project_id = ?
   ORDER BY id`;

/**
 * Give every thread with nothing to go on an open question.
 *
 * This is the starvation signal the contract asks for: a thread with no notes
 * and no question is invisible to a reader, so it gets one.
 */
function openEndsForEmptyThreads(db: Db, projectId: number, counts: IngestCounts): void {
  const rows = db.all<{ id: number }>(
    `SELECT t.id
       FROM canon_thread t
      WHERE t.project_id = ?
        AND NOT EXISTS (SELECT 1 FROM canon_thread_note n WHERE n.thread_id = t.id)
        AND NOT EXISTS (SELECT 1 FROM canon_open_end o WHERE o.thread_id = t.id)
      ORDER BY t.id`,
    projectId,
  );
  for (const row of rows) {
    const label = threadLabel(db, projectId, row.id);
    ensureOpenEnd(
      db,
      projectId,
      row.id,
      `what evidence connects ${label || 'this thread'}?`,
      'thread sync',
      'any passage naming the thread subject',
      counts,
    );
  }
}

/**
 * Seed notes from everything the bank already holds.
 *
 * Safe to re-run: dedupe keys and open-end questions make a second pass a
 * no-op. `dryRun` counts what would happen without writing anything.
 */
export function backfillThreadNotes(db: Db, projectId: number, opts: { dryRun?: boolean } = {}): IngestCounts {
  const counts = blankIngestCounts(opts.dryRun === true);
  const run = counts.dryRun ? <T>(fn: () => T): T => fn() : <T>(fn: () => T): T => db.transaction(fn);
  run(() => {
    for (const rel of db.all<RelationRow>(RELATION_SQL, projectId)) ingestRelation(db, projectId, rel, counts);
    for (const entity of db.all<{
      id: number;
      name: string;
      kind: string;
      evidence: string;
      first_chunk: number | null;
      source_refs: string;
      confidence: number;
    }>(ENTITY_SQL, projectId)) {
      ingestEntity(db, projectId, entity, counts);
    }
    openEndsForEmptyThreads(db, projectId, counts);
    // Opposition between notes on one thread is recorded, never judged.
    if (!counts.dryRun) markContradictions(db, projectId);
  });
  return counts;
}

/**
 * Feed the web from one extraction window.
 *
 * Called after a window's rows are committed. It reads only rows that exist,
 * applies the same verbatim gate, and is idempotent through the dedupe key, so
 * re-running an extraction adds nothing new. It never throws into extraction.
 *
 * Context notes are co-presence records: two named people inside one passage.
 * They carry `is_context = 1` and are never relationship evidence.
 */
export function noteFromExtraction(
  db: Db,
  projectId: number,
  window: { id: number }[],
  stats?: { notesIngested?: number },
): IngestCounts {
  const counts = blankIngestCounts(false);
  const windowIds = new Set(window.map((chunk) => chunk.id));
  if (!windowIds.size) return counts;

  db.transaction(() => {
    // Relations whose cited passage sits in this window.
    for (const rel of db.all<RelationRow>(RELATION_SQL, projectId)) {
      const chunkId = firstChunkId(rel.source_refs);
      if (chunkId === null || !windowIds.has(chunkId)) continue;
      ingestRelation(db, projectId, rel, counts);
    }
    // Entities whose evidence sits in this window.
    for (const entity of db.all<{
      id: number;
      name: string;
      kind: string;
      evidence: string;
      first_chunk: number | null;
      source_refs: string;
      confidence: number;
    }>(
      "SELECT id, name, kind, evidence, first_chunk, source_refs, confidence FROM canon_entity WHERE project_id = ? AND evidence <> '' AND first_chunk IN (SELECT value FROM json_each(?)) ORDER BY id",
      projectId,
      JSON.stringify([...windowIds]),
    )) {
      ingestEntity(db, projectId, entity, counts);
    }
    writeContextNotes(db, projectId, windowIds, counts);
  });

  if (stats) stats.notesIngested = (stats.notesIngested ?? 0) + counts.notes;
  return counts;
}

/** Cap on co-presence notes per window, so one crowded scene cannot flood the web. */
const MAX_CONTEXT_NOTES = 40;

/** A sentence naming both endpoints, found by plain case-insensitive search. */
function bothNamesSentence(text: string, a: string, b: string): string | null {
  if (!a || !b) return null;
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const low = sentence.toLowerCase();
    if (low.includes(a.toLowerCase()) && low.includes(b.toLowerCase())) return sentence.trim();
  }
  return null;
}

/**
 * Co-presence notes: a pair thread whose shared passage falls in this window.
 *
 * These are the "both appeared here" clues. They are context, never evidence,
 * and are capped per window in thread-id order so the result is deterministic.
 *
 * Deliberately a plain substring test rather than the derived-variant matcher:
 * a context note must never claim more than the literal names show.
 */
function writeContextNotes(db: Db, projectId: number, windowIds: Set<number>, counts: IngestCounts): void {
  const rows = db.all<{ id: number; shared_chunks: string; a_name: string; b_name: string }>(
    `SELECT t.id, p.shared_chunks, ea.name AS a_name, eb.name AS b_name
       FROM canon_thread t
       JOIN canon_pair_thread p ON p.id = t.pair_thread_id
       JOIN canon_entity ea ON ea.id = t.a_entity
       JOIN canon_entity eb ON eb.id = t.b_entity
      WHERE t.project_id = ? AND t.kind = 'pair' AND t.parent_a_thread IS NULL
      ORDER BY t.id`,
    projectId,
  );
  let written = 0;
  for (const row of rows) {
    if (written >= MAX_CONTEXT_NOTES) break;
    const shared = fromJson<number[]>(row.shared_chunks, []);
    const chunkId = shared.find((id) => windowIds.has(Number(id)));
    if (chunkId === undefined) continue;
    const text = chunkText(db, projectId, Number(chunkId));
    const sentence = text ? bothNamesSentence(text, row.a_name, row.b_name) : null;
    if (!sentence) continue;
    const locator = db.get<{ locator: string }>(
      'SELECT locator FROM canon_chunk WHERE id = ?',
      Number(chunkId),
    )?.locator ?? '';
    const before = counts.notes;
    writeNote(
      db,
      projectId,
      {
        threadId: row.id,
        chunkId: Number(chunkId),
        locator,
        quote: sentence,
        claim: `${row.a_name} and ${row.b_name} appear in one passage`,
        why: 'co-presence only',
        missing: 'a passage that states the tie',
        strength: 0,
        isContext: true,
        kind: 'context',
      },
      counts,
    );
    if (counts.notes > before) written++;
  }
}

export interface StarvedThread {
  id: number;
  kind: 'person' | 'pair';
  label: string;
  noteCount: number;
  openEndCount: number;
  oldestOpenEnd: string | null;
  createdAt: string;
}

/**
 * Threads a reader should pick up next: nothing gathered, or a question that
 * has gone unanswered too long. Oldest first.
 *
 * A plain query helper for the next milestone. Window selection is NOT changed
 * in this task, and this is deliberately not wired into `extractLore`.
 */
export function starvedThreads(
  db: Db,
  projectId: number,
  limit = 400,
  opts: { olderThanDays?: number } = {},
): StarvedThread[] {
  const days = opts.olderThanDays ?? 7;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.all<{
    id: number;
    kind: 'person' | 'pair';
    a_name: string;
    b_name: string | null;
    created_at: string;
    note_count: number;
    open_end_count: number;
    oldest_open_end: string | null;
  }>(
    `SELECT t.id, t.kind, COALESCE(ea.name, '') AS a_name, eb.name AS b_name, t.created_at,
            (SELECT COUNT(*) FROM canon_thread_note n WHERE n.thread_id = t.id) AS note_count,
            (SELECT COUNT(*) FROM canon_open_end o WHERE o.thread_id = t.id AND o.status = 'open') AS open_end_count,
            (SELECT MIN(o.created_at) FROM canon_open_end o WHERE o.thread_id = t.id AND o.status = 'open') AS oldest_open_end
       FROM canon_thread t
       LEFT JOIN canon_entity ea ON ea.id = t.a_entity
       LEFT JOIN canon_entity eb ON eb.id = t.b_entity
      WHERE t.project_id = ?
        AND (
          NOT EXISTS (SELECT 1 FROM canon_thread_note n WHERE n.thread_id = t.id)
          OR EXISTS (
            SELECT 1 FROM canon_open_end o
             WHERE o.thread_id = t.id AND o.status = 'open' AND o.created_at <= ?
          )
        )
      ORDER BY (note_count = 0) DESC, oldest_open_end IS NULL, oldest_open_end ASC, note_count ASC, t.id ASC
      ${limit > 0 ? 'LIMIT ?' : ''}`,
    projectId,
    cutoff,
    ...(limit > 0 ? [limit] : []),
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.kind === 'pair' ? `${row.a_name} / ${row.b_name ?? ''}` : row.a_name,
    noteCount: row.note_count,
    openEndCount: row.open_end_count,
    oldestOpenEnd: row.oldest_open_end,
    createdAt: row.created_at,
  }));
}

/* --------------------------------------------- starved windows and conflicts */

export interface StarvedWindow {
  /** Index into the full window list, in reading order. */
  index: number;
  /** Distinct starved threads this window covers. */
  score: number;
}

/**
 * Which windows a starved thread lives in.
 *
 * A window is `windowSize` consecutive passages in `seq` order. Each starved
 * thread's passages are mapped to windows and a window's score is the number
 * of distinct starved threads it covers; windows that are already mined are
 * dropped, because re-reading them would teach nothing.
 */
export function starvedWindowScores(
  db: Db,
  projectId: number,
  opts: { windowSize?: number; limit?: number; olderThanDays?: number } = {},
): { windows: StarvedWindow[]; threadsCovered: number; threadsConsidered: number } {
  const windowSize = Math.max(1, opts.windowSize ?? 8);
  const chunks = db.all<{ id: number; seq: number; lore_mined: number }>(
    'SELECT id, seq, lore_mined FROM canon_chunk WHERE project_id = ? ORDER BY seq, id',
    projectId,
  );
  if (!chunks.length) return { windows: [], threadsCovered: 0, threadsConsidered: 0 };
  const windowOf = new Map<number, number>();
  chunks.forEach((chunk, position) => windowOf.set(chunk.id, Math.floor(position / windowSize)));

  const threads = starvedThreads(db, projectId, opts.limit ?? 400, {
    olderThanDays: opts.olderThanDays,
  });
  const coveredBy = new Map<number, Set<number>>();
  let threadsCovered = 0;
  for (const thread of threads) {
    const passages = db.all<{ chunk_id: number }>(
      'SELECT chunk_id FROM canon_thread_passage WHERE thread_id = ?',
      thread.id,
    );
    let chunkIds = passages.map((row) => row.chunk_id);
    if (!chunkIds.length) {
      const shared = db.get<{ shared_chunks: string }>(
        `SELECT p.shared_chunks FROM canon_thread t JOIN canon_pair_thread p ON p.id = t.pair_thread_id
          WHERE t.id = ?`,
        thread.id,
      );
      chunkIds = shared ? fromJson<number[]>(shared.shared_chunks, []).map(Number) : [];
    }
    const windows = new Set<number>();
    for (const chunkId of chunkIds) {
      const index = windowOf.get(chunkId);
      if (index !== undefined) windows.add(index);
    }
    if (!windows.size) continue;
    threadsCovered++;
    for (const index of windows) {
      const set = coveredBy.get(index) ?? new Set<number>();
      set.add(thread.id);
      coveredBy.set(index, set);
    }
  }

  const mined = new Map<number, boolean>();
  for (const [index] of coveredBy) {
    const start = index * windowSize;
    const slice = chunks.slice(start, start + windowSize);
    mined.set(index, slice.every((chunk) => chunk.lore_mined === 1));
  }
  const windows: StarvedWindow[] = [...coveredBy.entries()]
    .filter(([index]) => !mined.get(index))
    .map(([index, set]) => ({ index, score: set.size }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return { windows, threadsCovered, threadsConsidered: threads.length };
}

/**
 * Concepts that oppose one another, as a closed symmetric set.
 *
 * This is not a synonym list: it names only pairs that cannot both be true of
 * one pair at one time. Anything outside it is simply not compared.
 */
export const OPPOSED_KINDS: ReadonlyArray<readonly [string, string]> = [
  ['enemy of', 'ally of'],
  ['enemy of', 'friend'],
  ['trusted', 'distrusted'],
  ['feared', 'protected by'],
  ['loved', 'hated'],
  ['loyal to', 'betrayed'],
];

const OPPOSED = (() => {
  const map = new Map<string, Set<string>>();
  for (const [a, b] of OPPOSED_KINDS) {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const set = map.get(x) ?? new Set<string>();
      set.add(y);
      map.set(x, set);
    }
  }
  return map;
})();

/** Are two claim kinds opposed? Symmetric; unknown kinds are never opposed. */
export function kindsOppose(a: string, b: string): boolean {
  return OPPOSED.get(a.trim().toLowerCase())?.has(b.trim().toLowerCase()) ?? false;
}

export interface ContradictionCounts {
  considered: number;
  created: number;
  alreadyPresent: number;
  dismissedSkipped: number;
}

/**
 * Record opposition between notes on one thread.
 *
 * Only non-context notes at or above the evidence floor, with a claim kind, are
 * compared, and only within a thread: one thread is one period, so opposite
 * stances there are a contradiction. Across periods the same opposition is
 * change over time and is left alone. A conflict is visibility only � nothing
 * is resolved or judged � and a dismissed row is never recreated.
 */
export function markContradictions(
  db: Db,
  projectId: number,
  opts: { minStrength?: number } = {},
): ContradictionCounts {
  const floor = opts.minStrength ?? 0.35;
  const counts: ContradictionCounts = { considered: 0, created: 0, alreadyPresent: 0, dismissedSkipped: 0 };
  const notes = db.all<{ id: number; thread_id: number; claim_kind: string; strength: number }>(
    `SELECT id, thread_id, claim_kind, strength FROM canon_thread_note
      WHERE project_id = ? AND is_context = 0 AND claim_kind <> '' AND strength >= ?
      ORDER BY thread_id, id`,
    projectId,
    floor,
  );
  counts.considered = notes.length;
  const byThread = new Map<number, typeof notes>();
  for (const note of notes) {
    const list = byThread.get(note.thread_id) ?? [];
    list.push(note);
    byThread.set(note.thread_id, list);
  }
  const at = new Date().toISOString();
  db.transaction(() => {
    for (const threadId of [...byThread.keys()].sort((a, b) => a - b)) {
      const list = byThread.get(threadId)!;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const left = list[i]!;
          const right = list[j]!;
          if (left.claim_kind === right.claim_kind) continue;
          if (!kindsOppose(left.claim_kind, right.claim_kind)) continue;
          const low = Math.min(left.id, right.id);
          const high = Math.max(left.id, right.id);
          const kindLow = low === left.id ? left.claim_kind : right.claim_kind;
          const kindHigh = high === left.id ? left.claim_kind : right.claim_kind;
          const existing = db.get<{ id: number; status: string }>(
            'SELECT id, status FROM canon_thread_conflict WHERE project_id = ? AND thread_id = ? AND note_low = ? AND note_high = ?',
            projectId,
            threadId,
            low,
            high,
          );
          if (existing) {
            if (existing.status === 'dismissed') counts.dismissedSkipped++;
            else counts.alreadyPresent++;
            continue;
          }
          db.run(
            `INSERT INTO canon_thread_conflict
               (project_id, thread_id, note_low, note_high, kind_low, kind_high, basis, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'visible', ?)`,
            projectId,
            threadId,
            low,
            high,
            kindLow,
            kindHigh,
            `opposed-kind:${kindLow}|${kindHigh}`,
            at,
          );
          counts.created++;
        }
      }
    }
  });
  return counts;
}

/** Mark one conflict dismissed. Never deletes, never re-opens another one. */
export function dismissConflict(db: Db, conflictId: number): boolean {
  const row = db.get<{ id: number; status: string }>(
    'SELECT id, status FROM canon_thread_conflict WHERE id = ?',
    conflictId,
  );
  if (!row) throw new Error(`no conflict ${conflictId}`);
  if (row.status === 'dismissed') return false;
  db.run("UPDATE canon_thread_conflict SET status = 'dismissed' WHERE id = ?", conflictId);
  return true;
}
