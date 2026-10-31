/**
 * Three tiers: accepted (proven), user_confirmed (keeper), provisional
 * (visible, reviewable, never a keeper). Only the rule promotes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as devSummary from '../../fanfable/src/dev-summary.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const PASSAGE = "Asha is Bram's sister. Asha waited by the gate.";

function setup(text = PASSAGE) {
  const { db } = tempDb();
  const project = controller.createProject(db, `tiers-${Math.random().toString(36).slice(2, 7)}`);
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id,
    '/probe',
    'Probe',
    'sha-probe',
    AT,
  ).lastInsertRowid;
  const chunkId = db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId,
    project.id,
    1,
    'p. 1',
    '',
    text,
    text.split(/\s+/).length,
  ).lastInsertRowid;
  return { db, project, chunkId };
}

function entity(name: string) {
  return {
    kind: 'character',
    name,
    aliases: [],
    summary: '',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: "Asha is Bram's sister.",
  };
}

function relation(from: string, to: string, kind: string, evidence: string, strength = 0.9) {
  return {
    from, to, kind, description: '', chunk_index: 0, evidence, strength,
    asserted: true, names_both: true, other_person: 'named', hedge: 'certain', kind_fit: 'yes',
  };
}

function splitMock(relations: unknown[]) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations });
    if (system.includes('"entities"')) {
      return JSON.stringify({ entities: [entity('Asha'), entity('Bram')], facts: [] });
    }
    if (system.includes('timeline')) return JSON.stringify({ timeline: [] });
    return '{}';
  });
}

function insertRelation(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  from: number,
  to: number,
  kind: string,
  evidence: string,
  chunkId: number,
  status = 'provisional',
): number {
  return db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, review_status, created_at)
     VALUES (?, ?, ?, ?, '', ?, ?, 'asserted', ?, ?)`,
    projectId,
    from,
    to,
    kind,
    evidence,
    JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: chunkId }]),
    status,
    AT,
  ).lastInsertRowid;
}

function mkEntity(db: ReturnType<typeof tempDb>['db'], projectId: number, name: string): number {
  return db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    projectId,
    'character',
    name,
    '[]',
    AT,
    AT,
  ).lastInsertRowid;
}

test('extraction tiers at the model score', async () => {
  const { db, project } = setup();
  const llm = splitMock([
    relation('Asha', 'Bram', 'sister of', "Asha is Bram's sister.", 0.9),
    relation('Asha', 'Bram', 'friend of', "Asha is Bram's sister.", 0.6),
    relation('Asha', 'Bram', 'brother of', 'Asha waited by the gate.', 0.9),
  ]);
  const stats = await lorebook.extractLore(db, llm as never, project.id, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
  } as never);
  const rows = db.all<{ kind: string; review_status: string }>(
    'SELECT kind, review_status FROM canon_relation WHERE project_id = ? ORDER BY id',
    project.id,
  );
  const status = (kind: string) => rows.find((row) => row.kind === kind)?.review_status;
  assert.equal(status('sister of'), 'accepted', 'at/above the threshold banks');
  assert.equal(status('friend of'), 'provisional', 'below the threshold queues');
  assert.equal(status('brother of'), 'accepted', 'grammar is not a tier');
  assert.equal(stats.provisional, 1);
  db.close();
});

test('provisional is visible but excluded from keeper counts and answer eligibility', async () => {
  const { db, project, chunkId } = setup();
  const asha = mkEntity(db, project.id, 'Asha');
  const bram = mkEntity(db, project.id, 'Bram');
  insertRelation(db, project.id, asha, bram, 'sister of', "Asha is Bram's sister.", chunkId, 'accepted');
  insertRelation(db, project.id, asha, bram, 'friend of', "Asha is Bram's sister.", chunkId, 'provisional');
  insertRelation(db, project.id, asha, bram, 'brother of', 'Asha waited by the gate.', chunkId, 'provisional');

  const all = lorebook.listRelations(db, project.id);
  assert.equal(all.length, 3, 'browse includes provisional');
  const keepers = lorebook.listRelations(db, project.id, ['accepted', 'user_confirmed']);
  assert.equal(keepers.length, 1, 'answers/keeper filters exclude provisional');

  const summary = devSummary.devGraphSummary(db, project);
  assert.equal(summary.counts.keepers, 1);
  assert.equal(summary.counts.provisional, 2);
  db.close();
});

test('a provisional tie is never stated by the answer path', () => {
  const { db, project, chunkId } = setup();
  const asha = mkEntity(db, project.id, 'Asha');
  const bram = mkEntity(db, project.id, 'Bram');
  insertRelation(db, project.id, asha, bram, 'friend of', "Asha is Bram's sister.", chunkId, 'provisional');
  const answer = lorebook.bankAnswerForQuestion(db, project.id, 'Are Asha and Bram friends?');
  assert.notEqual(answer.status, 'keeper', 'provisional is not answer-eligible');
  db.close();
});

test('promoteProvisional is dry-run safe, rule-only and idempotent', () => {
  const { db, project, chunkId } = setup();
  const asha = mkEntity(db, project.id, 'Asha');
  const bram = mkEntity(db, project.id, 'Bram');
  const provable = insertRelation(db, project.id, asha, bram, 'sister of', "Asha is Bram's sister.", chunkId);
  const weak = insertRelation(db, project.id, asha, bram, 'brother of', 'Asha waited by the gate.', chunkId);

  const dry = lorebook.promoteProvisional(db, project.id, { dryRun: true });
  assert.equal(dry.promoted, 2, 'both quotes are verbatim and carry the default confidence');
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', provable)!.review_status,
    'provisional',
    'dry run writes nothing',
  );

  const real = lorebook.promoteProvisional(db, project.id);
  assert.equal(real.promoted, 2);
  assert.equal(real.still.length, 0);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', provable)!.review_status,
    'accepted',
  );
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', weak)!.review_status,
    'accepted',
  );

  const second = lorebook.promoteProvisional(db, project.id);
  assert.equal(second.promoted, 0);
  assert.equal(second.checked, 0);
  db.close();
});

test('--find-evidence promotes only a returned sentence that verifies', async () => {
  const { db, project, chunkId } = setup();
  const asha = mkEntity(db, project.id, 'Asha');
  const bram = mkEntity(db, project.id, 'Bram');
  const cora = mkEntity(db, project.id, 'Cora');
  const dane = mkEntity(db, project.id, 'Dane');
  const fixable = insertRelation(db, project.id, asha, bram, 'sister of', 'Asha waited by the gate.', chunkId);
  const hopeless = insertRelation(db, project.id, cora, dane, 'sister of', 'Cora waited by the gate.', chunkId);

  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('find one proving sentence')) {
      return system.includes('Cora')
        ? JSON.stringify({ sentence: 'This sentence is not in the passage.' })
        : JSON.stringify({ sentence: "Asha is Bram's sister." });
    }
    return '{}';
  });
  const result = await lorebook.promoteProvisionalWithEvidence(db, llm as never, project.id, { limit: 5 });
  assert.equal(result.returned, 2);
  assert.equal(result.verified, 1);
  assert.equal(result.promoted, 1);
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', fixable)!.review_status,
    'accepted',
  );
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', hopeless)!.review_status,
    'provisional',
    'an unverifiable return changes nothing',
  );
  db.close();
});
