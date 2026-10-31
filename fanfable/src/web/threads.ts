/**
 * The evidence web's first layer: thread records, immutable notes, open ends.
 *
 * A thread is a persistent investigation. It carries identity and type, an
 * ordered passage history, accumulated clue notes and the open ends that keep
 * it alive. An empty thread means "no evidence gathered yet" and is NEVER a
 * statement that no relationship exists.
 *
 * Code owns structure, persistence and provenance here; no model call happens
 * in this module, and nothing is written to `canon_relation`, `canon_tie_note`
 * or `canon_tie_hint` — those remain the bank and the inbox respectively.
 *
 * Notes are immutable by construction: `addNote` only inserts, and there is no
 * update or delete function at all. A correction is a new note whose
 * `supersedes_note_id` points at the note it corrects; the earlier row keeps
 * every byte it was written with.
 *
 * Meetings, births, sharing and the map are not built here (Milestone 2).
 */
import { Db, fromJson, nowIso } from '../db.ts';

export type ThreadKind = 'person' | 'pair';
export type ThreadStatus = 'open' | 'resolved' | 'dormant';
export type NoteKind = 'observation' | 'correction' | 'context';
export type OpenEndStatus = 'open' | 'resolved' | 'abandoned';

const THREAD_KINDS: ReadonlySet<string> = new Set(['person', 'pair']);
const NOTE_KINDS: ReadonlySet<string> = new Set(['observation', 'correction', 'context']);

export interface ThreadSyncResult {
  personThreadsCreated: number;
  pairThreadsCreated: number;
  /** Of those, threads created for a second or later period of the same pair. */
  pairPeriodsCreated: number;
  threadsTotal: number;
  openEndsTotal: number;
}

/**
 * Passage gap that ends one period and starts another.
 *
 * 40 passages is roughly five extraction windows: near enough that a pair seen
 * only in chapter one and again much later reads as two periods, far enough
 * that ordinary back-and-forth inside a stretch of the book stays one.
 */
export const PERIOD_GAP_SEQS = 40;

export type TemporalStatus = 'current' | 'historical' | 'unknown' | 'uncertain';

export interface PairPeriod {
  /** '' for a pair seen in a single stretch — the pre-milestone identity. */
  label: string;
  fromSeq: number;
  toSeq: number;
  temporalStatus: TemporalStatus;
}

/**
 * Split a pair's shared passage seqs into periods, in reading order.
 *
 * Deterministic and code-only: sort the seqs, cut wherever the gap to the next
 * shared passage exceeds `gap`, and label the runs p1, p2, … Everything before
 * the last run is history, the last run is current. A pair with no such gap
 * keeps the legacy single identity (empty label, unknown status) so existing
 * rows are not churned.
 */
export function derivePairPeriods(seqs: number[], gap: number = PERIOD_GAP_SEQS): PairPeriod[] {
  const sorted = [...new Set(seqs.filter((seq) => Number.isFinite(seq)))].sort((a, b) => a - b);
  if (!sorted.length) return [];
  const runs: number[][] = [];
  let run: number[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const seq = sorted[i]!;
    if (seq - sorted[i - 1]! > gap) {
      runs.push(run);
      run = [seq];
    } else {
      run.push(seq);
    }
  }
  runs.push(run);
  if (runs.length === 1) {
    return [
      {
        label: '',
        fromSeq: runs[0]![0]!,
        toSeq: runs[0]![runs[0]!.length - 1]!,
        temporalStatus: 'unknown',
      },
    ];
  }
  return runs.map((span, i) => ({
    label: `p${i + 1}`,
    fromSeq: span[0]!,
    toSeq: span[span.length - 1]!,
    temporalStatus: i === runs.length - 1 ? 'current' : 'historical',
  }));
}

/**
 * Which period thread a note belongs to.
 *
 * One thread for the pair: attach there, exactly as before. Several: prefer a
 * labelled period whose range contains the passage, then the narrowest, then
 * the lowest id; a passage outside every range goes to the nearest period.
 */
