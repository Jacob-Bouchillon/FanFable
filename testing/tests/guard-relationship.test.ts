/** The guard verifies asserted relationships against keeper-grade evidence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import { enforceStatusTieGuard } from '../../fanfable/src/answer/lore-ask.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function setup() {
  const { db } = tempDb();
  const project = controller.createProject(db, `guard-rel-${Math.random().toString(36).slice(2, 7)}`);
  const mk = (name: string) => db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id, 'character', name, '[]', AT, AT,
  ).lastInsertRowid;
  const asha = mk('Asha');
  const bram = mk('Bram');
  const add = (from: number, to: number, kind: string): void => {
    db.run(
      `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at)
       VALUES (?, ?, ?, ?, 'quote', '[]', 'accepted', ?)`,
      project.id, from, to, kind, AT,
    );
  };
  return { db, project, asha, bram, add };
}

function guard(db: ReturnType<typeof tempDb>['db'], projectId: number, question: string, draft: string): string {
  return enforceStatusTieGuard(db, projectId, question, draft, []);
}

test('a supported claim passes unchanged', () => {
  const { db, project, asha, bram, add } = setup();
  add(asha, bram, 'sister of');
  const draft = "Asha is Bram's sister.";
  assert.equal(guard(db, project.id, 'Is Asha Bram\'s sister?', draft), draft);
  db.close();
});

test('an unsupported claim abstains', () => {
  const { db, project } = setup();
  const output = guard(db, project.id, 'Is Asha Bram\'s sister?', "Asha is Bram's sister.");
  assert.match(output, /Tie not established/);
  assert.match(output, /Original draft/);
  db.close();
});

test('a mixed answer keeps supported content and adds one correction line', () => {
  const { db, project, asha, bram, add } = setup();
  add(asha, bram, 'sister of');
  const draft = "Asha is Bram's sister. Asha is Bram's enemy.";
  const output = guard(db, project.id, 'How are Asha and Bram related?', draft);
  assert.match(output, /^Correction: Bank holds no keeper for: Asha enemy Bram \(unsupported-relationship\)\./);
  assert.ok(output.includes("Asha is Bram's sister."));
  assert.ok(output.includes("Asha is Bram's enemy."));
  assert.equal((output.match(/^Correction:/gm) ?? []).length, 1);
  db.close();
});

test('the closed inverse direction is accepted', () => {
  const { db, project, asha, bram, add } = setup();
  add(bram, asha, 'apprentice of');
  const draft = "Asha is Bram's master.";
  assert.equal(guard(db, project.id, 'Is Asha Bram\'s master?', draft), draft);
  db.close();
});

test('the wrong direction is rejected', () => {
  const { db, project, asha, bram, add } = setup();
  add(bram, asha, 'master of');
  const output = guard(db, project.id, 'Is Asha Bram\'s master?', "Asha is Bram's master.");
  assert.match(output, /Tie not established/);
  db.close();
});

test('a keeper for a different kind does not authorise the claim', () => {
  const { db, project, asha, bram, add } = setup();
  add(asha, bram, 'ally of');
  const output = guard(db, project.id, 'Is Asha Bram\'s sister?', "Asha is Bram's sister.");
  assert.match(output, /Tie not established/);
  db.close();
});

test('an answer with no relationship phrase is untouched', () => {
  const { db, project } = setup();
  const draft = 'They met once at the gate.';
  assert.equal(guard(db, project.id, 'Is Asha Bram\'s sister?', draft), draft);
  db.close();
});

test('who-is and punctuation forms parse the same pair', () => {
  const { db, project, asha, bram, add } = setup();
  add(asha, bram, 'sister of');
  const draft = "Asha is Bram's sister.";
  assert.equal(guard(db, project.id, 'Who is Asha to Bram?', draft), draft);
  assert.equal(guard(db, project.id, 'What is Asha to Bram?!', draft), draft);
  db.close();
});
