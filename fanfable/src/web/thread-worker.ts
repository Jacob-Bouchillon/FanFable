/**
 * The web's own note worker.
 *
 * Planning and retrieval are read-only; applying notes writes through the same
 * canon_thread_note shape the extraction path uses. No model calls live here.
 */
import { Db, fromJson, nowIso } from '../core/db.ts';
import { extractJson } from '../core/json.ts';
import { STOPWORDS } from '../core/vocab.ts';
import { noteDedupeKey, starvedThreads } from './note-ingest.ts';

export interface ThreadWorkItem {
  threadId: number;
  kind: 'person' | 'pair';
  label: string;
  entityIds: number[];
  openEnds: Array<{ id: number; question: string; wouldResolve: string }>;
  noteCount: number;
}

export function planThreadWork(
  db: Db,
  projectId: number,
  limit: number,
  opts: { olderThanDays?: number } = {},
): ThreadWorkItem[] {
  const olderThanDays = opts.olderThanDays ?? 0;
  const threads = starvedThreads(db, projectId, limit, { olderThanDays });
  const items: ThreadWorkItem[] = [];
  for (const thread of threads) {
    const row = db.get<{ a_entity: number; b_entity: number | null }>(
      'SELECT a_entity, b_entity FROM canon_thread WHERE id = ? AND project_id = ?',
      thread.id,
      projectId,
    );
    if (!row) continue;
    const entityIds = [...new Set([row.a_entity, row.b_entity]
      .filter((id): id is number => id !== null))];
    const openEnds = db.all<{ id: number; question: string; would_resolve: string }>(
      `SELECT id, question, would_resolve FROM canon_open_end
        WHERE project_id = ? AND thread_id = ? AND status = 'open'
        ORDER BY created_at, id`,
      projectId,
      thread.id,
    );
    items.push({
      threadId: thread.id,
      kind: thread.kind,
      label: thread.label,
      entityIds,
      openEnds: openEnds.map((open) => ({
        id: Number(open.id),
        question: String(open.question ?? ''),
        wouldResolve: String(open.would_resolve ?? ''),
      })),
      noteCount: thread.noteCount,
    });
  }
  return items;
}

export interface RetrievedPassage {
  chunkId: number;
  locator: string;
  seq: number;
  text: string;
}

function tokenize(value: string): string[] {
  return String(value ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function significantTokens(value: string): Set<string> {
  return new Set(tokenize(value).filter((token) => token.length > 2 && !STOPWORDS.has(token)));
}

function likePattern(value: string): string {
  return `%${String(value ?? '').replace(/[!%_]/g, '!$&')}%`;
}

function entityVariants(db: Db, projectId: number, entityId: number): string[] {
  const row = db.get<{ name: string; aliases: string }>(
    'SELECT name, aliases FROM canon_entity WHERE id = ? AND project_id = ?',
    entityId,
    projectId,
  );
  if (!row) return [];
  const seen = new Set<string>();
  const variants: string[] = [];
  for (const value of [row.name, ...fromJson<string[]>(row.aliases, [])]) {
    const text = String(value ?? '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    variants.push(text);
  }
  return variants;
}

function sideCondition(variants: string[]): string {
  return variants.map(() => "text LIKE ? ESCAPE '!'").join(' OR ');
}

export function retrieveEvidence(
  db: Db,
  projectId: number,
  item: ThreadWorkItem,
  maxChunks = 6,
): RetrievedPassage[] {
  const cap = Math.max(1, Math.floor(maxChunks));
  const ids = item.entityIds.slice(0, 2);
  if (!ids.length) return [];
  const sides = ids.map((id) => entityVariants(db, projectId, id)).filter((variants) => variants.length > 0);
  if (!sides.length) return [];
  const fetchLimit = Math.max(cap * 4, cap);
  const questionTokens = new Set<string>();
  for (const open of item.openEnds) {
    for (const token of significantTokens(`${open.question} ${open.wouldResolve}`)) {
      questionTokens.add(token);
    }
  }

  let rows: Array<{ id: number; locator: string; seq: number; text: string }> = [];
  if (sides.length >= 2) {
    const conditions = sides.map((variants) => `(${sideCondition(variants)})`).join(' AND ');
    const patterns = sides.flatMap((variants) => variants.map(likePattern));
    rows = db.all<{ id: number; locator: string; seq: number; text: string }>(
      `SELECT id, locator, seq, text FROM canon_chunk
        WHERE project_id = ? AND ${conditions}
        ORDER BY seq LIMIT ?`,
      projectId,
      ...patterns,
      fetchLimit,
    );
  }

  if (!rows.length) {
    const conditions = sides.map((variants) => `(${sideCondition(variants)})`).join(' OR ');
    const patterns = sides.flatMap((variants) => variants.map(likePattern));
    rows = db.all<{ id: number; locator: string; seq: number; text: string }>(
      `SELECT id, locator, seq, text FROM canon_chunk
        WHERE project_id = ? AND (${conditions})
        ORDER BY seq LIMIT ?`,
      projectId,
      ...patterns,
      fetchLimit,
    );
  }

  const scored = rows.map((row) => {
    const text = String(row.text ?? '');
    let score = 0;
    if (questionTokens.size) {
      for (const token of tokenize(text)) if (questionTokens.has(token)) score++;
    }
    return { row, score };
  });
  scored.sort((left, right) =>
    right.score - left.score || Number(left.row.seq) - Number(right.row.seq));

  return scored.slice(0, cap).map(({ row }) => ({
    chunkId: Number(row.id),
    locator: String(row.locator ?? ''),
    seq: Number(row.seq),
    text: String(row.text ?? '').slice(0, 1800),
  }));
}

export interface WorkerNote {
  quote: string;
  claim: string;
  kind: string;
  strength: number;
}

function asWorkerNote(value: unknown): WorkerNote | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.quote !== 'string' || !entry.quote.trim()) return null;
  if (typeof entry.claim !== 'string' || !entry.claim.trim()) return null;
  if (typeof entry.kind !== 'string' || !entry.kind.trim()) return null;
  const strength = Number(entry.strength);
  if (!Number.isFinite(strength)) return null;
  return {
    quote: entry.quote,
    claim: entry.claim,
    kind: entry.kind.trim(),
    strength,
  };
}

export function parseWorkerAnswer(text: string): WorkerNote[] {
  const parsed = extractJson<unknown>(text);
  let entries: unknown[] = [];
  if (Array.isArray(parsed)) entries = parsed;
  else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { notes?: unknown }).notes)) {
    entries = (parsed as { notes: unknown[] }).notes;
  }
  const notes: WorkerNote[] = [];
  for (const entry of entries) {
    const note = asWorkerNote(entry);
    if (note) notes.push(note);
  }
  return notes;
}