export function pickPeriodThread(
  threads: { id: number; periodFromSeq: number | null; periodToSeq: number | null; periodLabel: string }[],
  seq: number | null,
): number | null {
  if (!threads.length) return null;
  if (threads.length === 1) return threads[0]!.id;
  if (seq === null) return threads[0]!.id;
  const ranged = threads.filter((t) => t.periodFromSeq !== null && t.periodToSeq !== null);
  if (!ranged.length) return threads[0]!.id;
  const containing = ranged.filter((t) => seq >= t.periodFromSeq! && seq <= t.periodToSeq!);
  if (containing.length) {
    const labelled = containing.filter((t) => t.periodLabel !== '');
    const pool = labelled.length ? labelled : containing;
    return [...pool].sort(
      (a, b) =>
        (a.periodToSeq! - a.periodFromSeq!) - (b.periodToSeq! - b.periodFromSeq!) || a.id - b.id,
    )[0]!.id;
  }
  const distance = (t: { periodFromSeq: number | null; periodToSeq: number | null }): number =>
    seq < t.periodFromSeq! ? t.periodFromSeq! - seq : seq - t.periodToSeq!;
  return [...ranged].sort((a, b) => distance(a) - distance(b) || a.id - b.id)[0]!.id;
}

/**
 * Create the thread records for the project's people and co-occurring pairs.
 *
 * Idempotent and transactional: a second run creates nothing. Existing rows
 * are reused, and a pair thread that predates its `canon_pair_thread` link is
 * repaired rather than duplicated. Nothing is ever deleted.
 */
