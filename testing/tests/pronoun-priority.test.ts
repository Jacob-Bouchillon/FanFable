/**
 * Pronoun-first review prioritisation (offline: temp DBs, no model calls).
 *
 * The notes ranking path takes no LLM client; these tests pin that
 * pronoun-backtracked rows (verbatim quote + anchor sentence present +
 * pronoun/role reference + endpoints resolved) rank first, that ranking
 * never writes, and that every row carries anchor + why + score.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

type Db = ReturnType<typeof tempDb>['db'];

function addEntity(db: Db, projectId: number, name: string): number {
  return Number(
    db.run(
      'INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
      projectId,
      name,
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function addChunk(db: Db, projectId: number, text: string): number {
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      `/pronoun-${Math.random().toString(36).slice(2)}`,
      'Pronoun',
      'sha-pronoun',
      AT,
    ).lastInsertRowid,
  );
  return Number(
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sourceId,
      projectId,
      1,
      'p. 1',
      '',
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
}

function addNote(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  kind: string,
  evidence: string,
  chunk: number,
): number {
  return Number(
    db.run(
      `INSERT INTO canon_tie_note (project_id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status, created_at)
       VALUES (?, ?, ?, ?, 'unsupported', ?, ?, 'pending', ?)`,
      projectId,
      from,
      to,
      kind,
      evidence,
      JSON.stringify([{ source: 'Pronoun', locator: 'p. 1', chunk }]),
      AT,
    ).lastInsertRowid,
  );
}

function setup() {
  const { db } = tempDb();
  const project = createProject(db, `pronoun-${Math.random().toString(36).slice(2, 7)}`);
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  const chunk = addChunk(
    db,
    project.id,
    'Mara and Tor spoke at dawn. Mara feared him. Mara was afraid of Tor and raised him.',
  );
  return { db, project, mara, tor, chunk };
}

test('pronoun-backed verbatim rows rank first', () => {
  const { db, project, mara, tor, chunk } = setup();
  const plain = addNote(db, project.id, mara, tor, 'ally of', 'Mara and Tor spoke at dawn.', chunk);
  const backed = addNote(db, project.id, mara, tor, 'aunt of', 'Mara feared him.', chunk);
  const bad = addNote(db, project.id, mara, tor, 'friend of', 'Mara feared Tor dreadfully.', chunk);

  const queue = lorebook.prioritiseTieNotes(db, project.id);
  assert.deepEqual(queue.map((r) => r.id), [backed, plain, bad]);
  const first = queue[0]!;
  assert.equal(first.pronounBacked, true);
  assert.equal(first.score, 4);
  assert.ok(first.anchor.length > 0, 'anchor sentence shown');
  assert.ok(first.why.length > 0 && !first.why.includes('\n'), 'why is one line');
  db.close();
});

test('ranking never changes status or tier', () => {
  const { db, project, mara, tor, chunk } = setup();
  addNote(db, project.id, mara, tor, 'ally of', 'Mara and Tor spoke at dawn.', chunk);
  addNote(db, project.id, mara, tor, 'aunt of', 'Mara feared him.', chunk);
  const relProvisional = Number(
    db.run(
      `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at)
       VALUES (?, ?, ?, 'ally of', 'Mara and Tor spoke at dawn.', ?, 'provisional', ?)`,
      project.id,
      mara,
      tor,
      JSON.stringify([{ source: 'Pronoun', locator: 'p. 1', chunk }]),
      AT,
    ).lastInsertRowid,
  );
  const relParked = Number(
    db.run(
      `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at)
       VALUES (?, ?, ?, 'friend of', 'Mara and Tor spoke at dawn.', ?, 'needs_review', ?)`,
      project.id,
      mara,
      tor,
      JSON.stringify([{ source: 'Pronoun', locator: 'p. 1', chunk }]),
      AT,
    ).lastInsertRowid,
  );
  const before = db.all<{ id: number; status: string }>(
    'SELECT id, status FROM canon_tie_note WHERE project_id = ? ORDER BY id',
    project.id,
  );
  lorebook.prioritiseTieNotes(db, project.id);
  lorebook.prioritiseTieNotes(db, project.id, { limit: 1 });
  const after = db.all<{ id: number; status: string }>(
    'SELECT id, status FROM canon_tie_note WHERE project_id = ? ORDER BY id',
    project.id,
  );
  assert.deepEqual(after, before, 'note statuses untouched');
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', relProvisional)!.review_status,
    'provisional',
  );
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', relParked)!.review_status,
    'needs_review',
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)!.n,
    2,
    'no relation written',
  );
  db.close();
});

test('every ranked row carries anchor, why and score', () => {
  const { db, project, mara, tor, chunk } = setup();
  addNote(db, project.id, mara, tor, 'ally of', 'Mara and Tor spoke at dawn.', chunk);
  addNote(db, project.id, mara, tor, 'aunt of', 'Mara feared him.', chunk);
  const queue = lorebook.prioritiseTieNotes(db, project.id);
  assert.ok(queue.length === 2);
  for (const row of queue) {
    assert.equal(typeof row.anchor, 'string');
    assert.ok(row.why.length > 0 && !row.why.includes('\n'), 'why is one line');
    assert.ok(Number.isInteger(row.score) && row.score >= 0 && row.score <= 4);
    assert.equal(typeof row.pronounBacked, 'boolean');
  }
  db.close();
});

test('non-backed rows keep their existing order behind', () => {
  const { db, project, mara, tor, chunk } = setup();
  const first = addNote(db, project.id, mara, tor, 'ally of', 'Mara and Tor spoke at dawn.', chunk);
  const second = addNote(db, project.id, mara, tor, 'friend of', 'Mara feared Tor dreadfully.', chunk);
  // Backed note sorts first even with the highest id; the rest stay in id order.
  const backed = addNote(db, project.id, mara, tor, 'aunt of', 'Mara feared him.', chunk);
  const queue = lorebook.prioritiseTieNotes(db, project.id);
  assert.deepEqual(queue.map((r) => r.id), [backed, first, second]);
  db.close();
});
