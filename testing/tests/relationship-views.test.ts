/**
 * The relationship views: one line per pair, and the review queue of pairs the
 * guard refused. Both are read-only groupings over rows that already exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedProject, tempDb } from './helpers.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';

const now = new Date().toISOString();

function entity(db: ReturnType<typeof tempDb>['db'], projectId: number, name: string): number {
  const r = db.run(
    `INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at)
     VALUES (?, 'character', ?, '[]', ?, ?)`,
    projectId,
    name,
    now,
    now,
  );
  return Number(r.lastInsertRowid);
}

function relation(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  from: number,
  to: number,
  kind: string,
  status: string,
  confirmed = 0,
): void {
  db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, review_status, confirmed_by_user, source_refs, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[{"locator":"PAGE 1"}]', ?)`,
    projectId,
    from,
    to,
    kind,
    status,
    confirmed,
    now,
  );
}

function note(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  from: number,
  to: number,
  kind: string,
  reason: string,
): void {
  db.run(
    `INSERT INTO canon_tie_note
       (project_id, from_entity, to_entity, attempted_kind, reason, status, source_refs, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', '[{"locator":"PAGE 2"}]', ?)`,
    projectId,
    from,
    to,
    kind,
    reason,
    now,
  );
}

test('relationship pairs collapse to one row each, strongest status first', () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const a = entity(db, project.id, 'Alder');
  const b = entity(db, project.id, 'Briony');
  const c = entity(db, project.id, 'Cyrus');
  const d = entity(db, project.id, 'Dara');

  relation(db, project.id, a, b, 'brother of', 'provisional');
  relation(db, project.id, b, a, 'sibling of', 'accepted');
  relation(db, project.id, c, d, 'friend of', 'user_confirmed', 1);

  const pairs = lorebook.listRelationshipPairs(db, project.id);
  assert.equal(pairs.length, 2, 'inverse rows are one pair');
  assert.equal(pairs[0]!.status, 'user_confirmed', 'confirmed sorts first');
  assert.equal(pairs[0]!.fromName, 'Cyrus');
  const alder = pairs.find((p) => p.fromName === 'Alder' || p.fromName === 'Briony')!;
  assert.equal(alder.status, 'accepted', 'accepted outranks provisional');
  assert.equal(alder.rows, 2);
});

test('proposals list pending notes but skip pairs that hold a keeper', () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const a = entity(db, project.id, 'Alder');
  const b = entity(db, project.id, 'Briony');
  const c = entity(db, project.id, 'Cyrus');
  const d = entity(db, project.id, 'Dara');

  note(db, project.id, a, b, 'friend of', 'unsupported');
  note(db, project.id, c, d, 'enemy of', 'unsupported');
  relation(db, project.id, c, d, 'enemy of', 'user_confirmed', 1);

  const proposals = lorebook.listTieProposals(db, project.id);
  assert.equal(proposals.length, 1, 'the pair already in the bank is excluded');
  assert.equal(proposals[0]!.fromName, 'Alder');
  assert.equal(proposals[0]!.reason, 'unsupported');
  assert.equal(proposals[0]!.locator, 'PAGE 2');
});
