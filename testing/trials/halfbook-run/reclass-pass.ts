/**
 * Ruled reclassification + funnel pass for the halfbook lab bank.
 *
 * Data-only: kind updates, eight fact conversions, two audited merges.
 * Prints counts only, never passage text.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { listEntities, mergeEntityPair } from '../../../fanfable/src/lorebook.ts';
import type { Db } from '../../../fanfable/src/core/db.ts';

const DB_PATH = process.env.FANFABLE_DB ?? 'testing/trials/halfbook-run/plagueis-half.db';
const BACKUP = 'testing/trials/tmp-archive/reclass-backup/plagueis-half.db.bak';
const PROJECT = 1;
const NOW = new Date().toISOString();

const FOLDERS = [
  { id: 310, subjectId: 1 },
  { id: 312, subjectId: 1 },
  { id: 313, subjectId: 1 },
  { id: 402, subjectId: 1 },
  { id: 342, subjectId: 215 },
  { id: 380, subjectId: 215 },
  { id: 381, subjectId: 215 },
  { id: 344, subjectId: 215 },
];

const KIND_GROUPS: Record<string, number[]> = {
  species: [14, 22, 25, 26, 27, 28, 35, 36, 46, 64, 97, 314, 327, 400],
  faction: [29, 31, 34, 110, 146, 187, 432, 455],
  character: [186, 357],
  item: [214, 412],
  rule: [88],
  creature: [359, 379, 404, 405],
};

const DELETED_NAMES = [
  'bats',
  'fish',
  'insects',
  'veermok',
  'aiwha',
  'zalaaca',
  'warrior',
  'Greel trees',
];

// --- backup verification ----------------------------------------------------
if (!existsSync(BACKUP)) throw new Error('backup missing');
const backupSize = statSync(BACKUP).size;
{
  const b = new DatabaseSync(BACKUP, { readOnly: true });
  const ok = b.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
  if (ok.integrity_check !== 'ok') throw new Error('backup integrity failed');
  b.close();
}

const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA busy_timeout = 5000');
raw.exec('PRAGMA foreign_keys = ON');
{
  const ok = raw.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
  if (ok.integrity_check !== 'ok') throw new Error('live integrity failed');
}

// Minimal Db surface used by mergeEntityPair; keeps the op script free of
// the app's constructor-side normalization writes.
let depth = 0;
const adapter = {
  run(sql: string, ...params: unknown[]) {
    const r = raw.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  },
  get(sql: string, ...params: unknown[]) {
    return raw.prepare(sql).get(...(params as never[]));
  },
  all(sql: string, ...params: unknown[]) {
    return raw.prepare(sql).all(...(params as never[]));
  },
  transaction<T>(fn: () => T): T {
    if (depth > 0) {
      depth++;
      try {
        return fn();
      } finally {
        depth--;
      }
    }
    raw.exec('BEGIN');
    depth = 1;
    try {
      const out = fn();
      raw.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        raw.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    } finally {
      depth = 0;
    }
  },
};
const db = adapter as unknown as Db;

const one = (sql: string, ...params: unknown[]): number =>
  Number((raw.prepare(sql).get(...(params as never[])) as { n?: number } | undefined)?.n ?? 0);

const normalize = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

function refCounts(id: number): Record<string, number> {
  return {
    relations: one(
      'SELECT COUNT(*) n FROM canon_relation WHERE from_entity = ? OR to_entity = ?',
      id,
      id,
    ),
    participants: one('SELECT COUNT(*) n FROM canon_event_participant WHERE entity_id = ?', id),
    tieNotes: one(
      'SELECT COUNT(*) n FROM canon_tie_note WHERE from_entity = ? OR to_entity = ?',
      id,
      id,
    ),
    factSubject: one('SELECT COUNT(*) n FROM canon_fact WHERE subject_entity_id = ?', id),
    characterRef: one('SELECT COUNT(*) n FROM character WHERE canon_entity_id = ?', id),
    secretRef: one('SELECT COUNT(*) n FROM secret WHERE subject_entity_id = ?', id),
    storyFactRef: one('SELECT COUNT(*) n FROM story_fact WHERE subject_entity_id = ?', id),
  };
}

const snapshot = () => ({
  entities: one('SELECT COUNT(*) n FROM canon_entity WHERE project_id = ?', PROJECT),
  relations: one('SELECT COUNT(*) n FROM canon_relation WHERE project_id = ?', PROJECT),
  facts: one('SELECT COUNT(*) n FROM canon_fact WHERE project_id = ?', PROJECT),
  notes: one('SELECT COUNT(*) n FROM canon_tie_note WHERE project_id = ?', PROJECT),
  notesByStatus: Object.fromEntries(
    (
      raw
        .prepare('SELECT status, COUNT(*) n FROM canon_tie_note WHERE project_id = ? GROUP BY status')
        .all(PROJECT) as { status: string; n: number }[]
    ).map((r) => [r.status, Number(r.n)]),
  ),
  kinds: Object.fromEntries(
    (
      raw
        .prepare('SELECT kind, COUNT(*) n FROM canon_entity WHERE project_id = ? GROUP BY kind')
        .all(PROJECT) as { kind: string; n: number }[]
    ).map((r) => [r.kind, Number(r.n)]),
  ),
});

const summary: Record<string, unknown> = {
  backup: { path: BACKUP, bytes: backupSize, integrity: 'ok' },
};

adapter.transaction(() => {
  summary.before = snapshot();

  const facts: { id: number; topic: string; subject: string }[] = [];
  const failed: { id: number; name: string; reason: string }[] = [];
  const blocked: { id: number; name: string; refs: Record<string, number> }[] = [];

  for (const folder of FOLDERS) {
    const entity = raw
      .prepare('SELECT id, name, evidence, source_refs FROM canon_entity WHERE project_id = ? AND id = ?')
      .get(PROJECT, folder.id) as
      | { id: number; name: string; evidence: string; source_refs: string }
      | undefined;
    if (!entity) {
      failed.push({ id: folder.id, name: '(missing)', reason: 'entity missing' });
      continue;
    }
    const refs = JSON.parse(entity.source_refs || '[]') as { chunk?: number }[];
    const ref = refs.find((r) => Number.isFinite(r.chunk));
    if (!ref || ref.chunk == null) {
      failed.push({ id: entity.id, name: entity.name, reason: 'no chunk ref' });
      continue;
    }
    const chunk = raw.prepare('SELECT text FROM canon_chunk WHERE id = ?').get(ref.chunk) as
      | { text: string }
      | undefined;
    const quote = String(entity.evidence ?? '').trim();
    if (!chunk || !quote || !normalize(chunk.text).includes(normalize(quote))) {
      failed.push({ id: entity.id, name: entity.name, reason: 'evidence not verbatim' });
      continue;
    }
    const target = raw
      .prepare('SELECT id, name FROM canon_entity WHERE project_id = ? AND id = ?')
      .get(PROJECT, folder.subjectId) as { id: number; name: string } | undefined;
    if (!target) {
      failed.push({ id: entity.id, name: entity.name, reason: 'subject missing' });
      continue;
    }

    const inserted = raw
      .prepare(
        `INSERT INTO canon_fact
           (project_id, topic, statement, kind, certainty, subject, evidence, source_refs,
            subject_entity_id, confidence, review_status, created_at, modality, conflict_status)
         VALUES (?, ?, ?, 'fact', 'confirmed', ?, ?, ?, ?, 1.0, 'accepted', ?, 'asserted', 'none')`,
      )
      .run(PROJECT, entity.name, quote, target.name, quote, entity.source_refs, target.id, NOW);
    facts.push({
      id: Number(inserted.lastInsertRowid),
      topic: entity.name,
      subject: target.name,
    });

    const refsNow = refCounts(entity.id);
    if (Object.values(refsNow).some((n) => n > 0)) {
      blocked.push({ id: entity.id, name: entity.name, refs: refsNow });
      continue;
    }
    const deleted = raw
      .prepare('DELETE FROM canon_entity WHERE project_id = ? AND id = ?')
      .run(PROJECT, entity.id);
    if (Number(deleted.changes) !== 1) throw new Error(`delete failed for ${entity.id}`);
  }

  summary.facts = facts;
  summary.failed = failed;
  summary.blocked = blocked;

  const noteTotalBeforeMerges = one('SELECT COUNT(*) n FROM canon_tie_note WHERE project_id = ?', PROJECT);
  const entities = listEntities(db, PROJECT);
  const keep = entities.find((e) => e.id === 1);
  const drop32 = entities.find((e) => e.id === 32);
  const drop33 = entities.find((e) => e.id === 33);
  if (!keep || !drop32 || !drop33) throw new Error('merge endpoints missing');
  const merge32 = mergeEntityPair(db, PROJECT, keep, drop32);
  // Re-read the survivor: its aliases and mention count changed.
  const keepAfter32 = listEntities(db, PROJECT).find((e) => e.id === 1);
  if (!keepAfter32) throw new Error('survivor missing after first merge');
  const merge33 = mergeEntityPair(db, PROJECT, keepAfter32, drop33);
  const noteTotalAfterMerges = one('SELECT COUNT(*) n FROM canon_tie_note WHERE project_id = ?', PROJECT);

  summary.merges = { merge32, merge33 };
  summary.notesMerge = {
    before: noteTotalBeforeMerges,
    after: noteTotalAfterMerges,
    decrease:
      noteTotalBeforeMerges -
      noteTotalAfterMerges,
    explainedCollapse:
      merge32.collapsed + merge33.collapsed + merge32.droppedSelf + merge33.droppedSelf,
  };
  if (
    noteTotalBeforeMerges - noteTotalAfterMerges !==
    merge32.collapsed + merge33.collapsed + merge32.droppedSelf + merge33.droppedSelf
  ) {
    throw new Error('note rows decreased beyond reported collapses');
  }

  const kindResults: Record<string, number> = {};
  const kindSkipped: { id: number; actual: string }[] = [];
  for (const [kind, ids] of Object.entries(KIND_GROUPS)) {
    const safe = ids.filter((id) => {
      const row = raw.prepare('SELECT kind FROM canon_entity WHERE id = ?').get(id) as
        | { kind: string }
        | undefined;
      if (row?.kind === 'creature') return true;
      kindSkipped.push({ id, actual: row?.kind ?? 'missing' });
      return false;
    });
    if (!safe.length) continue;
    const placeholders = safe.map(() => '?').join(',');
    const updated = raw
      .prepare(
        `UPDATE canon_entity SET kind = ?, updated_at = ?
         WHERE project_id = ? AND kind = 'creature' AND id IN (${placeholders})`,
      )
      .run(kind, NOW, PROJECT, ...safe);
    if (Number(updated.changes) !== safe.length) {
      throw new Error(`kind update short for ${kind}`);
    }
    kindResults[kind] = safe.length;
  }
  summary.kinds = kindResults;
  summary.kindSkipped = kindSkipped;
  summary.after = snapshot();

  const accountIds = [1, 32, 33];
  summary.endpoints = Object.fromEntries(
    accountIds.map((id) => [
      id,
      raw.prepare('SELECT id, name, kind, aliases FROM canon_entity WHERE id = ?').get(id) ?? null,
    ]),
  );

  summary.sanity = {
    deletedNamesStillPresent: raw
      .prepare(
        `SELECT id, name FROM canon_entity WHERE project_id = ? AND name IN (${DELETED_NAMES.map(() => '?').join(',')})`,
      )
      .all(PROJECT, ...DELETED_NAMES),
    nightsisters: raw
      .prepare('SELECT id, name, kind FROM canon_entity WHERE project_id = ? AND id = 187')
      .get(PROJECT),
    note41: raw
      .prepare(
        "SELECT id, status, ruling FROM canon_tie_note WHERE project_id = ? AND from_entity = 1 AND to_entity = 183 AND attempted_kind = 'tutor of'",
      )
      .all(PROJECT),
    notesOnMerged: one(
      'SELECT COUNT(*) n FROM canon_tie_note WHERE from_entity IN (32,33) OR to_entity IN (32,33)',
    ),
  };
});

raw.close();

// Facts and topics are identifiers, not passage prose.
console.log(JSON.stringify(summary, null, 2));
