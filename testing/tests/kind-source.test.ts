/**
 * Kind source: the words in the quote that express the relationship, when the
 * label's own word is absent. The words must be verbatim in the quote, so this
 * records a reading of the sentence rather than replacing it.
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

function chunk(db: Db, projectId: number, text: string): number {
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      's.txt',
      'source',
      'sha',
      AT,
    ).lastInsertRowid,
  );
  return Number(
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, text, locator) VALUES (?, ?, ?, ?, ?)',
      sourceId,
      projectId,
      0,
      text,
      'p. 1',
    ).lastInsertRowid,
  );
}

function setup(name: string, quote: string, kindSource?: string) {
  const { db } = tempDb();
  const project = controller.createProject(db, name);
  const from = entity(db, project.id, 'Mara');
  const to = entity(db, project.id, 'Tor');
  const chunkId = chunk(db, project.id, quote);
  const id = lorebook.insertRelation(db, project.id, {
    fromEntity: from,
    toEntity: to,
    kind: 'ally of',
    evidence: quote,
    sourceRefs: JSON.stringify([{ source: 'source', locator: 'p. 1', chunk: chunkId }]),
    kindSource,
  });
  return { db, project, id };
}

test('the words are stored with the row', () => {
  const quote = 'Mara threw in with Tor before the vote.';
  const { db, id } = setup('kind-source-store', quote, 'threw in with');
  const row = db.get<{ kind_source: string }>('SELECT kind_source FROM canon_relation WHERE id = ?', id);
  assert.ok(row);
  assert.equal(row.kind_source, 'threw in with');
  db.close();
});

test('without the words, the same quote fails the tie check', () => {
  const quote = 'Mara threw in with Tor before the vote.';
  const { db, project, id } = setup('kind-source-absent', quote);
  const decision = lorebook.canPromoteRelation(db, project.id, id);
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'tie-word-absent');
  db.close();
});

test('with the words, the same quote passes', () => {
  const quote = 'Mara threw in with Tor before the vote.';
  const { db, project, id } = setup('kind-source-present', quote, 'threw in with');
  const decision = lorebook.canPromoteRelation(db, project.id, id);
  assert.equal(decision.ok, true);
  db.close();
});

test('words that are not in the quote prove nothing', () => {
  const quote = 'Mara threw in with Tor before the vote.';
  const { db, project, id } = setup('kind-source-foreign', quote, 'backed');
  const decision = lorebook.canPromoteRelation(db, project.id, id);
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'tie-word-absent');
  db.close();
});
