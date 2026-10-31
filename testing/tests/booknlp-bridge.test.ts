/**
 * Cluster-name mapping bridge: reader clusters to roster persons.
 * Invented names only; no model, no bank content, no book text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { mapClusters, mappingCoverage } from '../../fanfable/src/identity/booknlp-bridge.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(
  db: Db,
  projectId: number,
  name: string,
  opts: { kind?: string; aliases?: string[] } = {},
): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', '', 1, '', '[]', 'accepted', ?, ?)`,
      projectId,
      opts.kind ?? 'character',
      name,
      JSON.stringify(opts.aliases ?? []),
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function setup(): { db: Db; project: number; mara: number; corin: number } {
  const { db } = tempDb();
  const project = createProject(db, 'bridge-fixture');
  const mara = addEntity(db, project.id, 'Mara Voss', { aliases: ['Captain Voss'] });
  const corin = addEntity(db, project.id, 'Corin Hale');
  addEntity(db, project.id, 'The Gatehouse', { kind: 'location' });
  return { db, project: project.id, mara, corin };
}

test('exact names resolve at the exact tier', () => {
  const { db, project, mara } = setup();
  const [mapping] = mapClusters(db, project, [{ key: 'c1', names: ['Mara Voss'] }]);
  assert.equal(mapping!.status, 'resolved');
  assert.equal(mapping!.entityId, mara);
  assert.equal(mapping!.how, 'exact');
  db.close();
});

test('stored aliases resolve at the alias tier', () => {
  const { db, project, mara } = setup();
  const [mapping] = mapClusters(db, project, [{ key: 'c1', names: ['Captain Voss'] }]);
  assert.equal(mapping!.status, 'resolved');
  assert.equal(mapping!.entityId, mara);
  assert.equal(mapping!.how, 'alias');
  db.close();
});

test('a usable short form resolves at the containment tier', () => {
  const { db, project, corin } = setup();
  const [mapping] = mapClusters(db, project, [{ key: 'c1', names: ['Hale'] }]);
  assert.equal(mapping!.status, 'resolved');
  assert.equal(mapping!.entityId, corin);
  assert.equal(mapping!.how, 'containment');
  db.close();
});

test('a cluster naming two roster persons is reported merged, never merged', () => {
  const { db, project } = setup();
  const [mapping] = mapClusters(db, project, [{ key: 'c1', names: ['Mara Voss', 'Corin Hale'] }]);
  assert.equal(mapping!.status, 'merged');
  assert.equal(mapping!.entityId, null);
  db.close();
});

test('half-resolved clusters stay ambiguous, unknown names stay absent', () => {
  const { db, project, mara } = setup();
  const [mixed] = mapClusters(db, project, [{ key: 'c1', names: ['Mara Voss', 'Nobody Here'] }]);
  assert.equal(mixed!.status, 'ambiguous');
  assert.equal(mixed!.entityId, null);
  const [missing] = mapClusters(db, project, [{ key: 'c2', names: ['Nobody Here'] }]);
  assert.equal(missing!.status, 'absent');
  assert.equal(mara > 0, true);
  db.close();
});

test('a shared alias is ambiguous, and places never answer as people', () => {
  const { db, project } = setup();
  addEntity(db, project, 'Mara Venn', { aliases: ['Captain Voss'] });
  const [shared] = mapClusters(db, project, [{ key: 'c1', names: ['Captain Voss'] }]);
  assert.equal(shared!.status, 'ambiguous');
  const [place] = mapClusters(db, project, [{ key: 'c2', names: ['The Gatehouse'] }]);
  assert.equal(place!.status, 'absent');
  db.close();
});

test('coverage counts every verdict once', () => {
  const { db, project } = setup();
  const mappings = mapClusters(db, project, [
    { key: 'c1', names: ['Mara Voss'] },
    { key: 'c2', names: ['Captain Voss'] },
    { key: 'c3', names: ['Hale'] },
    { key: 'c4', names: ['Mara Voss', 'Corin Hale'] },
    { key: 'c5', names: ['Nobody Here'] },
  ]);
  assert.deepEqual(mappingCoverage(mappings), {
    clusters: 5,
    resolved: 3,
    byHow: { exact: 1, alias: 1, containment: 1 },
    ambiguous: 0,
    absent: 1,
    merged: 1,
    coverage: 0.6,
  });
  db.close();
});
