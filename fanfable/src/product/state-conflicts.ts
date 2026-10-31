/**
 * Conflicts between a new chapter and what the story already established.
 *
 * When a chapter is approved, its extracted developments are compared with
 * the approved state. A contradiction is *recorded*, not resolved: the
 * established record is kept, the new one is kept, and the conflict is
 * reported with the provenance of both so the author can decide.
 *
 * This is deliberately separate from the continuity checker. A continuity
 * issue is a problem inside the prose; a state conflict is a problem between
 * the prose and the story's own history.
 */
import { Db, nowIso, strList } from '../core/db.ts';
import type { StateExtraction } from './memory.ts';

export type ConflictKind =
  | 'character-status'
  | 'relationship'
  | 'fact'
  | 'knowledge'
  | 'event';

export interface StateConflict {
  id?: number;
  kind: ConflictKind;
  subject: string;
  /** Where the established record is: "fact 12", "relationship 3", … */
  existingRef: string;
  /** Where the new claim is: "chapter 4 knowledge", … */
  incomingRef: string;
  message: string;
  evidence: string;
  status: 'open' | 'accepted' | 'resolved';
}

const DEAD = /\b(dead|died|killed|murdered|is dead|has died)\b/i;
const GONE = /\b(missing|disappeared|vanished)\b/i;
const ALIVE = /\b(alive|living|is alive)\b/i;

/**
 * Compare an extraction with the approved state and report what disagrees.
 *
 * Nothing is changed here: the caller decides what to do with the result.
 */
export function detectConflicts(
  db: Db,
  projectId: number,
  chapterId: number | null,
  extraction: StateExtraction,
): StateConflict[] {
  const conflicts: StateConflict[] = [];

  /* ------------------------------------------- a character's status */
  for (const state of extraction.states ?? []) {
    if (!state.character) continue;
    const text = `${state.condition} ${state.situation} ${state.emotional}`;
    if (!DEAD.test(text) && !GONE.test(text)) continue;

    const character = db.get<{ id: number; name: string }>(
      'SELECT id, name FROM character WHERE project_id = ? AND lower(name) = lower(?)',
      projectId,
      state.character,
    );
    if (!character) continue;

    // Was this character's death already established?
    const known = db.get<{ id: number; situation: string; condition: string }>(
      'SELECT id, situation, condition FROM character_state WHERE project_id = ? AND character_id = ? ORDER BY id DESC LIMIT 1',
      projectId,
      character.id,
    );
    if (!known) continue;
    const established = `${known.situation ?? ''} ${known.condition ?? ''}`;
    if (DEAD.test(established) || GONE.test(established)) continue;

    conflicts.push({
      kind: 'character-status',
      subject: character.name,
      existingRef: `state ${known.id}`,
      incomingRef: `chapter ${chapterId ?? '?'} state`,
      message: `${character.name} was recorded as "${established.trim()}" and this chapter records them as "${(state.condition || state.situation || '').trim()}".`,
      evidence: state.situation || state.condition || '',
      status: 'open',
    });
  }

  /* ------------------------------------------- a relationship kind */
  for (const rel of extraction.relationships ?? []) {
    if (!rel.a || !rel.b) continue;
    const a = db.get<{ id: number; name: string }>(
      'SELECT id, name FROM character WHERE project_id = ? AND lower(name) = lower(?)',
      projectId,
      rel.a,
    );
    const b = db.get<{ id: number; name: string }>(
      'SELECT id, name FROM character WHERE project_id = ? AND lower(name) = lower(?)',
      projectId,
      rel.b,
    );
    if (!a || !b) continue;
    const current = db.get<{ id: number; kind: string; description: string; closed: number }>(
      `SELECT r.id AS id, r.kind AS kind, r.description AS description, r.closed AS closed
       FROM relationship r
       WHERE r.project_id = ? AND r.character_a IN (?, ?) AND r.character_b IN (?, ?) AND r.closed = 0
       ORDER BY r.id DESC LIMIT 1`,
      projectId,
      a.id,
      b.id,
      a.id,
      b.id,
    );
    if (!current) continue;
    if (current.kind.toLowerCase() === (rel.kind ?? '').toLowerCase()) continue;
    if (!rel.kind) continue;

    // A change is fine when this chapter shows what caused it: an event in
    // which both of them take part.
    const explained = (extraction.events ?? []).some((e) => {
      const who = (e.participants ?? []).map((n) => n.toLowerCase());
      return who.includes(a.name.toLowerCase()) && who.includes(b.name.toLowerCase());
    });
    if (explained) continue;

    conflicts.push({
      kind: 'relationship',
      subject: `${a.name} / ${b.name}`,
      existingRef: `relationship ${current.id}`,
      incomingRef: `chapter ${chapterId ?? '?'} relationship`,
      message: `${a.name} and ${b.name} are established as "${current.kind}"; this chapter makes them "${rel.kind}", with no recorded event to explain the change.`,
      evidence: rel.description || current.description,
      status: 'open',
    });
  }

  /* ------------------------------------------- a fact that contradicts */
  for (const fact of extraction.facts ?? []) {
    if (!fact.content) continue;
    const subject = fact.subject ?? '';
    const existing = db.all<{ id: number; content: string; certainty: string }>(
      'SELECT id, content, certainty FROM story_fact WHERE project_id = ? AND (subject = ? OR subject = ?)',
      projectId,
      subject,
      '',
    );
    for (const other of existing) {
      if (other.content.toLowerCase() === fact.content.toLowerCase()) continue;
      const a = other.content;
      const b = fact.content;
      const contradiction =
        (DEAD.test(a) && ALIVE.test(b)) ||
        (DEAD.test(b) && ALIVE.test(a)) ||
        (DEAD.test(a) && DEAD.test(b) === false && /not|no longer|never/i.test(b)) ||
        (GONE.test(a) && !GONE.test(b) && /found|returned|alive/i.test(b));
      if (!contradiction) continue;
      conflicts.push({
        kind: 'fact',
        subject: subject || 'the story',
        existingRef: `fact ${other.id}`,
        incomingRef: `chapter ${chapterId ?? '?'} fact`,
        message: `The story has established "${a}" and this chapter says "${b}".`,
        evidence: b,
        status: 'open',
      });
    }
  }

  /* ------------------------------------------- an event that was prevented */
  for (const change of extraction.canonChanges ?? []) {
    if (!['prevented', 'reversed', 'omitted'].includes(change.changeType ?? '')) continue;
    const subject = change.description ?? '';
    const earlier = db.get<{ id: number; description: string }>(
      `SELECT id, description FROM canon_change
       WHERE project_id = ? AND id != COALESCE(?, -1) AND change_type IN ('prevented','reversed','omitted')
         AND (description = ? OR lower(description) LIKE ?)
       LIMIT 1`,
      projectId,
      null,
      subject,
      `%${subject.slice(0, 40).toLowerCase()}%`,
    );
    if (!earlier) continue;
    conflicts.push({
      kind: 'event',
      subject: subject.slice(0, 80),
      existingRef: `change ${earlier.id}`,
      incomingRef: `chapter ${chapterId ?? '?'} change`,
      message: `This change repeats one the story has already recorded: "${earlier.description}".`,
      evidence: subject,
      status: 'open',
    });
  }

  /* ------------------------------------------- knowledge before learning */
  for (const k of extraction.knowledge ?? []) {
    if (!k.character || !k.fact) continue;
    const character = db.get<{ id: number; name: string }>(
      'SELECT id, name FROM character WHERE project_id = ? AND lower(name) = lower(?)',
      projectId,
      k.character,
    );
    if (!character) continue;
    const knows = db.get<{ id: number; certainty: string; fact: string }>(
      `SELECT id, certainty, fact FROM character_knowledge
       WHERE project_id = ? AND character_id = ? AND lower(fact) = lower(?) ORDER BY id DESC LIMIT 1`,
      projectId,
      character.id,
      k.fact,
    );
    if (!knows) continue;
    if (knows.certainty === k.certainty) continue;
    // A belief becoming knowledge is the normal shape of a reveal.
    if (knows.certainty === 'believes' && k.certainty === 'knows') continue;
    if (knows.certainty === 'suspects' && k.certainty === 'knows') continue;
    conflicts.push({
      kind: 'knowledge',
      subject: character.name,
      existingRef: `knowledge ${knows.id}`,
      incomingRef: `chapter ${chapterId ?? '?'} knowledge`,
      message: `${character.name} is recorded as "${knows.certainty}" of "${knows.fact}" and this chapter makes it "${k.certainty}".`,
      evidence: k.evidence || knows.fact,
      status: 'open',
    });
  }

  return conflicts;
}

