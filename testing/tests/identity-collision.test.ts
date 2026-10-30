/**
 * Collision detection by relationship, not string equality.
 * Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/controller.ts';
import { flagIdentityCollisions } from '../../fanfable/src/identity-check.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(db: Db, projectId: number, name: string, opts: { aliases?: string[]; kind?: string; reviewStatus?: string } = {}): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', '', 1, '', '[]', ?, ?, ?)`,
      projectId,
      opts.kind ?? 'character',
      name,
      JSON.stringify(opts.aliases ?? []),
      opts.reviewStatus ?? 'accepted',
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function addChunk(db: Db, projectId: number, seq: number, text: string): void {
  const source = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      `/probe-${seq}`,
      'Probe',
      `sha-${seq}`,
      AT,
    ).lastInsertRowid,
  );
  db.run(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
     VALUES (?, ?, ?, ?, '', ?, ?)`,
    source,
    projectId,
    seq,
    `p. ${seq}`,
    text,
    text.split(/\s+/).length,
  );
}

function setup(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  addChunk(db, project.id, 1, 'The order kept its own counsel through the winter.');
  return { db, project: project.id };
}

test('a short form and its longer name are one group', () => {
  const { db, project } = setup('collide-containment');
  const short = addEntity(db, project, 'Voss');
  const long = addEntity(db, project, 'Captain Voss');
  const result = flagIdentityCollisions(db, project, { write: true });
  assert.equal(result.collisions.length, 1);
  assert.equal(result.collisions[0]!.edge, 'containment');
  assert.equal(result.containmentEdges, 1);
  for (const id of [short, long]) {
    const row = db.get<{ review_status: string; quarantine_reason: string }>(
      'SELECT review_status, quarantine_reason FROM canon_entity WHERE id = ?',
      id,
    )!;
    assert.equal(row.review_status, 'needs_review');
    assert.match(row.quarantine_reason, /^identity-collision: /);
  }
  db.close();
});

test('an identical form is still a same-form group', () => {
  const { db, project } = setup('collide-same');
  addEntity(db, project, 'Mara Voss');
  addEntity(db, project, 'Mara  Voss');
  const result = flagIdentityCollisions(db, project, { write: true });
  assert.equal(result.sameFormEdges, 1);
  assert.equal(result.collisions[0]!.edge, 'same-form');
  assert.equal(result.flagged, 2);
  db.close();
});

test('a bare title does not group the roster', () => {
  const { db, project } = setup('collide-title');
  addEntity(db, project, 'Captain');
  for (let i = 0; i < 4; i++) addEntity(db, project, `Captain Holder${i}`);
  const result = flagIdentityCollisions(db, project, { write: true });
  assert.equal(result.collisions.length, 0, 'a title identifies nobody');
  assert.equal(result.flagged, 0);
  db.close();
});

test('a token carried by most of the roster does not group it', () => {
  const { db, project } = setup('collide-highfreq');
  addEntity(db, project, 'Voss');
  for (let i = 0; i < 11; i++) addEntity(db, project, `Keeper${i} Voss`);
  const result = flagIdentityCollisions(db, project, { write: true });
  assert.equal(result.collisions.length, 0, 'a shared surname is not one identity');
  assert.equal(result.flagged, 0);
  db.close();
});

test('the group cap stops a generic short form flagging the roster', () => {
  const { db, project } = setup('collide-cap');
  addEntity(db, project, 'Holt');
  for (let i = 0; i < 9; i++) addEntity(db, project, `Elder${i} Holt`);
  const result = flagIdentityCollisions(db, project, { write: true });
  assert.equal(result.collisions.length, 0);
  assert.ok(result.skippedByGroupCap >= 1, 'the generic pairs are reported as skipped');
  db.close();
});

test('a second write flags nothing new', () => {
  const { db, project } = setup('collide-idempotent');
  addEntity(db, project, 'Voss');
  addEntity(db, project, 'Captain Voss');
  const first = flagIdentityCollisions(db, project, { write: true });
  assert.equal(first.flagged, 2);
  const second = flagIdentityCollisions(db, project, { write: true });
  assert.equal(second.flagged, 0);
  assert.equal(second.alreadyFlagged, 2);
  db.close();
});

test('quarantined rows are left alone and aliases join a group', () => {
  const { db, project } = setup('collide-alias');
  const quarantined = addEntity(db, project, 'Voss', { reviewStatus: 'quarantined' });
  addEntity(db, project, 'Mara Voss', { aliases: ['Captain Voss'] });
  const result = flagIdentityCollisions(db, project, { write: true });
  assert.equal(result.collisions.length, 1);
  assert.equal(result.quarantinedSkipped, 1);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_entity WHERE id = ?', quarantined)!.review_status,
    'quarantined',
  );
  db.close();
});

test('nothing is merged, renamed or re-kinded', () => {
  const { db, project } = setup('collide-safe');
  addEntity(db, project, 'Voss', { kind: 'character' });
  addEntity(db, project, 'Captain Voss', { kind: 'character' });
  flagIdentityCollisions(db, project, { write: true });
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', project)!.n, 2);
  const names = db.all<{ name: string }>('SELECT name FROM canon_entity WHERE project_id = ? ORDER BY id', project);
  assert.deepEqual(names.map((row) => row.name), ['Voss', 'Captain Voss']);
  db.close();
});