export function syncThreads(db: Db, projectId: number): ThreadSyncResult {
  const at = nowIso();
  let personThreadsCreated = 0;
  let pairThreadsCreated = 0;
  let pairPeriodsCreated = 0;

  const existing = (kind: ThreadKind, aEntity: number, bEntity: number | null): number | undefined =>
    db.get<{ id: number }>(
      bEntity === null
        ? "SELECT id FROM canon_thread WHERE project_id = ? AND kind = ? AND a_entity = ? AND b_entity IS NULL"
        : 'SELECT id FROM canon_thread WHERE project_id = ? AND kind = ? AND a_entity = ? AND b_entity = ?',
      projectId,
      kind,
      aEntity,
      ...(bEntity === null ? [] : [bEntity]),
    )?.id;

  const existingPeriod = (aEntity: number, bEntity: number, label: string): number | undefined =>
    db.get<{ id: number }>(
      `SELECT id FROM canon_thread
        WHERE project_id = ? AND kind = 'pair' AND a_entity = ? AND b_entity = ?
          AND period_label = ? AND parent_a_thread IS NULL
        ORDER BY id LIMIT 1`,
      projectId,
      aEntity,
      bEntity,
      label,
    )?.id;

  db.transaction(() => {
    // One person thread per live (non-quarantined) character.
    const people = db.all<{ id: number }>(
      "SELECT id FROM canon_entity WHERE project_id = ? AND kind = 'character' AND review_status != 'quarantined' ORDER BY id",
      projectId,
    );
    for (const person of people) {
      if (existing('person', person.id, null) !== undefined) continue;
      db.run(
        `INSERT INTO canon_thread
           (project_id, kind, a_entity, b_entity, pair_thread_id, status, birth_reason, created_at, updated_at)
         VALUES (?, 'person', ?, NULL, NULL, 'open', '', ?, ?)`,
        projectId,
        person.id,
        at,
        at,
      );
      personThreadsCreated++;
    }

    // One pair thread per co-occurrence period, linked to its structural thread.
    const chunkSeq = new Map(
      db
        .all<{ id: number; seq: number }>('SELECT id, seq FROM canon_chunk WHERE project_id = ?', projectId)
        .map((row) => [row.id, row.seq]),
    );
    const pairs = db.all<{ id: number; a_entity: number; b_entity: number; shared_chunks: string }>(
      'SELECT id, a_entity, b_entity, shared_chunks FROM canon_pair_thread WHERE project_id = ? ORDER BY id',
      projectId,
    );
    for (const pair of pairs) {
      const shared = fromJson<number[]>(pair.shared_chunks, [])
        .map((id) => chunkSeq.get(Number(id)))
        .filter((seq): seq is number => Number.isFinite(seq));
      const periods = derivePairPeriods(shared);
      const spans: PairPeriod[] = periods.length
        ? periods
        : [{ label: '', fromSeq: 0, toSeq: 0, temporalStatus: 'unknown' }];

      for (const span of spans) {
        const found = existingPeriod(pair.a_entity, pair.b_entity, span.label);
        if (found !== undefined) {
          // Repair a missing link or missing bounds; never duplicate, never clear.
          db.run(
            `UPDATE canon_thread
                SET pair_thread_id = COALESCE(pair_thread_id, ?),
                    period_from_seq = COALESCE(period_from_seq, ?),
                    period_to_seq = COALESCE(period_to_seq, ?),
                    updated_at = ?
              WHERE id = ? AND project_id = ?`,
            pair.id,
            span.fromSeq,
            span.toSeq,
            at,
            found,
            projectId,
          );
          continue;
        }
        db.run(
          `INSERT INTO canon_thread
             (project_id, kind, a_entity, b_entity, pair_thread_id, status, birth_reason,
              period_label, period_from_seq, period_to_seq, temporal_status, created_at, updated_at)
           VALUES (?, 'pair', ?, ?, ?, 'open', '', ?, ?, ?, ?, ?, ?)`,
          projectId,
          pair.a_entity,
          pair.b_entity,
          pair.id,
          span.label,
          span.fromSeq,
          span.toSeq,
          span.temporalStatus,
          at,
          at,
        );
        pairThreadsCreated++;
        if (span.label !== '') pairPeriodsCreated++;
      }
    }
  });

  const threadsTotal =
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread WHERE project_id = ?', projectId)?.n ?? 0;
  const openEndsTotal =
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM canon_open_end WHERE project_id = ? AND status = 'open'",
      projectId,
    )?.n ?? 0;
  return { personThreadsCreated, pairThreadsCreated, pairPeriodsCreated, threadsTotal, openEndsTotal };
}

export interface NewNote {
  chunkId?: number | null;
  locator?: string;
  /** Verbatim words from the passage. Required: a note without a quote is a guess. */
  quote: string;
  claim?: string;
  noteKind?: NoteKind;
  /** How strongly this quote supports the claim, 0–1. */
  strength?: number;
  why?: string;
  missing?: string;
  isContext?: boolean;
  /** Set on a correction: the note it corrects. The original row is untouched. */
  supersedesNoteId?: number | null;
}

function requireThread(db: Db, projectId: number, threadId: number): void {
  const row = db.get<{ id: number }>(
    'SELECT id FROM canon_thread WHERE id = ? AND project_id = ?',
    threadId,
    projectId,
  );
  if (!row) throw new Error(`no thread ${threadId} in this project`);
}

/**
 * Record one observation on a thread.
 *
 * Insert-only: the returned id is the whole handle, and no update or delete
 * path exists. A correction passes `supersedesNoteId` and becomes a new row,
 * leaving the superseded note byte-identical.
 */
