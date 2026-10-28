/**
 * Read-time relationship status: append-only rows in, current-vs-history out.
 *
 * Fixture/SQL only — no Ollama:
 *
 *   - a three-stage arc orders by story and names the latest asserted row current
 *   - an atSeq query stops the line (unplaceable rows excluded)
 *   - a later denial never becomes status
 *   - both directions of a pair are read together
 *   - an empty pair returns nothing rather than guessing
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../fanfable/src/db.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { seedProject, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function pairProject(dbName: string): { db: Db; projectId: number; chunks: { id: number; seq: number; locator: string }[]; ids: Map<string, number> } {
  const { db } = tempDb();
  const project = seedProject(db, dbName);
  const chunks = db.all<{ id: number; seq: number; locator: string }>(
    'SELECT id, seq, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 3',
    project.id,
  );
  assert.ok(chunks.length >= 3, 'the fixture carries at least three passages');
  const ids = new Map<string, number>();
  for (const name of ['Astra Vale', 'Bram Vale']) {
    ids.set(
      name,
      db.run(
        'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        project.id, 'character', name, `${name} appears here.`, '[]', AT, AT,
      ).lastInsertRowid,
    );
  }
  return { db, projectId: project.id, chunks, ids };
}

function tie(
  db: Db, projectId: number, ids: Map<string, number>, chunks: { id: number; seq: number }[],
  from: string, to: string, kind: string, chunkIdx: number, modality = 'asserted',
): void {
  db.run(
    'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    projectId, ids.get(from)!, ids.get(to)!, kind, `${from} ${kind} ${to}.`,
    `"${kind}"`, JSON.stringify([{ source: 's', locator: 'p.1', chunk: chunks[chunkIdx]!.id }]),
    modality, AT,
  );
}

test('a three-stage arc names the latest asserted row current, in story order', () => {
  const { db, projectId, chunks, ids } = pairProject('status-arc');
  tie(db, projectId, ids, chunks, 'Astra Vale', 'Bram Vale', 'friend of', 0);
  tie(db, projectId, ids, chunks, 'Astra Vale', 'Bram Vale', 'rival of', 1);
  tie(db, projectId, ids, chunks, 'Astra Vale', 'Bram Vale', 'ally of', 2);
  const { current, history } = lorebook.pairHistory(db, projectId, ids.get('Astra Vale')!, ids.get('Bram Vale')!);
  assert.equal(current?.kind, 'ally of');
  assert.deepEqual(history.map((r) => r.kind), ['friend of', 'rival of']);
  assert.equal(current?.locator, chunks[2]!.locator, 'the current row carries its chapter locator');
  db.close();
});

test('an atSeq query stops the line at that passage', () => {
  const { db, projectId, chunks, ids } = pairProject('status-at');
  tie(db, projectId, ids, chunks, 'Astra Vale', 'Bram Vale', 'friend of', 0);
  tie(db, projectId, ids, chunks, 'Astra Vale', 'Bram Vale', 'rival of', 1);
  tie(db, projectId, ids, chunks, 'Astra Vale', 'Bram Vale', 'ally of', 2);
  const { current, history } = lorebook.pairHistory(db, projectId, ids.get('Astra Vale')!, ids.get('Bram Vale')!, chunks[1]!.seq);
  assert.equal(current?.kind, 'rival of');
  assert.deepEqual(history.map((r) => r.kind), ['friend of']);
  db.close();
});

test('a later denial never becomes status', () => {
  const { db, projectId, chunks, ids } = pairProject('status-denial');
  tie(db, projectId, ids, chunks, 'Astra Vale', 'Bram Vale', 'friend of', 0);
  tie(db, projectId, ids, chunks, 'Astra Vale', 'Bram Vale', 'rival of', 1);
  tie(db, projectId, ids, chunks, 'Astra Vale', 'Bram Vale', 'sibling of', 2, 'denied');
  const { current, history } = lorebook.pairHistory(db, projectId, ids.get('Astra Vale')!, ids.get('Bram Vale')!);
  assert.equal(current?.kind, 'rival of', 'the denial does not take the crown');
  assert.ok(history.some((r) => r.kind === 'sibling of' && r.modality === 'denied'), 'the denial stays readable as history');
  db.close();
});

test('both directions of a pair are read together', () => {
  const { db, projectId, chunks, ids } = pairProject('status-both');
  tie(db, projectId, ids, chunks, 'Astra Vale', 'Bram Vale', 'friend of', 0);
  tie(db, projectId, ids, chunks, 'Bram Vale', 'Astra Vale', 'protects', 1);
  const { current, history } = lorebook.pairHistory(db, projectId, ids.get('Bram Vale')!, ids.get('Astra Vale')!);
  assert.equal(current?.kind, 'protects');
  assert.deepEqual(history.map((r) => r.kind), ['friend of']);
  db.close();
});

test('an empty pair returns nothing rather than guessing', () => {
  const { db, projectId, ids } = pairProject('status-empty');
  const { current, history } = lorebook.pairHistory(db, projectId, ids.get('Astra Vale')!, ids.get('Bram Vale')!);
  assert.equal(current, null);
  assert.deepEqual(history, []);
  db.close();
});