export type NoteRejection =
  | 'bad-shape'
  | 'quote-absent'
  | 'quote-not-found'
  | 'kind-not-allowed'
  | 'duplicate';

function normalizeWhitespace(value: string): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function validateWorkerNote(
  note: WorkerNote,
  passage: RetrievedPassage,
  allowedKinds: Set<string>,
  existingKeys?: Set<string>,
): { ok: true } | { ok: false; reason: NoteRejection } {
  if (!note.quote.trim()) return { ok: false, reason: 'quote-absent' };
  const quote = normalizeWhitespace(note.quote);
  const text = normalizeWhitespace(passage.text);
  if (!quote || !text.includes(quote)) return { ok: false, reason: 'quote-not-found' };
  if (!allowedKinds.has(note.kind)) return { ok: false, reason: 'kind-not-allowed' };
  if (existingKeys?.has(noteDedupeKey(note.quote, note.claim))) {
    return { ok: false, reason: 'duplicate' };
  }
  return { ok: true };
}

export interface ApplyCounts {
  added: number;
  duplicates: number;
  rejected: number;
  openEndsClosed: number;
}

export const WORKER_NOTE_KINDS = new Set(['observation', 'context']);

function openEndTokens(item: ThreadWorkItem): Array<{ id: number; tokens: Set<string> }> {
  return item.openEnds.map((open) => ({
    id: open.id,
    tokens: significantTokens(`${open.question} ${open.wouldResolve}`),
  }));
}

export function applyWorkerNotes(
  db: Db,
  projectId: number,
  item: ThreadWorkItem,
  notes: Array<{ note: WorkerNote; passage: RetrievedPassage }>,
  opts: { dryRun: boolean },
): ApplyCounts {
  const run = (): ApplyCounts => {
    const counts: ApplyCounts = { added: 0, duplicates: 0, rejected: 0, openEndsClosed: 0 };
    const existing = new Set(db.all<{ dedupe_key: string }>(
      'SELECT dedupe_key FROM canon_thread_note WHERE thread_id = ?',
      item.threadId,
    ).map((row) => row.dedupe_key));
    const openTokens = openEndTokens(item);
    const closed = new Set<number>();

    const findOpenEnd = (note: WorkerNote): number | null => {
      const tokens = significantTokens(`${note.quote} ${note.claim}`);
      for (const open of openTokens) {
        if (closed.has(open.id)) continue;
        for (const token of open.tokens) {
          if (tokens.has(token)) return open.id;
        }
      }
      return null;
    };

    for (const entry of notes) {
      const verdict = validateWorkerNote(entry.note, entry.passage, WORKER_NOTE_KINDS, existing);
      if (!verdict.ok) {
        if (verdict.reason === 'duplicate') counts.duplicates++;
        else counts.rejected++;
        continue;
      }
      const key = noteDedupeKey(entry.note.quote, entry.note.claim);
      existing.add(key);
      counts.added++;
      const openEndId = findOpenEnd(entry.note);
      if (opts.dryRun) {
        if (openEndId !== null) {
          closed.add(openEndId);
          counts.openEndsClosed++;
        }
        continue;
      }

      const isContext = entry.note.kind === 'context';
      const noteId = Number(db.run(
        `INSERT INTO canon_thread_note
           (project_id, thread_id, chunk_id, locator, quote, claim, note_kind, strength,
            why, missing, is_context, supersedes_note_id, dedupe_key, strength_source, claim_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, NULL, ?, 'worker', '', ?)`,
        projectId,
        item.threadId,
        entry.passage.chunkId,
        entry.passage.locator,
        entry.note.quote,
        entry.note.claim,
        entry.note.kind,
        Math.min(1, Math.max(0, Number(entry.note.strength) || 0)),
        isContext ? 1 : 0,
        key,
        nowIso(),
      ).lastInsertRowid);

      if (openEndId !== null) {
        const changed = db.run(
          `UPDATE canon_open_end
              SET status = 'resolved', resolved_by_note_id = ?, resolved_at = ?
            WHERE id = ? AND thread_id = ? AND project_id = ? AND status = 'open'`,
          noteId,
          nowIso(),
          openEndId,
          item.threadId,
          projectId,
        ).changes;
        if (changed > 0) {
          closed.add(openEndId);
          counts.openEndsClosed++;
        }
      }
    }
    return counts;
  };

  return opts.dryRun ? run() : db.transaction(run);
}
