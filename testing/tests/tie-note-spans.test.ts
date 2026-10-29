/**
 * Tie notes accumulate spans across windows; once the book is read, a note
 * whose spans together name both people and state the tie becomes a keeper.
 * Each span must be verbatim in its own page. Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

type Db = ReturnType<typeof tempDb>['db'];

function entity(db: Db, projectId: number, name: string): number {
  return Number(
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      projectId,
      'character',
      name,
      '[]',
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function chunk(db: Db, projectId: number, text: string, page: number): { chunkId: number; refs: string } {
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      `s-${page}-${Math.random().toString(36).slice(2)}.txt`,
      'source',
      'sha',
      AT,
    ).lastInsertRowid,
  );
  const chunkId = Number(
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, text, locator, page_start, page_end) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sourceId,
      projectId,
      page,
      text,
      `p. ${page}`,
      page,
      page,
    ).lastInsertRowid,
  );
  return { chunkId, refs: JSON.stringify([{ source: 'source', locator: `p. ${page}`, chunk: chunkId, quote: text }]) };
}

function setup(name: string) {
  const { db } = tempDb();
  const project = controller.createProject(db, name);
  const from = entity(db, project.id, 'Mara');
  const to = entity(db, project.id, 'Tor');
  return { db, project, from, to };
}

test('a second note for the same pair adds a span instead of being ignored', () => {
  const { db, project, from, to } = setup('note-append');
  const a = chunk(db, project.id, 'Mara sided with the northern house.', 1);
  const b = chunk(db, project.id, 'Tor commanded the northern house.', 2);
  lorebook.persistTieNote(db, project.id, from, to, 'ally of', 'unsupported', 'Mara sided with the northern house.', a.refs);
  lorebook.persistTieNote(db, project.id, from, to, 'ally of', 'unsupported', 'Tor commanded the northern house.', b.refs);
  const row = db.get<{ source_refs: string }>('SELECT source_refs FROM canon_tie_note WHERE project_id = ?', project.id);
  assert.ok(row);
  const spans = lorebook.noteSpans({ evidence: '', source_refs: row.source_refs });
  assert.equal(spans.length, 2);
  db.close();
});

test('spans from two pages resolve the note into a keeper', () => {
  const { db, project, from, to } = setup('note-promote');
  const a = chunk(db, project.id, 'Mara sided with the northern house.', 1);
  const b = chunk(db, project.id, 'Tor commanded the northern house.', 2);
  lorebook.persistTieNote(db, project.id, from, to, 'ally of', 'unsupported', 'Mara sided with the northern house.', a.refs, '', 'sided with');
  lorebook.persistTieNote(db, project.id, from, to, 'ally of', 'unsupported', 'Tor commanded the northern house.', b.refs);
  assert.equal(lorebook.resolveAccumulatedNotes(db, project.id), 1);
  const rel = db.get<{ evidence: string; review_status: string }>(
    'SELECT evidence, review_status FROM canon_relation WHERE project_id = ?',
    project.id,
  );
  assert.ok(rel);
  assert.equal(rel.review_status, 'accepted');
  assert.equal(rel.evidence, 'Mara sided with the northern house.');
  const note = db.get<{ status: string; ruling: string }>('SELECT status, ruling FROM canon_tie_note WHERE project_id = ?', project.id);
  assert.ok(note);
  assert.equal(note.status, 'resolved');
  assert.equal(note.ruling, 'promoted');
  db.close();
});

test('one span alone is not enough', () => {
  const { db, project, from, to } = setup('note-single');
  const a = chunk(db, project.id, 'Mara sided with the northern house.', 1);
  lorebook.persistTieNote(db, project.id, from, to, 'ally of', 'unsupported', 'Mara sided with the northern house.', a.refs);
  assert.equal(lorebook.resolveAccumulatedNotes(db, project.id), 0);
  db.close();
});

test('spans that never state the tie do not resolve', () => {
  const { db, project, from, to } = setup('note-silent');
  const a = chunk(db, project.id, 'Mara met the northern house.', 1);
  const b = chunk(db, project.id, 'Tor commanded the northern house.', 2);
  lorebook.persistTieNote(db, project.id, from, to, 'ally of', 'unsupported', 'Mara met the northern house.', a.refs);
  lorebook.persistTieNote(db, project.id, from, to, 'ally of', 'unsupported', 'Tor commanded the northern house.', b.refs);
  assert.equal(lorebook.resolveAccumulatedNotes(db, project.id), 0);
  db.close();
});

test('a span that is not in its page does not count', () => {
  const { db, project, from, to } = setup('note-unverbatim');
  const a = chunk(db, project.id, 'Mara sided with the northern house.', 1);
  const b = chunk(db, project.id, 'Tor commanded the northern house.', 2);
  const invented = JSON.stringify([{ source: 'source', locator: 'p. 2', chunk: b.chunkId, quote: 'Tor ruled the northern house.' }]);
  lorebook.persistTieNote(db, project.id, from, to, 'ally of', 'unsupported', 'Mara sided with the northern house.', a.refs);
  lorebook.persistTieNote(db, project.id, from, to, 'ally of', 'unsupported', 'Tor ruled the northern house.', invented);
  assert.equal(lorebook.resolveAccumulatedNotes(db, project.id), 0);
  db.close();
});