/** Record the conflicts, so they can be shown and resolved later. */
export function saveConflicts(
  db: Db,
  projectId: number,
  chapterId: number | null,
  conflicts: StateConflict[],
): number[] {
  const ids: number[] = [];
  for (const c of conflicts) {
    const r = db.run(
      `INSERT INTO state_conflict (project_id, chapter_id, kind, subject, existing_ref, incoming_ref, message, evidence, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      chapterId,
      c.kind,
      c.subject,
      c.existingRef,
      c.incomingRef,
      c.message,
      c.evidence,
      c.status,
      nowIso(),
    );
    ids.push(r.lastInsertRowid);
  }
  return ids;
}

export function listConflicts(
  db: Db,
  projectId: number,
  opts: { openOnly?: boolean } = {},
): (StateConflict & { id: number; chapterNumber: number | null; createdAt: string })[] {
  const params: unknown[] = [projectId];
  let sql = `SELECT c.*, ch.number AS chapter_number FROM state_conflict c
             LEFT JOIN chapter ch ON ch.id = c.chapter_id WHERE c.project_id = ?`;
  if (opts.openOnly) sql += " AND c.status = 'open'";
  sql += ' ORDER BY c.id';
  const rows = db.all<{
    id: number;
    kind: string;
    subject: string;
    existing_ref: string;
    incoming_ref: string;
    message: string;
    evidence: string;
    status: string;
    chapter_number: number | null;
    created_at: string;
  }>(sql, ...params);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as ConflictKind,
    subject: r.subject,
    existingRef: r.existing_ref,
    incomingRef: r.incoming_ref,
    message: r.message,
    evidence: r.evidence,
    status: r.status as StateConflict['status'],
    chapterNumber: r.chapter_number,
    createdAt: r.created_at,
  }));
}

export function resolveConflict(db: Db, projectId: number, id: number, status: 'open' | 'accepted' | 'resolved'): void {
  db.run('UPDATE state_conflict SET status = ? WHERE id = ? AND project_id = ?', status, id, projectId);
}

export { strList };
