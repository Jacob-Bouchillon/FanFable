/** Deterministic evidence re-derivation for quarantined keepers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as controller from '../../fanfable/src/controller.ts';
import { findUnverifiedKeepers } from '../../fanfable/src/lorebook.ts';
import { applyPlan, checkCandidate, loadChunks, loadRows, planRow } from '../trials/evidence-audit/rederive-lib.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const OLD = 'Asha was once called a sister.';
const GOOD = "Asha is Bram's sister.";

function setup(sentences: string[] = [GOOD]) {
  const { db, path } = tempDb();
  const project = controller.createProject(db, `rederive-${Math.random().toString(36).slice(2, 7)}`);
  const sourceId = db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    project.id, '/probe', 'Probe', 'sha', AT,
  ).lastInsertRowid;
  const chunkIds = sentences.map((text, index) => db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId, project.id, index + 1, `p. ${index + 1}`, '', text, text.split(/\s+/).length,
  ).lastInsertRowid);
  const mk = (name: string) => db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id, 'character', name, '[]', AT, AT,
  ).lastInsertRowid;
  const asha = mk('Asha');
  const bram = mk('Bram');
  const relation = (
    from: number, to: number, kind: string, evidence: string, chunkId: number, status = 'provisional', flag = 1,
  ): number => db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, confirmed_by_user, supporting_evidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
    project.id, from, to, kind, evidence,
    JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: chunkId }]),
    status, flag, AT,
  ).lastInsertRowid;
  return { db, path, project, chunkIds, asha, bram, relation };
}

test('a verified sentence restores the row and preserves the old quote', () => {
  const { db, project, chunkIds, asha, bram, relation } = setup();
  const id = relation(asha, bram, 'sister of', OLD, chunkIds[0]!);
  const chunks = loadChunks(db, project.id);
  const rows = loadRows(db, project.id, [id]);
  const plan = planRow(rows[0]!, chunks);
  assert.equal(plan.outcome, 'restore');
  const applied = applyPlan(db, project.id, [plan], rows, chunks);
  assert.equal(applied.length, 1);
  const row = db.get<{ evidence: string; review_status: string; supporting_evidence: string }>(
    'SELECT evidence, review_status, supporting_evidence FROM canon_relation WHERE id = ?', id,
  )!;
  assert.equal(row.evidence, GOOD);
  assert.equal(row.review_status, 'user_confirmed');
  const supporting = JSON.parse(row.supporting_evidence) as { quote: string; reason: string }[];
  assert.equal(supporting[0]!.quote, OLD);
  assert.equal(supporting[0]!.reason, 'superseded');
  assert.deepEqual(findUnverifiedKeepers(db, project.id), []);
  db.close();
});

test('a sentence naming one endpoint stays provisional', () => {
  const { db, project, chunkIds, asha, bram, relation } = setup(['Asha is a sister to someone.']);
  const id = relation(asha, bram, 'sister of', OLD, chunkIds[0]!);
  const plan = planRow(loadRows(db, project.id, [id])[0]!, loadChunks(db, project.id));
  assert.equal(plan.outcome, 'remain-provisional');
  db.close();
});

test('two valid candidates go to manual review and write nothing', () => {
  const { db, project, chunkIds, asha, bram, relation } = setup([GOOD, GOOD]);
  const id = relation(asha, bram, 'sister of', OLD, chunkIds[0]!);
  const rows = loadRows(db, project.id, [id]);
  const chunks = loadChunks(db, project.id);
  const plan = planRow(rows[0]!, chunks);
  assert.equal(plan.outcome, 'manual-review');
  assert.equal(applyPlan(db, project.id, [plan], rows, chunks).length, 0);
  assert.equal(db.get<{ evidence: string }>('SELECT evidence FROM canon_relation WHERE id = ?', id)!.evidence, OLD);
  db.close();
});

test('a spliced or paraphrased sentence fails verbatim', () => {
  const { db, project, chunkIds, asha, bram, relation } = setup(["Asha is Bram's sister. The gate was cold."]);
  const id = relation(asha, bram, 'sister of', OLD, chunkIds[0]!);
  const row = loadRows(db, project.id, [id])[0]!;
  const chunk = loadChunks(db, project.id)[0]!;
  const candidate = checkCandidate(row, chunk, "Asha is Bram's sister. They left.");
  assert.equal(candidate.verbatim, false);
  assert.equal(candidate.valid, false);
  db.close();
});

test('the wrong direction stays provisional', () => {
  const { db, project, chunkIds, asha, bram, relation } = setup(["Bram is Asha's sister."]);
  const id = relation(asha, bram, 'sister of', OLD, chunkIds[0]!);
  const plan = planRow(loadRows(db, project.id, [id])[0]!, loadChunks(db, project.id));
  assert.equal(plan.outcome, 'remain-provisional');
  db.close();
});

test('re-running is idempotent and unrelated rows stay untouched', () => {
  const { db, project, chunkIds, asha, bram, relation } = setup();
  const id = relation(asha, bram, 'sister of', OLD, chunkIds[0]!);
  const other = db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, confirmed_by_user, supporting_evidence, created_at)
     VALUES (?, ?, ?, 'ally of', ?, '[]', 'provisional', 1, '[]', ?)`,
    project.id, bram, asha, 'untouched', AT,
  ).lastInsertRowid;
  const chunks = loadChunks(db, project.id);
  const rows = loadRows(db, project.id, [id, other]);
  applyPlan(db, project.id, rows.map((row) => planRow(row, chunks)), rows, chunks);
  assert.deepEqual(loadRows(db, project.id, [id]), []);
  const second = planRow(loadRows(db, project.id, [other])[0]!, chunks);
  assert.equal(second.outcome, 'remain-provisional');
  assert.equal(db.get<{ evidence: string }>('SELECT evidence FROM canon_relation WHERE id = ?', other)!.evidence, 'untouched');
  db.close();
});
