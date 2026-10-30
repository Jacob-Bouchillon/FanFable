/**
 * Primary evidence vs supporting evidence. Promotion moves the verified
 * sentence into primary and preserves the old quote in supporting_evidence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as controller from '../../fanfable/src/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { runMigrations } from '../../fanfable/src/migrations.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const OLD = 'Asha waited by the gate.';
const NEW = "Asha is Bram's sister.";
const PASSAGE = `${NEW} ${OLD}`;

function setup() {
  const { db, path } = tempDb();
  const project = controller.createProject(db, `support-${Math.random().toString(36).slice(2, 7)}`);
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
  const asha = mk('Asha');
  const bram = mk('Bram');
  const rel = db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs, modality, review_status, created_at)
     VALUES (?, ?, ?, 'sister of', '', ?, ?, 'asserted', 'provisional', ?)`,
    project.id, asha, bram, OLD, JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: chunkId }]), AT,
  ).lastInsertRowid;
  return { db, path, project, chunkId, rel, asha, bram };
}

function finder(sentence: string) {
  return mockProvider((req) => {
    if ((req.system ?? '').includes('find one proving sentence')) {
      return JSON.stringify({ sentence });
    }
    return '{}';
  });
}

test('fresh DB is v15 with the supporting column, and rerunning is a no-op', () => {
  const { db } = tempDb();
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 24);
  const columns = db.all<{ name: string }>('PRAGMA table_info(canon_relation)').map((row) => row.name);
  assert.ok(columns.includes('supporting_evidence'));
  assert.equal(runMigrations(db.raw), 24);
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 24);
  db.close();
});

test('promotion moves the quote: new primary, old preserved as supporting', async () => {
  const { db, project, rel } = setup();
  const result = await lorebook.promoteProvisionalWithEvidence(db, finder(NEW) as never, project.id, { limit: 5 });
  assert.equal(result.promoted, 1);
  const row = db.get<{ evidence: string; review_status: string; supporting_evidence: string }>(
    'SELECT evidence, review_status, supporting_evidence FROM canon_relation WHERE id = ?', rel,
  )!;
  assert.equal(row.review_status, 'accepted');
  assert.equal(row.evidence, NEW);
  const supporting = JSON.parse(row.supporting_evidence) as { quote: string; source_refs: unknown[]; reason: string; moved_at: string }[];
  assert.equal(supporting.length, 1);
  assert.equal(supporting[0]!.quote, OLD);
  assert.equal(supporting[0]!.reason, 'superseded');
  assert.ok(supporting[0]!.moved_at);
  assert.equal((supporting[0]!.source_refs as { chunk: number }[])[0]!.chunk, db.get<{ chunk: number }>(
    'SELECT json_extract(source_refs, \'$[0].chunk\') AS chunk FROM canon_relation WHERE id = ?', rel,
  )!.chunk);
  db.close();
});

test('failed verification writes nothing', async () => {
  const { db, project, rel } = setup();
  const result = await lorebook.promoteProvisionalWithEvidence(
    db, finder('This sentence is nowhere in the passage.') as never, project.id, { limit: 5 },
  );
  assert.equal(result.promoted, 0);
  const row = db.get<{ evidence: string; review_status: string; supporting_evidence: string }>(
    'SELECT evidence, review_status, supporting_evidence FROM canon_relation WHERE id = ?', rel,
  )!;
  assert.equal(row.evidence, OLD);
  assert.equal(row.review_status, 'provisional');
  assert.equal(row.supporting_evidence, '[]');
  db.close();
});

test('dry run writes nothing', async () => {
  const { db, project, rel } = setup();
  const result = await lorebook.promoteProvisionalWithEvidence(db, finder(NEW) as never, project.id, { limit: 5, dryRun: true });
  assert.equal(result.promoted, 1);
  const row = db.get<{ evidence: string; review_status: string; supporting_evidence: string }>(
    'SELECT evidence, review_status, supporting_evidence FROM canon_relation WHERE id = ?', rel,
  )!;
  assert.equal(row.evidence, OLD);
  assert.equal(row.review_status, 'provisional');
  assert.equal(row.supporting_evidence, '[]');
  db.close();
});

test('a second promotion does not duplicate the supporting entry', async () => {
  const { db, project, rel } = setup();
  await lorebook.promoteProvisionalWithEvidence(db, finder(NEW) as never, project.id, { limit: 5 });
  const second = await lorebook.promoteProvisionalWithEvidence(db, finder(NEW) as never, project.id, { limit: 5 });
  assert.equal(second.checked, 0);
  const row = db.get<{ supporting_evidence: string }>('SELECT supporting_evidence FROM canon_relation WHERE id = ?', rel)!;
  assert.equal((JSON.parse(row.supporting_evidence) as unknown[]).length, 1);
  db.close();
});

test('citations use primary evidence only, and existing rows read supporting empty', async () => {
  const { db, project, rel } = setup();
  const before = lorebook.listRelations(db, project.id)[0]!;
  assert.deepEqual(before.supportingEvidence, []);
  await lorebook.promoteProvisionalWithEvidence(db, finder(NEW) as never, project.id, { limit: 5 });
  assert.equal(db.get<{ evidence: string }>('SELECT evidence FROM canon_relation WHERE id = ?', rel)!.evidence, NEW);
  const answer = lorebook.bankAnswerForQuestion(db, project.id, 'Are Asha and Bram siblings?');
  if (answer.status === 'keeper') assert.equal(answer.quote, NEW, 'answers cite the primary quote, never supporting');
  db.close();
});
