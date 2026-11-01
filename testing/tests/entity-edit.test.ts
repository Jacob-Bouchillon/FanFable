/**
 * Entity edits: a partial patch changes only what it names, and deleting an
 * entity leaves a removal ruling for every relation the cascade removes.
 * Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as loreDiag from '../../fanfable/src/answer/lore-diagnostics.ts';
import * as ruling from '../../fanfable/src/court/ruling.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(
  db: Db,
  projectId: number,
  name: string,
  fields: { kind?: string; summary?: string; role?: string; status?: string } = {},
): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, summary, role, status, review_status, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, ?, ?, 'accepted', ?, ?)`,
      projectId,
      fields.kind ?? 'character',
      name,
      fields.summary ?? '',
      fields.role ?? '',
      fields.status ?? '',
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function addChunk(db: Db, projectId: number, text: string): number {
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      '/entity-edit',
      'Edit',
      'sha-entity-edit',
      AT,
    ).lastInsertRowid,
  );
  return Number(
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sourceId,
      projectId,
      1,
      'p. 1',
      '',
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
}

function setup(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  return { db, project };
}

test('a partial entity patch preserves every field it does not name', () => {
  const { db, project } = setup('entity-edit-partial');
  const id = addEntity(db, project.id, 'Old Harbour', {
    kind: 'location',
    summary: 'A working harbour.',
    role: 'trade',
    status: 'active',
  });

  lorebook.updateEntity(db, project.id, id, { name: 'New Harbour' });

  const row = db.get<{ name: string; summary: string; role: string; status: string; kind: string }>(
    'SELECT name, summary, role, status, kind FROM canon_entity WHERE id = ?',
    id,
  )!;
  assert.deepEqual(
    { name: row.name, summary: row.summary, role: row.role, status: row.status, kind: row.kind },
    {
      name: 'New Harbour',
      summary: 'A working harbour.',
      role: 'trade',
      status: 'active',
      kind: 'location',
    },
  );
  db.close();
});

test('an unknown entity kind is normalised instead of stored raw', () => {
  const { db, project } = setup('entity-edit-kind');
  const id = addEntity(db, project.id, 'Old Harbour', { kind: 'location' });

  lorebook.updateEntity(db, project.id, id, { kind: 'Place' as never });

  const row = db.get<{ kind: string }>('SELECT kind FROM canon_entity WHERE id = ?', id)!;
  assert.equal(row.kind, 'location');
  db.close();
});

test('deleting an entity leaves a removal ruling for every cascaded relation', () => {
  const { db, project } = setup('entity-edit-delete');
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  const ash = addEntity(db, project.id, 'Ash');
  const chunk = addChunk(db, project.id, 'Mara is the aunt of Tor. Tor trusts Ash.');
  const doomed = lorebook.insertRelation(db, project.id, {
    fromEntity: mara,
    toEntity: tor,
    kind: 'aunt of',
    evidence: 'Mara is the aunt of Tor.',
    sourceRefs: JSON.stringify([{ source: 'Edit', locator: 'p. 1', chunk }]),
    reviewStatus: 'accepted',
    confidence: 0.9,
  });
  const kept = lorebook.insertRelation(db, project.id, {
    fromEntity: tor,
    toEntity: ash,
    kind: 'trusted',
    evidence: 'Tor trusts Ash.',
    sourceRefs: JSON.stringify([{ source: 'Edit', locator: 'p. 1', chunk }]),
    reviewStatus: 'accepted',
    confidence: 0.9,
  });

  lorebook.deleteEntity(db, project.id, mara);

  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE id = ?', mara)!.n,
    0,
    'the entity is gone',
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE id IN (?, ?)', doomed, kept)!.n,
    1,
    'only the relations that named the entity cascade',
  );
  const removal = ruling
    .listRulings(db, project.id, { subject: ruling.relationSubject(doomed) })
    .find((entry) => entry.role === 'removal');
  assert.ok(removal, 'the cascaded relation has a removal ruling');
  assert.equal(removal!.standard, 'entity-removal');
  assert.equal(removal!.to_status, 'removed');
  assert.equal(removal!.from_status, 'accepted');
  const entityRemoval = ruling
    .listRulings(db, project.id, { subject: ruling.entitySubject(mara) })
    .find((entry) => entry.role === 'removal');
  assert.ok(entityRemoval, 'the entity itself has a removal ruling');
  assert.equal(entityRemoval!.standard, 'entity-removal');
  assert.equal(entityRemoval!.relation_id, null, 'an entity ruling names no relation');
  assert.equal(entityRemoval!.to_status, 'removed');
  assert.equal(entityRemoval!.from_status, 'accepted');
  db.close();
});

test('entity edits and deletes stay inside their project', () => {
  const { db } = tempDb();
  const a = createProject(db, 'entity-scope-a');
  const b = createProject(db, 'entity-scope-b');
  const other = addEntity(db, b.id, 'Other Harbour', {
    kind: 'location',
    summary: 'A harbour in the other project.',
    role: 'trade',
    status: 'active',
  });

  // The id is real, but it belongs to another project: neither the update nor
  // the delete may reach across the boundary.
  lorebook.updateEntity(db, a.id, other, { name: 'Hijacked', kind: 'item' as never, summary: 'changed' });
  const untouched = db.get<{ name: string; kind: string; summary: string }>(
    'SELECT name, kind, summary FROM canon_entity WHERE id = ?',
    other,
  )!;
  assert.deepEqual(
    { name: untouched.name, kind: untouched.kind, summary: untouched.summary },
    { name: 'Other Harbour', kind: 'location', summary: 'A harbour in the other project.' },
  );

  lorebook.deleteEntity(db, a.id, other);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE id = ?', other)!.n,
    1,
    'the other project keeps its entity',
  );
  assert.equal(
    ruling.listRulings(db, a.id, { subject: ruling.entitySubject(other) }).length,
    0,
    'no ruling is written into the wrong project',
  );
  db.close();
});

test('relation corrections and removals stay inside their project', () => {
  const { db } = tempDb();
  const a = createProject(db, 'relation-scope-a');
  const b = createProject(db, 'relation-scope-b');
  const mara = addEntity(db, b.id, 'Mara');
  const tor = addEntity(db, b.id, 'Tor');
  const relation = Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at)
       VALUES (?, ?, ?, 'aunt of', 'Mara is the aunt of Tor.', '[]', 'accepted', ?)`,
      b.id,
      mara,
      tor,
      AT,
    ).lastInsertRowid,
  );

  assert.equal(loreDiag.correctRelation(db, a.id, relation, { kind: 'enemy of', confirm: true }), false);
  assert.equal(
    db.get<{ kind: string }>('SELECT kind FROM canon_relation WHERE id = ?', relation)!.kind,
    'aunt of',
    'the other project keeps its relation kind',
  );

  assert.equal(loreDiag.removeRelation(db, a.id, relation), false);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE id = ?', relation)!.n,
    1,
    'the other project keeps its relation',
  );
  db.close();
});
