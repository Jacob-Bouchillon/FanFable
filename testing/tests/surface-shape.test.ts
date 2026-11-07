/**
 * The surface-shape rule is text-shape driven, not vocabulary driven.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { surfaceShape } from '../../fanfable/src/identity/surface-shape.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function source(db: ReturnType<typeof tempDb>['db'], projectId: number): number {
  return Number(db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId, '/synthetic', 'Synthetic Book', 'sha', AT,
  ).lastInsertRowid);
}

function chunk(db: ReturnType<typeof tempDb>['db'], sourceId: number, projectId: number, seq: number, text: string): void {
  db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId, projectId, seq, `Chapter ${seq}`, `Chapter ${seq}`, text, text.split(/\s+/).length,
  );
}

function fixture(): { db: ReturnType<typeof tempDb>['db']; projectId: number } {
  const { db } = tempDb();
  const project = createProject(db, 'synthetic-surface');
  const sourceId = source(db, project.id);
  chunk(db, sourceId, project.id, 1,
    'The shop sign read: "Tawny, Screech, Barn, Brown, and Snowy." A barn owl brought a package.');
  chunk(db, sourceId, project.id, 2,
    'Mira bought an owl and called her Hedwig. Hedwig slept on the perch.');
  chunk(db, sourceId, project.id, 3,
    'Tobin and Wren left together. Tobin carried the map.');
  return { db, projectId: project.id };
}

test('a list member that also occurs lowercase is a kind, not an individual', () => {
  const { db, projectId } = fixture();
  const shape = surfaceShape(db, projectId, 'Barn');
  assert.equal(shape.shape, 'kind-list');
  assert.match(shape.reason, /kind list/);
  db.close();
});

test('a standalone capitalised name is an individual', () => {
  const { db, projectId } = fixture();
  assert.equal(surfaceShape(db, projectId, 'Hedwig').shape, 'individual');
  db.close();
});

test('a two-name conjunction is not a kind list', () => {
  const { db, projectId } = fixture();
  assert.equal(surfaceShape(db, projectId, 'Tobin').shape, 'individual');
  db.close();
});