export function addNote(db: Db, projectId: number, threadId: number, note: NewNote): number {
  requireThread(db, projectId, threadId);
  const quote = String(note.quote ?? '').trim();
  if (!quote) throw new Error('note quote is required');
  const strength = note.strength === undefined ? 0.5 : Number(note.strength);
  if (!Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new Error(`note strength must be between 0 and 1 (got ${note.strength})`);
  }
  const noteKind = (note.noteKind ?? 'observation') as NoteKind;
  if (!NOTE_KINDS.has(noteKind)) throw new Error(`unknown note kind "${noteKind}"`);
  const supersedes = note.supersedesNoteId ?? null;
  if (supersedes !== null) {
    const prior = db.get<{ thread_id: number }>(
      'SELECT thread_id FROM canon_thread_note WHERE id = ? AND project_id = ?',
      supersedes,
      projectId,
    );
    if (!prior) throw new Error(`no note ${supersedes} to supersede in this project`);
    if (prior.thread_id !== threadId) throw new Error('a correction must stay on the note it corrects');
  }
  const id = db.run(
    `INSERT INTO canon_thread_note
       (project_id, thread_id, chunk_id, locator, quote, claim, note_kind, strength,
        why, missing, is_context, supersedes_note_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    threadId,
    note.chunkId ?? null,
    String(note.locator ?? ''),
    quote,
    String(note.claim ?? ''),
    noteKind,
    strength,
    String(note.why ?? ''),
    String(note.missing ?? ''),
    note.isContext ? 1 : 0,
    supersedes,
    nowIso(),
  ).lastInsertRowid;
  return Number(id);
}

export interface NewOpenEnd {
  question: string;
  origin?: string;
  wouldResolve?: string;
}

/** What the investigation still needs. Resolution links a note; it never edits one. */
export function addOpenEnd(db: Db, projectId: number, threadId: number, end: NewOpenEnd): number {
  requireThread(db, projectId, threadId);
  const question = String(end.question ?? '').trim();
  if (!question) throw new Error('open end question is required');
  return Number(
    db.run(
      `INSERT INTO canon_open_end
         (project_id, thread_id, question, origin, would_resolve, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      projectId,
      threadId,
      question,
      String(end.origin ?? ''),
      String(end.wouldResolve ?? ''),
      nowIso(),
    ).lastInsertRowid,
  );
}

/**
 * Close an open end by linking the note that resolved it.
 *
 * Idempotent: the first resolution wins. Resolving an already-resolved open
 * end changes nothing and returns false, so a retry cannot rewrite history or
 * swap the evidence. The resolved note itself is never touched.
 */
export function resolveOpenEnd(db: Db, openEndId: number, noteId: number): boolean {
  const end = db.get<{ id: number; project_id: number; thread_id: number; status: string }>(
    'SELECT id, project_id, thread_id, status FROM canon_open_end WHERE id = ?',
    openEndId,
  );
  if (!end) throw new Error(`no open end ${openEndId}`);
  if (end.status !== 'open') return false;
  const note = db.get<{ thread_id: number }>(
    'SELECT thread_id FROM canon_thread_note WHERE id = ? AND project_id = ?',
    noteId,
    end.project_id,
  );
  if (!note) throw new Error(`no note ${noteId} to resolve with`);
  if (note.thread_id !== end.thread_id) throw new Error('a note resolves an open end on its own thread only');
  db.run(
    `UPDATE canon_open_end
        SET status = 'resolved', resolved_by_note_id = ?, resolved_at = ?
      WHERE id = ? AND status = 'open'`,
    noteId,
    nowIso(),
    openEndId,
  );
  return true;
}

export interface ThreadRow {
  id: number;
  project_id: number;
  kind: ThreadKind;
  a_entity: number;
  b_entity: number | null;
  pair_thread_id: number | null;
  status: ThreadStatus;
  parent_a_thread: number | null;
  parent_b_thread: number | null;
  birth_reason: string;
  /** '' for a single-stretch pair and for people; p1, p2, … for split periods. */
  period_label: string;
  period_from_seq: number | null;
  period_to_seq: number | null;
  temporal_status: TemporalStatus;
  created_at: string;
  updated_at: string;
}

export interface ThreadPassage {
  chunkId: number;
  seq: number;
  locator: string;
  firstSeenAt: string;
}

