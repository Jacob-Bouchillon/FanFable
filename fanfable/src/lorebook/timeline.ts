/**
 * Timeline and events: linking timeline entries to canon and AU events, kind
 * normalisation, claim modality, subject resolution, and entity capacity.
 *
 * Everything here either joins rows across the two event tables or decides what
 * shape a claim's subject and modality may take. No model call.
 *
 * Moved out of lorebook.ts on 2026-11-13, logic unchanged.
 */
import { Db, fromJson, nowIso, strList } from '../core/db.ts';
import { normalise, splitSentences } from '../core/text.ts';
import { KIND_FILLER, MOMENT_WORDS, headForms } from '../core/vocab.ts';
import { CORROBORATION_CAP, rankRows, tripleKey } from '../support/edge-rank.ts';
import { firstChunkOf } from './shared.ts';
import { listEntities, listRelations } from './bank.ts';
import { canonicalName, lowerOccurrencesInText, nameMentionedExact, nameTokens } from '../identity/names.ts';
import { newClaimUid } from '../court/claim-proof.ts';
import { entitySubject, recordRuling } from '../court/ruling.ts';
import { isClosedRoleKind } from '../lorebook.ts';
import type {
  CanonFact,
  CanonRelation,
  CanonTimelineEntry,
  EntityKind,
} from '../lorebook.ts';

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
export const GENERIC_KINSHIP: ReadonlyMap<string, ReadonlySet<string>> = new Map([
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
        db.transaction(() => {
          db.run("UPDATE canon_entity SET review_status = 'accepted', quarantine_reason = '' WHERE id = ? AND project_id = ?", row.id, projectId);
          recordRuling(db, projectId, {
            subject: entitySubject(row.id),
            role: 'appeal',
            actor: 'guard',
            standard: 'common-noun-release',
            fromStatus: 'quarantined',
            toStatus: 'accepted',
            basis: (row.mentions ?? 0) >= 2 ? 'a second mention names the character' : 'a recognised alias names the character',
          });
        });
        released++;
      }
      continue;
    }
    if ((row.mentions ?? 0) > 1) continue;
    if (strList(row.aliases).length > 0) continue;
    if (!/^[A-Z][a-z]{2,}$/.test(row.name)) continue;
    const lower = lowerOccurrencesInText(text, row.name.toLowerCase());
    if (lower < 1) continue;
    const reason = `single mention; the name also occurs lowercase ${lower} time(s) in the book`;
    db.transaction(() => {
      db.run(
        "UPDATE canon_entity SET review_status = 'quarantined', quarantine_reason = ? WHERE id = ? AND project_id = ?",
        reason,
        row.id,
        projectId,
      );
      recordRuling(db, projectId, {
        subject: entitySubject(row.id),
        role: 'appeal',
        actor: 'guard',
        standard: 'common-noun-quarantine',
        fromStatus: row.review_status,
        toStatus: 'quarantined',
        basis: reason,
      });
    });
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
                       (project_id, claim_uid, topic, statement, kind, certainty, subject, evidence, source_refs, subject_entity_id, modality, created_at)
                     VALUES (?, ?, ?, ?, 'fact', 'confirmed', ?, ?, ?, ?, 'asserted', ?)`,
                    projectId,
                    newClaimUid('fact'),
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
      db.transaction(() => {
        db.run(
          "UPDATE canon_entity SET review_status = 'needs_review', updated_at = ? WHERE project_id = ? AND id = ?",
          nowIso(),
          projectId,
          entity.id,
        );
        // Park the row either way; only a real status move is a new decision.
        if (entity.review_status !== 'needs_review') {
          recordRuling(db, projectId, {
            subject: entitySubject(entity.id),
            role: 'appeal',
            actor: 'guard',
            standard: 'capacity',
            fromStatus: entity.review_status,
            toStatus: 'needs_review',
            basis: 'unproven entity parked (single mention, no role or tie)',
          });
        }
      });
    }
  }
  return result;
}
