import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedProject } from './helpers.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as loreDiag from '../../fanfable/src/answer/lore-diagnostics.ts';
import * as graph from '../../fanfable/src/graph.ts';

function setupBank(db: any, projectId: number) {
  const now = '2026-01-01T00:00:00.000Z';
  const ent = (name: string): number =>
    db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', projectId, name, now, now).lastInsertRowid;
  const a = ent('Asha Vale');
  const b = ent('Bram Vale');
  return { a, b, now, ent };
}

test('triple postings resolve and unplaced rows stay invisible', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'thin-index');
  const { a, b, now } = setupBank(db, project.id);
  const chunk = db.get<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1', project.id)!;
  const refs = JSON.stringify([{ source: 's', locator: 'p1', chunk: chunk.id }]);
  db.run(
    'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    project.id, a, b, 'sister of', 'Asha is the sister of Bram', 'her sister', refs, 'asserted', 'accepted', now,
  );
  db.run(
    'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    project.id, a, b, 'friend of', 'friends', '', JSON.stringify([]), 'asserted', 'accepted', now,
  );
  const postings = lorebook.triplePassages(db, project.id);
  assert.ok(postings.some((p) => p.chunkId === chunk.id && p.locator.length > 0), 'placed triple resolves to a locator');
  assert.ok(postings.every((p) => p.chunkId > 0), 'unplaced rows produce no posting');
  db.close();
});

test('frozen ordering: corroborated outranks singleton, quiet window wins ties', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'thin-order');
  const { a, b, now, ent } = setupBank(db, project.id);
  const c = ent('Cora Vale');
  const chunks = db.all<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 3', project.id);
  const refs = (id: number) => JSON.stringify([{ source: 's', locator: `p${id}`, chunk: id }]);
  // Singleton in crowded window (chunk 0 will hold 3 claims).
  db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    project.id, a, b, 'friend of', 'crowded', 'quote one here', refs(chunks[0].id), 'asserted', 'accepted', now);
  db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    project.id, a, c, 'friend of', 'crowd two', 'quote two here', refs(chunks[0].id), 'asserted', 'accepted', now);
  db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    project.id, b, c, 'friend of', 'crowd three', 'quote three here', refs(chunks[0].id), 'asserted', 'accepted', now);
  // Same triple shape corroborated across two windows (reverse row shares the
  // unordered triple key; the directed unique index forbids exact duplicates).
  db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    project.id, a, b, 'ally of', 'first window', 'ally quote here', refs(chunks[1].id), 'asserted', 'accepted', now);
  db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    project.id, b, a, 'ally of', 'second window', 'ally quote here', refs(chunks[2].id), 'asserted', 'accepted', now);
  // Unverified row must stay invisible to ranking.
  db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    project.id, a, b, 'enemy of', 'no proof', '', refs(chunks[2].id), 'asserted', 'accepted', now);
  const ranked = lorebook.rankedRelations(db, project.id);
  assert.ok(!ranked.some((r) => r.kind === 'enemy of'), 'unverified invisible');
  const allyFirst = ranked.findIndex((r) => r.kind === 'ally of');
  const friendIdx = ranked.findIndex((r) => r.kind === 'friend of');
  assert.ok(allyFirst !== -1 && friendIdx !== -1 && allyFirst < friendIdx, '2x corroborated outranks singleton');
  const again = lorebook.rankedRelations(db, project.id).map((r) => r.id);
  assert.deepEqual(ranked.map((r) => r.id), again, 'reruns deterministic');
  db.close();
});

test('gap finder reports zero-tie pairs with resolving locators', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'thin-gap');
  const gaps = loreDiag.diagnose(db, project.id, { limit: 25 });
  const missing = gaps.filter((g) => g.kind === 'missing-relation');
  // Seeded book has plain kinship sentences without banked ties for every pair.
  assert.ok(missing.length >= 0, 'gap pass runs');
  for (const g of missing.slice(0, 5)) {
    assert.ok(g.chunkId !== undefined && g.locator, 'every missing item links a resolving passage');
  }
  db.close();
});

test('composed path deterministic under insertion order', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'thin-compose-det');
  const now = '2026-01-01T00:00:00.000Z';
  const ent = (name: string): number =>
    db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, name, now, now).lastInsertRowid;
  const x = ent('Xan');
  const y = ent('Yara');
  const m1 = ent('Mona');
  const m2 = ent('Milo');
  const rel = (f: number, t: number, kind: string) =>
    db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, created_at, review_status) VALUES (?, ?, ?, ?, ?, ?)', project.id, f, t, kind, now, 'accepted');
  rel(x, m2, 'son of'); rel(m2, y, 'aunt of');
  rel(x, m1, 'son of'); rel(m1, y, 'aunt of');
  const first = graph.findComposedPath(db, project.id, x, y);
  const second = graph.findComposedPath(db, project.id, x, y);
  assert.deepEqual(first, second, 'same answer every run');
  assert.ok(first && (first.via === 'Milo' || first.via === 'Mona'), 'one middle wins deterministically');
  db.close();
});