export interface ThreadNote {
  id: number;
  chunkId: number | null;
  locator: string;
  quote: string;
  claim: string;
  noteKind: NoteKind;
  strength: number;
  why: string;
  missing: string;
  isContext: boolean;
  supersedesNoteId: number | null;
  createdAt: string;
}

export interface OpenEnd {
  id: number;
  question: string;
  origin: string;
  wouldResolve: string;
  status: OpenEndStatus;
  resolvedByNoteId: number | null;
  resolvedAt: string | null;
  /** Set when a born child inherited this want from a parent thread. */
  carriedFromOpenEndId: number | null;
  createdAt: string;
}

/** A thread this one descends from, or a neighbour in the web. */
export interface ThreadRef {
  id: number;
  kind: ThreadKind;
  label: string;
}

export interface BirthInfo {
  trigger: string;
  combinedScore: number;
  reason: string;
  parentAThread: number;
  parentBThread: number;
}

/** A note pooled into this thread, referenced rather than copied. */
export interface NoteRef {
  noteId: number;
  role: string;
  note: ThreadNote;
}

export interface LoadedThread {
  thread: ThreadRow;
  aName: string;
  bName: string | null;
  passages: ThreadPassage[];
  notes: ThreadNote[];
  openEnds: OpenEnd[];
  counts: { passages: number; notes: number; openEnds: number; openEndsOpen: number };
  /** Both parents when this thread was born; null for a root thread. */
  parents: { a: ThreadRef | null; b: ThreadRef | null };
  /** The birth record, when this thread is a child. */
  birth: BirthInfo | null;
  /** Notes this thread references from elsewhere (pooled evidence). */
  noteRefs: NoteRef[];
}

