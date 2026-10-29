/**
 * The scan takes direction from the judge, not from the order the pair was
 * listed in. A sentence that reads "Tor mentored Mara" must never become
 * "Mara mentor of Tor".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, tempDb } from './helpers.ts';

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
      `s-${Math.random().toString(36).slice(2)}.txt`,
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

function setup(name: string, sentence: string) {
  const { db } = tempDb();
  const project = controller.createProject(db, name);
  const mara = entity(db, project.id, 'Mara');
  const tor = entity(db, project.id, 'Tor');
  const chunkId = chunk(db, project.id, sentence);
  const candidate: lorebook.SentenceCandidate = {
    sentence,
    chunkId,
    locator: 'p. 1',
    fromId: mara,
    fromName: 'Mara',
    toId: tor,
    toName: 'Tor',
  };
  return { db, project, candidate, mara, tor };
}

test('direction comes from the judge, not from the candidate order', async () => {
  const sentence = 'Tor mentored Mara for years.';
  const { db, project, candidate, tor, mara } = setup('scan-direction', sentence);
  const llm = mockProvider(() => JSON.stringify({ tie: true, kind: 'mentor of', from: 'Tor', to: 'Mara' }));
  const result = await lorebook.verifySentenceCandidates(db, llm, project.id, [candidate]);
  assert.equal(result.accepted, 1);
  const row = db.get<{ from_entity: number; to_entity: number }>(
    'SELECT from_entity, to_entity FROM canon_relation WHERE project_id = ?',
    project.id,
  );
  assert.ok(row);
  assert.equal(row.from_entity, tor);
  assert.equal(row.to_entity, mara);
  db.close();
});

test('a judge that names neither endpoint is refused', async () => {
  const sentence = 'Tor mentored Mara for years.';
  const { db, project, candidate } = setup('scan-direction-none', sentence);
  const llm = mockProvider(() => JSON.stringify({ tie: true, kind: 'mentor of' }));
  const result = await lorebook.verifySentenceCandidates(db, llm, project.id, [candidate]);
  assert.equal(result.accepted, 0);
  assert.equal(result.refused, 1);
  const count = db.get<{ n: number }>('SELECT COUNT(*) n FROM canon_relation WHERE project_id = ?', project.id);
  assert.equal(count?.n, 0);
  db.close();
});

test('a denied sentence is refused', async () => {
  const sentence = 'Tor never mentored Mara.';
  const { db, project, candidate } = setup('scan-direction-deny', sentence);
  const llm = mockProvider(() => JSON.stringify({ tie: false }));
  const result = await lorebook.verifySentenceCandidates(db, llm, project.id, [candidate]);
  assert.equal(result.checked, 1);
  assert.equal(result.refused, 1);
  db.close();
});
