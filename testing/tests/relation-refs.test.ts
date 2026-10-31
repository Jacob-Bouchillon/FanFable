/** Every relation insert must carry a real chunk reference. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { enrichEntity } from '../../fanfable/src/answer/lore-diagnostics.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const PASSAGE = 'Asha is allied with Bram at the gate.';

function setup() {
  const { db } = tempDb();
  const project = controller.createProject(db, `refs-${Math.random().toString(36).slice(2, 7)}`);
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id, '/probe', 'Probe', 'sha', AT,
  ).lastInsertRowid;
  const chunkId = db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId, project.id, 1, 'p. 1', '', PASSAGE, 8,
  ).lastInsertRowid;
  const mk = (name: string) => db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id, 'character', name, '[]', AT, AT,
  ).lastInsertRowid;
  return { db, project, chunkId, asha: mk('Asha'), bram: mk('Bram') };
}

function enrichMock(quote: string) {
  return mockProvider(() => JSON.stringify({
    relations: [{ other: 'Bram', kind: 'ally of', direction: 'outgoing', description: 'x', quote }],
    facts: [],
  }));
}

test('the relation insert refuses a locator-only reference', () => {
  const { db, project, asha, bram } = setup();
  assert.throws(
    () => lorebook.insertRelation(db, project.id, {
      fromEntity: asha, toEntity: bram, kind: 'ally of', evidence: PASSAGE,
      sourceRefs: JSON.stringify([{ source: 'Probe', locator: 'p. 1' }]),
    }),
    /numeric chunk id/,
  );
  db.close();
});

test('enrich writes a chunk id with the relation', async () => {
  const { db, project, chunkId } = setup();
  const stats = await enrichEntity(db, enrichMock(PASSAGE) as never, project.id, 'Asha');
  assert.equal(stats.relations, 1);
  const row = db.get<{ source_refs: string }>('SELECT source_refs FROM canon_relation WHERE project_id = ?', project.id)!;
  const refs = JSON.parse(row.source_refs) as { chunk: number }[];
  assert.equal(refs[0]!.chunk, chunkId);
  db.close();
});

test('a claim with no matching passage becomes a no-ref tie note', async () => {
  const { db, project } = setup();
  const stats = await enrichEntity(db, enrichMock('This sentence is nowhere in the passage.') as never, project.id, 'Asha');
  assert.equal(stats.relations, 0);
  assert.equal(stats.dropped['no-ref'], 1);
  const note = db.get<{ reason: string }>('SELECT reason FROM canon_tie_note WHERE project_id = ?', project.id)!;
  assert.equal(note.reason, 'no-ref');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project.id)!.n, 0);
  db.close();
});

test('the audit finds no locator-only refs in a clean DB and one when seeded', () => {
  const { db, project, chunkId, asha, bram } = setup();
  assert.deepEqual(lorebook.findLocatorOnlyRefs(db, project.id), []);
  db.run(
    `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at)
     VALUES (?, ?, ?, 'ally of', ?, ?, 'needs_review', ?)`,
    project.id, asha, bram, PASSAGE, JSON.stringify([{ source: 'Probe', locator: 'p. 1' }]), AT,
  );
  const ids = lorebook.findLocatorOnlyRefs(db, project.id);
  assert.equal(ids.length, 1);
  // A real chunk ref is not reported.
  db.run(
    `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at)
     VALUES (?, ?, ?, 'ally of', ?, ?, 'needs_review', ?)`,
    project.id, bram, asha, PASSAGE, JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: chunkId }]), AT,
  );
  assert.equal(lorebook.findLocatorOnlyRefs(db, project.id).length, 1);
  db.close();
});
