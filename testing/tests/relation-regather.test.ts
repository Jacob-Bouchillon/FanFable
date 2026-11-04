/**
 * Evidence regather (Stages B+C): deterministic, no model.
 *
 * Keepers missing a stating passage either gain one from the bank's own text
 * or park for review. Status, evidence and refs may change; kind, endpoints
 * and direction never do.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function entity(db: Db, projectId: number, name: string): number {
  return Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    projectId, 'character', name, '[]', 'accepted', AT, AT,
  ).lastInsertRowid);
}

function chunk(db: Db, projectId: number, seq: number, text: string): number {
  const source = Number(db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId, `/regather-${seq}-${Math.random().toString(36).slice(2)}`, 'Regather', 'sha-regather', AT,
  ).lastInsertRowid);
  return Number(db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    source, projectId, seq, `p. ${seq}`, '', text, text.split(/\s+/).length,
  ).lastInsertRowid);
}

function keeper(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  kind: string,
  evidence: string,
  refs: string,
  status = 'accepted',
): number {
  return Number(db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs, confidence,
        review_status, supporting_evidence, created_at)
     VALUES (?, ?, ?, ?, '', ?, ?, 0.9, ?, '[]', ?)`,
    projectId, from, to, kind, evidence, refs, status, AT,
  ).lastInsertRowid);
}

function identity(db: Db, projectId: number, id: number): Record<string, unknown> {
  return db.get<Record<string, unknown>>(
    'SELECT from_entity, to_entity, kind FROM canon_relation WHERE id = ? AND project_id = ?',
    id,
    projectId,
  )!;
}

test('a no-ref keeper gains the stating passage and a ruling', () => {
  const { db } = tempDb();
  const project = createProject(db, 'regather-repoint');
  const asha = entity(db, project.id, 'Asha');
  const bram = entity(db, project.id, 'Bram');
  const stating = chunk(db, project.id, 1, 'Asha is the aunt of Bram. The hall was cold.');
  const row = keeper(db, project.id, asha, bram, 'aunt of', 'an older wrong quote', '[]');
  const before = identity(db, project.id, row);

  const dry = lorebook.regatherRelationEvidence(db, project.id, { dryRun: true });
  assert.deepEqual(dry, { keepers: 1, unverified: 1, repointed: 1, parked: 0, untouched: 0 });
  assert.equal(
    db.get<{ evidence: string }>('SELECT evidence FROM canon_relation WHERE id = ?', row)!.evidence,
    'an older wrong quote',
    'dry run writes nothing',
  );

  const wrote = lorebook.regatherRelationEvidence(db, project.id, { dryRun: false });
  assert.deepEqual(wrote, { keepers: 1, unverified: 1, repointed: 1, parked: 0, untouched: 0 });
  const saved = db.get<{ evidence: string; source_refs: string; review_status: string }>(
    'SELECT evidence, source_refs, review_status FROM canon_relation WHERE id = ?',
    row,
  )!;
  assert.equal(saved.evidence, 'Asha is the aunt of Bram.');
  assert.deepEqual(JSON.parse(saved.source_refs), [{ source: 'Regather', locator: 'p. 1', chunk: stating }]);
  assert.equal(saved.review_status, 'accepted', 'a repointed keeper keeps its status');
  assert.deepEqual(identity(db, project.id, row), before, 'kind and endpoints are unchanged');
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_ruling WHERE relation_id = ? AND standard = 'sentence-proof'", row)!.n,
    1,
  );
  assert.deepEqual(lorebook.findUnverifiedKeepers(db, project.id), []);

  const rerun = lorebook.regatherRelationEvidence(db, project.id, { dryRun: false });
  assert.deepEqual(rerun, { keepers: 1, unverified: 0, repointed: 0, parked: 0, untouched: 0 });
  db.close();
});

test('a keeper with no stating passage parks with a note, ruling and unchanged identity', () => {
  const { db } = tempDb();
  const project = createProject(db, 'regather-park');
  const asha = entity(db, project.id, 'Asha');
  const bram = entity(db, project.id, 'Bram');
  chunk(db, project.id, 1, 'Asha and Bram waited by the gate. The gate was cold.');
  const row = keeper(db, project.id, asha, bram, 'aunt of', 'an older wrong quote', '[]');
  const before = identity(db, project.id, row);

  const wrote = lorebook.regatherRelationEvidence(db, project.id, { dryRun: false });
  assert.deepEqual(wrote, { keepers: 1, unverified: 1, repointed: 0, parked: 1, untouched: 0 });
  const saved = db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', row)!;
  assert.equal(saved.review_status, 'needs_review');
  assert.deepEqual(identity(db, project.id, row), before, 'kind and endpoints are unchanged');
  const note = db.get<{ status: string; reason: string; attempted_kind: string }>(
    'SELECT status, reason, attempted_kind FROM canon_tie_note WHERE project_id = ? AND from_entity = ? AND to_entity = ?',
    project.id,
    asha,
    bram,
  );
  assert.equal(note?.status, 'pending');
  assert.equal(note?.reason, 'no-ref');
  assert.equal(note?.attempted_kind, 'aunt of');
  assert.ok(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM canon_ruling WHERE relation_id = ? AND to_status = 'needs_review'",
      row,
    )!.n >= 1,
    'the park is recorded',
  );
  assert.deepEqual(
    lorebook.regatherRelationEvidence(db, project.id, { dryRun: false }),
    { keepers: 0, unverified: 0, repointed: 0, parked: 0, untouched: 0 },
    'a second run changes nothing',
  );
  db.close();
});

test('a verbatim-but-unproving keeper is repointed to the stating passage', () => {
  const { db } = tempDb();
  const project = createProject(db, 'regather-v2-repoint');
  const asha = entity(db, project.id, 'Asha');
  const bram = entity(db, project.id, 'Bram');
  const coMention = chunk(db, project.id, 1, 'Asha and Bram waited by the gate.');
  const stating = chunk(db, project.id, 2, 'Asha is the aunt of Bram.');
  const row = keeper(
    db,
    project.id,
    asha,
    bram,
    'aunt of',
    'Asha and Bram waited by the gate.',
    JSON.stringify([{ source: 'Regather', locator: 'p. 1', chunk: coMention }]),
  );
  const before = identity(db, project.id, row);

  const dry = lorebook.regatherUnprovingEvidence(db, project.id, { dryRun: true });
  assert.deepEqual(dry, { keepers: 1, unverified: 0, unproving: 1, repointed: 1, parked: 0, untouched: 0 });
  const wrote = lorebook.regatherUnprovingEvidence(db, project.id, { dryRun: false });
  assert.deepEqual(wrote, { keepers: 1, unverified: 0, unproving: 1, repointed: 1, parked: 0, untouched: 0 });

  const saved = db.get<{ evidence: string; source_refs: string; review_status: string }>(
    'SELECT evidence, source_refs, review_status FROM canon_relation WHERE id = ?',
    row,
  )!;
  assert.equal(saved.evidence, 'Asha is the aunt of Bram.');
  assert.deepEqual(JSON.parse(saved.source_refs), [{ source: 'Regather', locator: 'p. 2', chunk: stating }]);
  assert.equal(saved.review_status, 'accepted');
  assert.deepEqual(identity(db, project.id, row), before);
  assert.deepEqual(
    lorebook.regatherUnprovingEvidence(db, project.id, { dryRun: false }),
    { keepers: 1, unverified: 0, unproving: 0, repointed: 0, parked: 0, untouched: 0 },
    'a second run changes nothing',
  );
  db.close();
});

test('an unproving keeper with nowhere stating it parks; user confirmation is not erased', () => {
  const { db } = tempDb();
  const project = createProject(db, 'regather-v2-park');
  const asha = entity(db, project.id, 'Asha');
  const bram = entity(db, project.id, 'Bram');
  const coMention = chunk(db, project.id, 1, 'Asha and Bram waited by the gate.');
  const row = keeper(
    db,
    project.id,
    asha,
    bram,
    'aunt of',
    'Asha and Bram waited by the gate.',
    JSON.stringify([{ source: 'Regather', locator: 'p. 1', chunk: coMention }]),
    'user_confirmed',
  );
  const before = identity(db, project.id, row);

  const wrote = lorebook.regatherUnprovingEvidence(db, project.id, { dryRun: false });
  assert.deepEqual(wrote, { keepers: 1, unverified: 0, unproving: 1, repointed: 0, parked: 1, untouched: 0 });
  const saved = db.get<{ review_status: string; confirmed_by_user: number }>(
    'SELECT review_status, confirmed_by_user FROM canon_relation WHERE id = ?',
    row,
  )!;
  assert.equal(saved.review_status, 'needs_review', 'the park is about proof');
  assert.equal(saved.confirmed_by_user, 1, 'the author’s confirmation is not erased');
  assert.deepEqual(identity(db, project.id, row), before);
  const note = db.get<{ status: string; reason: string }>(
    'SELECT status, reason FROM canon_tie_note WHERE project_id = ? AND from_entity = ? AND to_entity = ?',
    project.id,
    asha,
    bram,
  );
  assert.equal(note?.status, 'pending');
  assert.equal(note?.reason, 'unsupported');
  assert.ok(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM canon_ruling WHERE relation_id = ? AND basis LIKE '%user confirmation unchanged%'",
      row,
    )!.n >= 1,
    'the ruling records that truth was not demoted',
  );
  assert.deepEqual(
    lorebook.regatherUnprovingEvidence(db, project.id, { dryRun: false }),
    { keepers: 0, unverified: 0, unproving: 0, repointed: 0, parked: 0, untouched: 0 },
    'a second run changes nothing',
  );
  db.close();
});

test('an already-proving keeper is untouched by v2', () => {
  const { db } = tempDb();
  const project = createProject(db, 'regather-v2-proving');
  const asha = entity(db, project.id, 'Asha');
  const bram = entity(db, project.id, 'Bram');
  const passage = chunk(db, project.id, 1, 'Asha is the aunt of Bram.');
  const row = keeper(
    db,
    project.id,
    asha,
    bram,
    'aunt of',
    'Asha is the aunt of Bram.',
    JSON.stringify([{ source: 'Regather', locator: 'p. 1', chunk: passage }]),
  );
  assert.deepEqual(
    lorebook.regatherUnprovingEvidence(db, project.id, { dryRun: false }),
    { keepers: 1, unverified: 0, unproving: 0, repointed: 0, parked: 0, untouched: 0 },
  );
  assert.equal(
    db.get<{ evidence: string }>('SELECT evidence FROM canon_relation WHERE id = ?', row)!.evidence,
    'Asha is the aunt of Bram.',
  );
  db.close();
});

test('a verified keeper is untouched', () => {
  const { db } = tempDb();
  const project = createProject(db, 'regather-verified');
  const asha = entity(db, project.id, 'Asha');
  const bram = entity(db, project.id, 'Bram');
  const passage = chunk(db, project.id, 1, 'Asha is the aunt of Bram.');
  const row = keeper(
    db,
    project.id,
    asha,
    bram,
    'aunt of',
    'Asha is the aunt of Bram.',
    JSON.stringify([{ source: 'Regather', locator: 'p. 1', chunk: passage }]),
  );
  const result = lorebook.regatherRelationEvidence(db, project.id, { dryRun: false });
  assert.deepEqual(result, { keepers: 1, unverified: 0, repointed: 0, parked: 0, untouched: 0 });
  assert.equal(
    db.get<{ evidence: string }>('SELECT evidence FROM canon_relation WHERE id = ?', row)!.evidence,
    'Asha is the aunt of Bram.',
  );
  db.close();
});
