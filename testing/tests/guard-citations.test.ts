/** Citation verification and relationship verification are separate checks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import { enforceStatusTieGuard } from '../../fanfable/src/answer/lore-ask.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const VERSE = "Asha is Bram's sister, and the hall has always known it.";

function setup() {
  const { db } = tempDb();
  const project = controller.createProject(db, `guard-cite-${Math.random().toString(36).slice(2, 7)}`);
  const mk = (name: string) => db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id, 'character', name, '[]', AT, AT,
  ).lastInsertRowid;
  const asha = mk('Asha');
  const bram = mk('Bram');
  const add = (kind: string): void => {
    db.run(
      "INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at) VALUES (?, ?, ?, ?, 'q', '[]', 'accepted', ?)",
      project.id, asha, bram, kind, AT,
    );
  };
  return { db, project, add, asha, bram };
}

function passage(text: string) {
  return [{ chunkId: 1, sourceId: 1, sourceTitle: 'Probe', path: '/probe', locator: 'p. 1', heading: '', text, score: 1 }];
}

function guard(db: ReturnType<typeof tempDb>['db'], projectId: number, draft: string, text = VERSE): string {
  return enforceStatusTieGuard(db, projectId, 'How are Asha and Bram related?', draft, passage(text));
}

test('keeper plus a verbatim quote passes', () => {
  const { db, project, add } = setup();
  add('sister of');
  const draft = `Asha is Bram's sister. She said, "${VERSE}"`;
  assert.equal(guard(db, project.id, draft), draft);
  db.close();
});

test('keeper plus an invented quote fails on the citation', () => {
  const { db, project, add } = setup();
  add('sister of');
  const output = guard(db, project.id, '"A sentence that is not in the passage at all."');
  assert.match(output, /quote-not-in-passage/);
  db.close();
});

test('an unmapped open relationship with no keeper fails', () => {
  const { db, project } = setup();
  const output = guard(db, project.id, 'Asha was Bram\'s bodyguard.');
  assert.match(output, /unmapped-relationship/);
  db.close();
});

test('a mapped open relationship with no keeper fails as unsupported', () => {
  const { db, project } = setup();
  const output = guard(db, project.id, 'Asha and Bram had a partnership.');
  assert.match(output, /unsupported-relationship/);
  db.close();
});

test('an open relationship with a mapped keeper passes', () => {
  const { db, project, add } = setup();
  add('partner with');
  const draft = 'Asha and Bram had a partnership.';
  assert.equal(guard(db, project.id, draft), draft);
  db.close();
});

test('a valid quote alone does not authorise a relationship claim', () => {
  const { db, project } = setup();
  const draft = `"${VERSE}"`;
  const output = guard(db, project.id, draft);
  assert.match(output, /Tie not established/);
  assert.match(output, /unsupported-relationship/);
  db.close();
});

test('a spliced quote fails', () => {
  const { db, project, add } = setup();
  add('sister of');
  const draft = '"Asha is Bram\'s sister. They left at dawn."';
  const output = guard(db, project.id, draft, "Asha is Bram's sister. The hall was cold. They left at dawn.");
  assert.match(output, /quote-not-in-passage/);
  db.close();
});

test('harmless quotes, dashes, case and whitespace pass', () => {
  const { db, project, add } = setup();
  add('sister of');
  const draft = '“ASHA is Bram’s   sister, and the hall has always known it.”';
  assert.equal(guard(db, project.id, draft, "Asha is Bram's sister, and the hall has always known it."), draft);
  db.close();
});
