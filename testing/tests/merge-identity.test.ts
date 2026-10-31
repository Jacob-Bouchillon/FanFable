import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedProject } from './helpers.ts';
import { checkEntities } from '../../fanfable/src/answer/rule-checker.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';

function addEntity(db: any, projectId: number, name: string, summary: string, evidence: string, role = ''): number {
  const now = new Date().toISOString();
  return db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, summary, role, evidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    projectId, 'character', name, '[]', summary, role, evidence, now, now,
  ).lastInsertRowid;
}

function statusOf(db: any, id: number): string {
  return (db.get('SELECT review_status FROM canon_entity WHERE id = ?', id) as { review_status: string }).review_status;
}

test('summary claiming another entity without a both-endpoints quote is flagged and quarantined', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'identity-flag');
  const a = addEntity(db, project.id, 'Alpha', 'A senator.', 'Alpha spoke.');
  addEntity(db, project.id, 'Beta Prime', 'A rival.', 'Beta Prime listened.');
  // Rewrite Alpha's summary to claim Beta Prime, evidence naming Alpha only.
  db.run('UPDATE canon_entity SET summary = ? WHERE id = ?', 'The senator Alpha, also known as Beta Prime.', a);
  const hits = checkEntities(db, project.id);
  assert.equal(hits.length, 1, 'one identity hit');
  assert.equal(hits[0]!.rule, 'summary-identity-unproven');
  assert.equal(statusOf(db, a), 'needs_review', 'flagged row parked');
  const q = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM quarantine_alias WHERE project_id = ? AND status = 'pending'", project.id,
  )!.n;
  assert.equal(q, 1, 'quarantine candidate recorded for a human');
  db.close();
});

test('identity claim proven by a both-endpoints quote stays accepted', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'identity-proven');
  addEntity(db, project.id, 'Gamma', 'A pilot.', 'Gamma flew.');
  const b = addEntity(
    db, project.id, 'Delta Ray', 'Delta Ray, also known as Gamma.',
    'Delta Ray stood beside Gamma and waved.',
  );
  const hits = checkEntities(db, project.id);
  assert.equal(hits.length, 0, 'proven claim is not flagged');
  assert.equal(statusOf(db, b), 'accepted');
  db.close();
});

test('self-alias restatement is not a claim about another row', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'identity-self');
  db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, summary, role, evidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    project.id, 'character', 'Epsilon', '["Eppy"]', 'Epsilon, also known as Eppy, smiled.', '', 'Epsilon smiled.', '2026-01-01', '2026-01-01',
  );
  const hits = checkEntities(db, project.id);
  assert.equal(hits.length, 0, 'own alias is not an identity claim');
  db.close();
});

test('flagged entities leave the answer index; clean ones stay', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'identity-index');
  addEntity(db, project.id, 'Zeta', 'A senator.', 'Zeta spoke.');
  const f = addEntity(db, project.id, 'Eta', 'Eta, also known as Zeta.', 'Eta nodded.');
  checkEntities(db, project.id);
  assert.equal(statusOf(db, f), 'needs_review');
  const found = lorebook.searchLore(db, project.id, 'zeta eta senator', 10);
  const names = found.entities.map((e) => e.name);
  assert.ok(names.includes('Zeta'), 'clean row still answers');
  assert.ok(!names.includes('Eta'), 'flagged row invisible to answers');
  db.close();
});

test('bare copula identity without role noun is flagged', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'identity-copula');
  addEntity(db, project.id, 'Kappa', 'A senator.', 'Kappa spoke.');
  const k = addEntity(db, project.id, 'Lambda', 'Lambda is Kappa.', 'Lambda smiled.');
  const hits = checkEntities(db, project.id);
  assert.equal(hits.length, 1, 'bare "is <name>" flagged');
  assert.equal(statusOf(db, k), 'needs_review');
  db.close();
});

test('copula with a role noun is relation phrasing, not identity', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'identity-relation-wording');
  addEntity(db, project.id, 'Mu', 'A lord.', 'Mu ruled.');
  const n = addEntity(db, project.id, 'Nu', 'Nu is Mu apprentice.', 'Nu trained.');
  const hits = checkEntities(db, project.id);
  assert.equal(hits.length, 0, 'name-plus-role is not an identity claim');
  assert.equal(statusOf(db, n), 'accepted');
  db.close();
});
test('parenthetical alias matching another entity is flagged', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'identity-paren');
  addEntity(db, project.id, 'Theta', 'A lord.', 'Theta ruled.');
  const p = addEntity(db, project.id, 'Iota', 'Iota (Theta) arrived.', 'Iota arrived.');
  const hits = checkEntities(db, project.id);
  assert.equal(hits.length, 1, 'parenthetical identity claim flagged');
  assert.equal(statusOf(db, p), 'needs_review');
  db.close();
});
