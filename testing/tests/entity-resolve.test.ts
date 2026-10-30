/**
 * Name resolution: exact, alias, containment, ambiguous, absent.
 * Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/controller.ts';
import { resolveEntity, resolvePair } from '../../fanfable/src/identity.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(db: Db, projectId: number, name: string, aliases: string[] = []): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, ?, '', '', 1, '', '[]', 'accepted', ?, ?)`,
      projectId,
      name,
      JSON.stringify(aliases),
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function addChunk(db: Db, projectId: number): void {
  const source = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      '/resolve-probe',
      'Probe',
      'sha-resolve',
      AT,
    ).lastInsertRowid,
  );
  db.run(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
     VALUES (?, ?, 1, 'p. 1', '', 'The order kept its own counsel.', 6)`,
    source,
    projectId,
  );
}

function setup(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  addChunk(db, project.id);
  return { db, project: project.id };
}

test('an exact stored name resolves as exact', () => {
  const { db, project } = setup('resolve-exact');
  const id = addEntity(db, project, 'Mara Voss');
  const result = resolveEntity(db, project, 'Mara Voss');
  assert.equal(result.status, 'resolved');
  assert.equal(result.id, id);
  assert.equal(result.how, 'exact');
  db.close();
});

test('an alias resolves as alias', () => {
  const { db, project } = setup('resolve-alias');
  const id = addEntity(db, project, 'Mara Voss', ['Captain Voss']);
  const result = resolveEntity(db, project, 'Captain Voss');
  assert.equal(result.status, 'resolved');
  assert.equal(result.id, id);
  assert.equal(result.how, 'alias');
  db.close();
});

test('a contained short form resolves by containment', () => {
  const { db, project } = setup('resolve-containment');
  const id = addEntity(db, project, 'Outer Province Senator Rennick Vale');
  const result = resolveEntity(db, project, 'Rennick Vale');
  assert.equal(result.status, 'resolved');
  assert.equal(result.id, id);
  assert.equal(result.how, 'containment');
  db.close();
});

test('two candidates are ambiguous and never guessed', () => {
  const { db, project } = setup('resolve-ambiguous');
  const first = addEntity(db, project, 'Senator Vidar Kest');
  const second = addEntity(db, project, 'Ronhar Kest');
  const result = resolveEntity(db, project, 'Kest');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.id, null);
  assert.deepEqual(result.candidates.map((c) => c.id), [first, second].sort((a, b) => a - b));
  db.close();
});

test('an unknown name is absent, not a best guess', () => {
  const { db, project } = setup('resolve-absent');
  addEntity(db, project, 'Mara Voss');
  const result = resolveEntity(db, project, 'Nobody Here');
  assert.equal(result.status, 'absent');
  assert.equal(result.id, null);
  assert.deepEqual(result.candidates, []);
  db.close();
});

test('a bare title resolves to nobody', () => {
  const { db, project } = setup('resolve-title');
  addEntity(db, project, 'Captain Voss');
  const result = resolveEntity(db, project, 'Captain');
  assert.equal(result.status, 'absent');
  db.close();
});

test('resolvePair refuses a pair with an ambiguous side', () => {
  const { db, project } = setup('resolve-pair-ambiguous');
  addEntity(db, project, 'Senator Vidar Kest');
  addEntity(db, project, 'Ronhar Kest');
  addEntity(db, project, 'Pax Renner');
  const result = resolvePair(db, project, 'Kest', 'Pax Renner');
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.a.status, 'ambiguous');
  assert.equal(result.b.status, 'resolved');
  db.close();
});

test('resolvePair reports absent when either side is unknown', () => {
  const { db, project } = setup('resolve-pair-absent');
  addEntity(db, project, 'Pax Renner');
  const result = resolvePair(db, project, 'Pax Renner', 'Nobody Here');
  assert.equal(result.status, 'absent');
  db.close();
});

test('resolvePair resolves when both sides resolve', () => {
  const { db, project } = setup('resolve-pair-ok');
  const a = addEntity(db, project, 'Mara Voss');
  const b = addEntity(db, project, 'Corin Hale');
  const result = resolvePair(db, project, 'Mara Voss', 'Corin Hale');
  assert.equal(result.status, 'resolved');
  assert.equal(result.a.id, a);
  assert.equal(result.b.id, b);
  db.close();
});

test('resolution is deterministic across calls', () => {
  const { db, project } = setup('resolve-deterministic');
  addEntity(db, project, 'Senator Vidar Kest');
  addEntity(db, project, 'Ronhar Kest');
  assert.deepEqual(resolveEntity(db, project, 'Kest'), resolveEntity(db, project, 'Kest'));
  db.close();
});
