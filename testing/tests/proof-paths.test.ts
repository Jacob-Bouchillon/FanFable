/**
 * Proof paths: the status-of guard and the bank answer line resolve the same
 * pair/keeper lookup. Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/controller.ts';
import * as lore from '../../fanfable/src/lore.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function addEntity(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  name: string,
): number {
  return db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    projectId,
    'character',
    name,
    '[]',
    'accepted',
    AT,
    AT,
  ).lastInsertRowid;
}

test('status-of and arbitrary wordings share the keeper lookup', () => {
  const { db } = tempDb();
  const project = createProject(db, 'proof-shared');
  const asha = addEntity(db, project.id, 'Asha');
  const bram = addEntity(db, project.id, 'Bram');
  const cora = addEntity(db, project.id, 'Cora');
  const source = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    '/probe',
    'Probe',
    'sha',
    AT,
  ).lastInsertRowid;
  const chunk = db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    source,
    project.id,
    1,
    'p1',
    '',
    'Asha is the apprentice of Bram.',
    7,
  ).lastInsertRowid;
  db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
        review_status, modality, created_at)
     VALUES (?, ?, ?, 'apprentice of', 'x', 'Asha is the apprentice of Bram.', ?,
             'user_confirmed', 'asserted', ?)`,
    project.id,
    asha,
    bram,
    JSON.stringify([{ source: 'Probe', locator: 'p1', chunk }]),
    AT,
  );

  assert.equal(lorebook.lookupKeeperPair(db, project.id, 'Asha', 'Bram').length, 1);
  assert.equal(lorebook.lookupKeeperPair(db, project.id, 'Asha', 'Cora').length, 0);

  const status = lorebook.bankAnswerForQuestion(db, project.id, 'status of Asha to Bram');
  const arbitrary = lorebook.bankAnswerForQuestion(db, project.id, 'who is the apprentice of Bram');
  assert.equal(status.status, 'keeper');
  assert.equal(arbitrary.status, 'keeper');
  assert.match(status.line ?? '', /^Asha — apprentice of Bram$/);
  assert.match(arbitrary.line ?? '', /^Asha — apprentice of Bram$/);

  const outage = lorebook.bankAnswerForQuestion(db, project.id, 'status of Asha to Cora');
  const noArbitrary = lorebook.bankAnswerForQuestion(db, project.id, 'who is the apprentice of Cora');
  assert.equal(outage.status, 'none');
  assert.equal(noArbitrary.status, 'none');
  db.close();
});

test('the answer guard and the bank line agree on the same pair', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'proof-guard');
  const asha = addEntity(db, project.id, 'Asha');
  const bram = addEntity(db, project.id, 'Bram');
  addEntity(db, project.id, 'Cora');
  db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
        review_status, modality, created_at)
     VALUES (?, ?, ?, 'apprentice of', 'x', 'Asha is the apprentice of Bram.', '[]',
             'user_confirmed', 'asserted', ?)`,
    project.id,
    asha,
    bram,
    AT,
  );
  const llm = mockProvider((req) => {
    if ((req.system ?? '').includes('Lore Researcher')) {
      return 'CONFIRMED: Asha is the apprentice of Bram.';
    }
    if ((req.system ?? '').includes('expand a lore question')) return '{"terms":[]}';
    return '{}';
  });

  const banked = await lore.answerLoreQuestion(db, llm, project.id, 'status of Asha to Bram');
  assert.match(banked.answer, /CONFIRMED/);
  const missing = await lore.answerLoreQuestion(db, llm, project.id, 'status of Asha to Cora');
  assert.match(missing.answer, /Tie not established/);
  db.close();
});
