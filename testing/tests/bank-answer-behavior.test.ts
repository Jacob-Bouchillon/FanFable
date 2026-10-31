/**
 * Bank-answer behavior: activation, touch, inverse, typo, abstain, and rank.
 * Invented names only; no model calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function addEntity(db: ReturnType<typeof tempDb>['db'], projectId: number, name: string): number {
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

function addSourceChunk(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  seq: number,
  text: string,
): { source: number; chunk: number } {
  const source = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId,
    `/probe-${seq}`,
    `Probe ${seq}`,
    `sha-${seq}`,
    AT,
  ).lastInsertRowid;
  const chunk = db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    source,
    projectId,
    seq,
    `p${seq}`,
    '',
    text,
    text.split(/\s+/).length,
  ).lastInsertRowid;
  return { source, chunk };
}

function addTie(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  from: number,
  to: number,
  kind: string,
  chunk: number,
  locator: string,
  evidence: string,
): number {
  return db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
        review_status, modality, created_at)
     VALUES (?, ?, ?, ?, 'x', ?, ?, 'user_confirmed', 'asserted', ?)`,
    projectId,
    from,
    to,
    kind,
    evidence,
    JSON.stringify([{ source: 'Probe', locator, chunk }]),
    AT,
  ).lastInsertRowid;
}

test('activation: attribute abstains, relation activates', () => {
  const { db } = tempDb();
  const project = createProject(db, 'bank-activation');
  const asha = addEntity(db, project.id, 'Asha');
  const bram = addEntity(db, project.id, 'Bram');
  const { chunk } = addSourceChunk(db, project.id, 1, 'Asha is the apprentice of Bram.');
  addTie(db, project.id, asha, bram, 'apprentice of', chunk, 'p1', 'Asha is the apprentice of Bram.');

  assert.equal(lorebook.buildBankProfile(db, project.id, 'what color are Asha eyes').bankActive, false);
  assert.equal(lorebook.buildBankProfile(db, project.id, 'who is the apprentice of Asha').bankActive, true);
  assert.equal(lorebook.bankAnswerForQuestion(db, project.id, 'what color are Asha eyes').status, 'none');
  db.close();
});

test('touch: a cue-word title does not admit an unrelated keeper', () => {
  const { db } = tempDb();
  const project = createProject(db, 'bank-touch');
  const asha = addEntity(db, project.id, 'Asha');
  const master = addEntity(db, project.id, 'Master');
  const dain = addEntity(db, project.id, 'Dain');
  const { chunk } = addSourceChunk(db, project.id, 1, 'Master trained Dain.');
  addTie(db, project.id, master, dain, 'master of', chunk, 'p1', 'Master trained Dain.');

  assert.equal(lorebook.bankAnswerForQuestion(db, project.id, 'who is the master of Asha').status, 'none');
  db.close();
});

test('inverse behavior: master wording returns the apprentice row; reverse abstains', () => {
  const { db } = tempDb();
  const project = createProject(db, 'bank-inverse');
  const asha = addEntity(db, project.id, 'Asha');
  const bram = addEntity(db, project.id, 'Bram');
  const { chunk } = addSourceChunk(db, project.id, 1, 'Asha is the apprentice of Bram.');
  addTie(db, project.id, asha, bram, 'apprentice of', chunk, 'p1', 'Asha is the apprentice of Bram.');

  const master = lorebook.bankAnswerForQuestion(db, project.id, 'who is the master of Asha');
  assert.equal(master.status, 'keeper');
  assert.match(master.line ?? '', /^Asha — apprentice of Bram$/);
  assert.equal(
    lorebook.bankAnswerForQuestion(db, project.id, 'who is the apprentice of Asha').status,
    'none',
  );
  db.close();
});

test('typo behavior: one edit links, two do not', () => {
  const { db } = tempDb();
  const project = createProject(db, 'bank-typo');
  const asha = addEntity(db, project.id, 'Asha');
  const bram = addEntity(db, project.id, 'Bramwell');
  const { chunk } = addSourceChunk(db, project.id, 1, 'Asha is the apprentice of Bramwell.');
  addTie(db, project.id, asha, bram, 'apprentice of', chunk, 'p1', 'Asha is the apprentice of Bramwell.');

  assert.equal(lorebook.bankAnswerForQuestion(db, project.id, 'who is the apprentice of Bramwel').status, 'keeper');
  assert.equal(lorebook.bankAnswerForQuestion(db, project.id, 'who is the apprentice of Bramwllx').status, 'none');
  db.close();
});

test('abstain: zero keepers is none; several keeper lines is several', () => {
  const { db } = tempDb();
  const project = createProject(db, 'bank-abstain');
  const asha = addEntity(db, project.id, 'Asha');
  const bram = addEntity(db, project.id, 'Bram');
  const cora = addEntity(db, project.id, 'Cora');
  assert.equal(lorebook.bankAnswerForQuestion(db, project.id, 'who is the apprentice of Asha').status, 'none');

  const { chunk } = addSourceChunk(db, project.id, 1, 'Asha has two apprentice claims.');
  addTie(db, project.id, asha, bram, 'apprentice of', chunk, 'p1', 'Asha has two apprentice claims.');
  addTie(db, project.id, cora, bram, 'apprentice of', chunk, 'p1', 'Asha has two apprentice claims.');
  assert.equal(lorebook.bankAnswerForQuestion(db, project.id, 'who is the apprentice of Bram').status, 'several');
  db.close();
});

test('bank rank: keeper passage first, nonsense preserves input', () => {
  const { db } = tempDb();
  const project = createProject(db, 'bank-rank');
  const asha = addEntity(db, project.id, 'Asha');
  const bram = addEntity(db, project.id, 'Bram');
  const { chunk } = addSourceChunk(db, project.id, 1, 'Asha is the apprentice of Bram.');
  addTie(db, project.id, asha, bram, 'apprentice of', chunk, 'p1', 'Asha is the apprentice of Bram.');

  const candidates = [
    { chunkId: 2, text: 'Unrelated passage.', score: 1 },
    { chunkId: chunk, text: 'Asha is the apprentice of Bram.', score: 0 },
  ];
  const ranked = lorebook.rankWithBank(db, project.id, 'who is the apprentice of Bram', candidates);
  assert.equal(ranked[0]?.chunkId, chunk);
  const noise = lorebook.rankWithBank(db, project.id, 'xyzzy plugh', candidates);
  assert.deepEqual(noise.map((c) => c.chunkId), [2, chunk]);
  db.close();
});
