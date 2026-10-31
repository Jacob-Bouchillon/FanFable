/**
 * Merging entities carries tie notes to the survivor instead of letting the
 * entity delete cascade them away. Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function addEntity(db: ReturnType<typeof tempDb>['db'], projectId: number, name: string): number {
  return db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    projectId,
    'character',
    name,
    '[]',
    AT,
    AT,
  ).lastInsertRowid;
}

function addNote(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  from: number,
  to: number,
  attemptedKind: string,
  status: 'pending' | 'resolved',
  ruling = '',
): number {
  return db.run(
    `INSERT INTO canon_tie_note
       (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs,
        status, ruling, ruled_at, created_at)
     VALUES (?, ?, ?, ?, 'open-vocab', 'evidence', '[]', ?, ?, ?, ?)`,
    projectId,
    from,
    to,
    attemptedKind,
    status,
    ruling,
    status === 'resolved' ? AT : '',
    AT,
  ).lastInsertRowid;
}

test('a merge carries pending and resolved notes and resolves collisions by precedence', () => {
  const { db } = tempDb();
  const project = createProject(db, 'merge-notes');
  const keepId = addEntity(db, project.id, 'Marrow');
  const dropId = addEntity(db, project.id, 'Marrow Prime');
  const otherA = addEntity(db, project.id, 'Neris');
  const otherB = addEntity(db, project.id, 'Ovid');
  const otherC = addEntity(db, project.id, 'Pell');
  const otherD = addEntity(db, project.id, 'Quill');
  const otherE = addEntity(db, project.id, 'Rusk');

  // Moved as-is: one pending, one resolved with its ruling.
  addNote(db, project.id, dropId, otherA, 'knows', 'pending');
  addNote(db, project.id, dropId, otherB, 'trails', 'resolved', 'ruling-c');
  // Untouched: belongs to the survivor already.
  addNote(db, project.id, keepId, otherC, 'aids', 'resolved', 'ruling-b');
  // Collision 1: resolved incoming over pending existing.
  addNote(db, project.id, keepId, otherD, 'ally of', 'pending');
  addNote(db, project.id, dropId, otherD, 'ally of', 'resolved', 'ruling-d');
  // Collision 2: pending incoming over resolved existing.
  addNote(db, project.id, keepId, otherE, 'rival of', 'resolved', 'ruling-e');
  addNote(db, project.id, dropId, otherE, 'rival of', 'pending');
  // Self-notes after the endpoints collapse.
  addNote(db, project.id, dropId, keepId, 'serves', 'pending');
  addNote(db, project.id, keepId, dropId, 'mentor of', 'resolved', 'ruling-g');

  const entities = lorebook.listEntities(db, project.id);
  const keep = entities.find((e) => e.id === keepId)!;
  const drop = entities.find((e) => e.id === dropId)!;
  const counts = lorebook.mergeEntityPair(db, project.id, keep, drop);

  assert.deepEqual(counts, { moved: 2, collapsed: 2, droppedSelf: 1, keptSelf: 1 });

  const note = (from: number, to: number, kind: string) =>
    db.get<{ status: string; ruling: string }>(
      'SELECT status, ruling FROM canon_tie_note WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND attempted_kind = ?',
      project.id,
      from,
      to,
      kind,
    );

  assert.equal(note(dropId, otherA, 'knows'), undefined, 'no note left on the dropped entity');
  assert.deepEqual({ ...note(keepId, otherA, 'knows') }, { status: 'pending', ruling: '' });
  assert.deepEqual({ ...note(keepId, otherB, 'trails') }, { status: 'resolved', ruling: 'ruling-c' });
  assert.deepEqual({ ...note(keepId, otherC, 'aids') }, { status: 'resolved', ruling: 'ruling-b' });

  const ally = db.all<{ status: string; ruling: string }>(
    "SELECT status, ruling FROM canon_tie_note WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND attempted_kind = 'ally of'",
    project.id,
    keepId,
    otherD,
  );
  assert.equal(ally.length, 1, 'collision leaves one row');
  assert.deepEqual({ ...ally[0] }, { status: 'resolved', ruling: 'ruling-d' }, 'resolved ruling wins');

  const rival = db.get<{ status: string; ruling: string }>(
    "SELECT status, ruling FROM canon_tie_note WHERE project_id = ? AND from_entity = ? AND to_entity = ? AND attempted_kind = 'rival of'",
    project.id,
    keepId,
    otherE,
  );
  assert.deepEqual({ ...rival }, { status: 'resolved', ruling: 'ruling-e' }, 'existing ruling kept');

  assert.equal(note(keepId, keepId, 'serves'), undefined, 'pending self-note dropped');
  assert.deepEqual(
    { ...note(keepId, keepId, 'mentor of') },
    { status: 'resolved', ruling: 'ruling-g' },
    'resolved self-note kept for audit',
  );

  assert.equal(
    db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ? AND (from_entity = ? OR to_entity = ?)',
      project.id,
      dropId,
      dropId,
    )!.n,
    0,
    'no note still points at the dropped entity',
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id = ?', project.id)!.n,
    6,
    'six notes survive the merge',
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE id = ?', dropId)!.n,
    0,
    'the dropped entity is gone',
  );
  const merged = db.get<{ aliases: string }>('SELECT aliases FROM canon_entity WHERE id = ?', keepId)!;
  assert.ok(merged.aliases.includes('Marrow Prime'), 'the dropped name becomes an alias');
  db.close();
});