/** One thread with its ordered history, notes (newest last) and open ends. Read-only. */
export function loadThread(db: Db, projectId: number, threadId: number): LoadedThread | null {
  const thread = db.get<ThreadRow>(
    'SELECT * FROM canon_thread WHERE id = ? AND project_id = ?',
    threadId,
    projectId,
  );
  if (!thread) return null;
  const names = db.get<{ a_name: string; b_name: string | null }>(
    `SELECT COALESCE(ea.name, '') AS a_name, eb.name AS b_name
       FROM canon_thread t
       LEFT JOIN canon_entity ea ON ea.id = t.a_entity
       LEFT JOIN canon_entity eb ON eb.id = t.b_entity
      WHERE t.id = ?`,
    threadId,
  );
  const passages = db
    .all<{ chunk_id: number; seq: number; locator: string; first_seen_at: string }>(
      `SELECT p.chunk_id, p.seq, COALESCE(c.locator, '') AS locator, p.first_seen_at
         FROM canon_thread_passage p
         LEFT JOIN canon_chunk c ON c.id = p.chunk_id
        WHERE p.thread_id = ?
        ORDER BY p.seq ASC, p.chunk_id ASC`,
      threadId,
    )
    .map((row) => ({ chunkId: row.chunk_id, seq: row.seq, locator: row.locator, firstSeenAt: row.first_seen_at }));
  const notes = db
    .all<{
      id: number;
      chunk_id: number | null;
      locator: string;
      quote: string;
      claim: string;
      note_kind: NoteKind;
      strength: number;
      why: string;
      missing: string;
      is_context: number;
      supersedes_note_id: number | null;
      created_at: string;
    }>(
      'SELECT * FROM canon_thread_note WHERE thread_id = ? ORDER BY id ASC',
      threadId,
    )
    .map((row) => ({
      id: row.id,
      chunkId: row.chunk_id,
      locator: row.locator,
      quote: row.quote,
      claim: row.claim,
      noteKind: row.note_kind,
      strength: row.strength,
      why: row.why,
      missing: row.missing,
      isContext: row.is_context === 1,
      supersedesNoteId: row.supersedes_note_id,
      createdAt: row.created_at,
    }));
  const openEnds = db
    .all<{
      id: number;
      question: string;
      origin: string;
      would_resolve: string;
      status: OpenEndStatus;
      resolved_by_note_id: number | null;
      resolved_at: string | null;
      carried_from_open_end_id: number | null;
      created_at: string;
    }>('SELECT * FROM canon_open_end WHERE thread_id = ? ORDER BY id ASC', threadId)
    .map((row) => ({
      id: row.id,
      question: row.question,
      origin: row.origin,
      wouldResolve: row.would_resolve,
      status: row.status,
      resolvedByNoteId: row.resolved_by_note_id,
      resolvedAt: row.resolved_at,
      carriedFromOpenEndId: row.carried_from_open_end_id ?? null,
      createdAt: row.created_at,
    }));

  const refOf = (id: number | null): ThreadRef | null => {
    if (!id) return null;
    const row = db.get<{ id: number; kind: ThreadKind; a_name: string; b_name: string | null }>(
      `SELECT t.id, t.kind, COALESCE(ea.name, '') AS a_name, eb.name AS b_name
         FROM canon_thread t
         LEFT JOIN canon_entity ea ON ea.id = t.a_entity
         LEFT JOIN canon_entity eb ON eb.id = t.b_entity
        WHERE t.id = ?`,
      id,
    );
    if (!row) return null;
    const label = row.kind === 'pair' ? `${row.a_name} / ${row.b_name ?? ''}` : row.a_name;
    return { id: row.id, kind: row.kind, label };
  };

  const birthRow = db.get<{
    trigger: string;
    combined_score: number;
    reason: string;
    parent_a_thread: number;
    parent_b_thread: number;
  }>(
    'SELECT trigger, combined_score, reason, parent_a_thread, parent_b_thread FROM canon_birth WHERE child_thread = ?',
    threadId,
  );

  const noteRefs = db
    .all<{
      note_id: number;
      role: string;
      id: number;
      chunk_id: number | null;
      locator: string;
      quote: string;
      claim: string;
      note_kind: NoteKind;
      strength: number;
      why: string;
      missing: string;
      is_context: number;
      supersedes_note_id: number | null;
      created_at: string;
    }>(
      `SELECT r.note_id, r.role, n.id, n.chunk_id, n.locator, n.quote, n.claim, n.note_kind,
              n.strength, n.why, n.missing, n.is_context, n.supersedes_note_id, n.created_at
         FROM canon_thread_note_ref r
         JOIN canon_thread_note n ON n.id = r.note_id
        WHERE r.thread_id = ?
        ORDER BY r.role, n.id`,
      threadId,
    )
    .map((row) => ({
      noteId: row.note_id,
      role: row.role,
      note: {
        id: row.id,
        chunkId: row.chunk_id,
        locator: row.locator,
        quote: row.quote,
        claim: row.claim,
        noteKind: row.note_kind,
        strength: row.strength,
        why: row.why,
        missing: row.missing,
        isContext: row.is_context === 1,
        supersedesNoteId: row.supersedes_note_id,
        createdAt: row.created_at,
      },
    }));

  return {
    thread,
    aName: names?.a_name ?? '',
    bName: names?.b_name ?? null,
    passages,
    notes,
    openEnds,
    counts: {
      passages: passages.length,
      notes: notes.length,
      openEnds: openEnds.length,
      openEndsOpen: openEnds.filter((end) => end.status === 'open').length,
    },
    parents: { a: refOf(thread.parent_a_thread), b: refOf(thread.parent_b_thread) },
    birth: birthRow
      ? {
          trigger: birthRow.trigger,
          combinedScore: birthRow.combined_score,
          reason: birthRow.reason,
          parentAThread: birthRow.parent_a_thread,
          parentBThread: birthRow.parent_b_thread,
        }
      : null,
    noteRefs,
  };
}

export interface ThreadSummary extends ThreadRow {
  aName: string;
  bName: string | null;
  noteCount: number;
  openEndCount: number;
  /** Earliest still-open question, or null when the thread has none. */
  oldestOpenEnd: string | null;
}

