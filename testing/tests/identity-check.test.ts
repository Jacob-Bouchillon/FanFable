/**
 * Identity collision pass: flag, never merge.
 * Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/controller.ts';
import { flagIdentityCollisions } from '../../fanfable/src/identity-check.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(
  db: Db,
  projectId: number,
  name: string,
  kind = 'character',
  opts: { aliases?: string[]; reviewStatus?: string } = {},
): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', '', 1, '', '[]', ?, ?, ?)`,
      projectId,
      kind,
      name,
      JSON.stringify(opts.aliases ?? []),
      opts.reviewStatus ?? 'accepted',
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function setup(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  return { db, project: project.id };
}

test('a cross-kind collision flags every involved entity', () => {
  const { db, project } = setup('identity-cross');
  const person = addEntity(db, project, "Shi'ido", 'character');
  const species = addEntity(db, project, 'Shi\u2019ido', 'species');
  const result = flagIdentityCollisions(db, project, { write: true });
  assert.equal(result.collisions.length, 1);
  assert.equal(result.collisions[0]!.edge, 'same-form');
  assert.equal(result.flagged, 2);

  for (const id of [person, species]) {
    const row = db.get<{ review_status: string; quarantine_reason: string; kind: string }>(
      'SELECT review_status, quarantine_reason, kind FROM canon_entity WHERE id = ?',
      id,
    )!;
    assert.equal(row.review_status, 'needs_review');
    assert.match(row.quarantine_reason, /^identity-collision: /);
  }
  assert.equal(
    db.get<{ kind: string }>('SELECT kind FROM canon_entity WHERE id = ?', species)!.kind,
    'species',
    'the kind is never changed',
  );
  db.close();
});

test('a same-kind collision is flagged too', () => {
  const { db, project } = setup('identity-same');
  addEntity(db, project, 'Mara Voss');
  addEntity(db, project, 'Mara  Voss');
  const result = flagIdentityCollisions(db, project, { write: true });
  assert.equal(result.collisions.length, 1);
  assert.equal(result.collisions[0]!.edge, 'same-form');
  assert.equal(result.flagged, 2);
  db.close();
});

test('a single entity is never flagged', () => {
  const { db, project } = setup('identity-single');
  const id = addEntity(db, project, 'Mara Voss');
  const result = flagIdentityCollisions(db, project, { write: true });
  assert.equal(result.collisions.length, 0);
  assert.equal(result.flagged, 0);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', id)!.review_status,
    'accepted',
  );
  db.close();
});

test('alias collisions count, and the pass is idempotent', () => {
  const { db, project } = setup('identity-alias');
  addEntity(db, project, 'Mara Voss', 'character', { aliases: ['Captain Voss'] });
  addEntity(db, project, 'Captain Voss', 'character');
  const first = flagIdentityCollisions(db, project, { write: true });
  assert.equal(first.collisions.length, 1);

  const second = flagIdentityCollisions(db, project, { write: true });
  assert.equal(second.flagged, 0, 'a rerun flags nothing new');
  assert.equal(second.alreadyFlagged, 2);
  db.close();
});

test('quarantined rows are left alone', () => {
  const { db, project } = setup('identity-quarantine');
  const quarantined = addEntity(db, project, 'Kubaz', 'character', { reviewStatus: 'quarantined' });
  addEntity(db, project, 'Kubaz', 'species');
  const result = flagIdentityCollisions(db, project, { write: true });
  assert.equal(result.quarantinedSkipped, 1);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', quarantined)!
      .review_status,
    'quarantined',
  );
  db.close();
});

test('nothing is merged, renamed or re-kinded, and relations are untouched', () => {
  const { db, project } = setup('identity-safe');
  const a = addEntity(db, project, 'Bothans', 'character');
  const b = addEntity(db, project, 'Bothans', 'species');
  db.run(
    `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, confidence, review_status, created_at)
     VALUES (?, ?, ?, 'ally of', 'they stood together', '[]', 1.0, 'accepted', ?)`,
    project,
    a,
    b,
    AT,
  );
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project)!.n;
  flagIdentityCollisions(db, project, { write: true });

  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', project)!.n, 2);
  const names = db.all<{ name: string }>('SELECT name FROM canon_entity WHERE project_id = ? ORDER BY id', project);
  assert.deepEqual(
    names.map((n) => n.name),
    ['Bothans', 'Bothans'],
  );
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project)!.n, before);
  db.close();
});

test('a dry run reports without writing', () => {
  const { db, project } = setup('identity-dry');
  addEntity(db, project, 'Kubaz', 'character');
  addEntity(db, project, 'Kubaz', 'species');
  const result = flagIdentityCollisions(db, project);
  assert.equal(result.flagged, 2);
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND review_status = 'needs_review'", project)!.n,
    0,
  );
  db.close();
});
