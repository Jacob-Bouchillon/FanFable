/**
 * Starved windows share extraction's chunk order.
 *
 * Extraction windows are `source_id, seq`; starved scoring used `seq, id`.
 * With overlapping per-source seqs those orders differ, so a reserved index
 * used to point at the wrong window. Synthetic databases only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { starvedWindowScores } from '../../fanfable/src/web/note-ingest.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function source(db: ReturnType<typeof tempDb>['db'], projectId: number, path: string): number {
  return Number(db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId, path, path, `sha-${path}`, AT,
  ).lastInsertRowid);
}

function chunk(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  sourceId: number,
  seq: number,
  text: string,
): number {
  return Number(db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId, projectId, seq, `p. ${seq}`, '', text, text.split(/\s+/).length,
  ).lastInsertRowid);
}

function entity(db: ReturnType<typeof tempDb>['db'], projectId: number, name: string): number {
  return Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    projectId, 'character', name, '[]', 'accepted', AT, AT,
  ).lastInsertRowid);
}

test('starved windows follow source_id,seq and reserve the thread’s real window', () => {
  const { db } = tempDb();
  const project = createProject(db, 'starved-multisource');
  const sourceA = source(db, project.id, 'source-a.txt');
  const sourceB = source(db, project.id, 'source-b.txt');
  const a1 = chunk(db, project.id, sourceA, 1, 'A one.');
  const a2 = chunk(db, project.id, sourceA, 2, 'A two.');
  const a3 = chunk(db, project.id, sourceA, 3, 'A three.');
  const b1 = chunk(db, project.id, sourceB, 1, 'B one.');
  const b2 = chunk(db, project.id, sourceB, 2, 'B two.');
  const b3 = chunk(db, project.id, sourceB, 3, 'B three.');

  const thread = Number(db.run(
    'INSERT INTO canon_thread (project_id, kind, a_entity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    project.id, 'person', entity(db, project.id, 'Asha'), AT, AT,
  ).lastInsertRowid);
  db.run(
    'INSERT INTO canon_thread_passage (thread_id, chunk_id, seq, first_seen_at) VALUES (?, ?, ?, ?)',
    thread, b2, 2, AT,
  );

  const windowSize = 2;
  const scored = starvedWindowScores(db, project.id, { windowSize });
  assert.equal(scored.windows.length, 1);
  assert.equal(scored.threadsCovered, 1);
  // New order: [A1,A2] [A3,B1] [B2,B3] -> B2 is in window 2.
  assert.equal(scored.windows[0]!.index, 2, 'the thread window is the third source-ordered window');

  const newOrder = lorebook.loadOrderedChunks(db, project.id).map((row) => row.id);
  assert.deepEqual(newOrder, [a1, a2, a3, b1, b2, b3], 'the shared helper orders by source then seq');

  const oldOrder = db
    .all<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY seq, id', project.id)
    .map((row) => row.id);
  const oldIndex = Math.floor(oldOrder.indexOf(b2) / windowSize);
  assert.equal(oldIndex, 1, 'the old seq,id order put the same thread in window 1');
  assert.notEqual(oldIndex, scored.windows[0]!.index, 'the two orders disagree');

  const candidateByFirstChunk = new Map<number, number>();
  for (let index = 0; index * windowSize < newOrder.length; index++) {
    candidateByFirstChunk.set(newOrder[index * windowSize]!, index);
  }
  const reserved = lorebook.starvedCandidateIndices(
    candidateByFirstChunk,
    newOrder.map((id) => ({ id })),
    scored.windows,
    1,
    windowSize,
  );
  assert.deepEqual(reserved, [2], 'the reserved candidate is the source-ordered window');
  db.close();
});

test('a single source keeps the previous window mapping', () => {
  const { db } = tempDb();
  const project = createProject(db, 'starved-single-source');
  const only = source(db, project.id, 'only.txt');
  const chunks = [1, 2, 3, 4].map((seq) => chunk(db, project.id, only, seq, `Passage ${seq}.`));
  const thread = Number(db.run(
    'INSERT INTO canon_thread (project_id, kind, a_entity, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    project.id, 'person', entity(db, project.id, 'Bram'), AT, AT,
  ).lastInsertRowid);
  db.run(
    'INSERT INTO canon_thread_passage (thread_id, chunk_id, seq, first_seen_at) VALUES (?, ?, ?, ?)',
    thread, chunks[3], 4, AT,
  );
  const scored = starvedWindowScores(db, project.id, { windowSize: 2 });
  assert.deepEqual(scored.windows, [{ index: 1, score: 1 }]);
  db.close();
});