export interface ListThreadsOptions {
  kind?: ThreadKind;
  status?: ThreadStatus;
  period?: string;
  limit?: number;
}

function summarize(
  db: Db,
  projectId: number,
  where: string,
  params: unknown[],
  order: string,
  limit: number | undefined,
): ThreadSummary[] {
  const rows = db.all<ThreadRow & {
    a_name: string;
    b_name: string | null;
    note_count: number;
    open_end_count: number;
    oldest_open_end: string | null;
  }>(
    `SELECT t.*,
            COALESCE(ea.name, '') AS a_name,
            eb.name AS b_name,
            (SELECT COUNT(*) FROM canon_thread_note n WHERE n.thread_id = t.id) AS note_count,
            (SELECT COUNT(*) FROM canon_open_end o WHERE o.thread_id = t.id AND o.status = 'open') AS open_end_count,
            (SELECT MIN(o.created_at) FROM canon_open_end o WHERE o.thread_id = t.id AND o.status = 'open') AS oldest_open_end
       FROM canon_thread t
       LEFT JOIN canon_entity ea ON ea.id = t.a_entity
       LEFT JOIN canon_entity eb ON eb.id = t.b_entity
      WHERE t.project_id = ? ${where}
      ORDER BY ${order}
      ${limit && limit > 0 ? 'LIMIT ?' : ''}`,
    projectId,
    ...params,
    ...(limit && limit > 0 ? [limit] : []),
  );
  return rows.map((row) => ({
    id: row.id,
    project_id: row.project_id,
    kind: row.kind,
    a_entity: row.a_entity,
    b_entity: row.b_entity,
    pair_thread_id: row.pair_thread_id,
    status: row.status,
    parent_a_thread: row.parent_a_thread,
    parent_b_thread: row.parent_b_thread,
    birth_reason: row.birth_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    aName: row.a_name,
    bName: row.b_name,
    period_label: row.period_label,
    period_from_seq: row.period_from_seq,
    period_to_seq: row.period_to_seq,
    temporal_status: row.temporal_status,
    noteCount: row.note_count,
    openEndCount: row.open_end_count,
    oldestOpenEnd: row.oldest_open_end,
  }));
}

/**
 * Threads for a human listing.
 *
 * Richest evidence first (note count), then the thread whose question has been
 * open longest, then id. Scores are not trusted yet, so evidence richness —
 * not confidence — does the ordering.
 */
export function listThreads(db: Db, projectId: number, opts: ListThreadsOptions = {}): ThreadSummary[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.kind) {
    if (!THREAD_KINDS.has(opts.kind)) throw new Error(`unknown thread kind "${opts.kind}"`);
    where.push('AND t.kind = ?');
    params.push(opts.kind);
  }
  if (opts.status) {
    where.push('AND t.status = ?');
    params.push(opts.status);
  }
  if (opts.period !== undefined) {
    where.push('AND t.period_label = ?');
    params.push(opts.period);
  }
  return summarize(
    db,
    projectId,
    where.join(' '),
    params,
    'note_count DESC, (oldest_open_end IS NULL) ASC, oldest_open_end ASC, t.id ASC',
    opts.limit,
  );
}

export interface ThreadsForReadOptions {
  limit?: number;
}

/**
 * Threads a reader should pick up next: unresolved questions first, then the
 * thinnest evidence, then the longest-waiting question.
 *
 * A plain query helper. Nothing calls it yet — the extractor and retrieval stay
 * untouched until a later milestone wires it deliberately.
 */
export function threadsForRead(db: Db, projectId: number, opts: ThreadsForReadOptions = {}): ThreadSummary[] {
  return summarize(
    db,
    projectId,
    "AND t.status = 'open'",
    [],
    'open_end_count DESC, note_count ASC, (oldest_open_end IS NULL) ASC, oldest_open_end ASC, t.id ASC',
    opts.limit,
  );
}
