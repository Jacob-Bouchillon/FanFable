/**
 * User verdicts are labels, never levers.
 *
 * A confirmation marks a row "the user says so" for audit. It must not change
 * the tier the row's own evidence earned, must not add or remove a row, and
 * must not move a single line of retrieval. Replay restores the label only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../../fanfable/src/core/db.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as loreDiag from '../../fanfable/src/answer/lore-diagnostics.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';

const AT = '2026-01-01T00:00:00.000Z';

function bookProject(name: string): { db: Db; projectId: number; chunkId: number; ids: Map<string, number> } {
  const dir = mkdtempSync(join(tmpdir(), 'fanfable-verdict-'));
  const book = join(dir, 'book.txt');
  writeFileSync(
    book,
    ['ONE', '', 'Astra Vale was the sister of Bram Vale, and the whole yard knew it.', ''].join('\n'),
  );
  const db = new Db(join(dir, 'test.db'));
  const project = controller.createProject(db, name);
  lore.importSource(db, project.id, book);
  const chunkId = db.all<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY id', project.id)[0]!.id;
  const ids = new Map<string, number>();
  for (const person of ['Astra Vale', 'Bram Vale']) {
    ids.set(
      person,
      Number(
        db.run(
          'INSERT INTO canon_entity (project_id, kind, name, aliases, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          project.id, 'character', person, '[]', `Astra Vale was the sister of Bram Vale.`,
          JSON.stringify([{ source: 'book', locator: 'p. 1', chunk: chunkId }]), AT, AT,
        ).lastInsertRowid,
      ),
    );
  }
  return { db, projectId: project.id, chunkId, ids };
}

function seedTie(db: Db, projectId: number, ids: Map<string, number>, chunkId: number, status = 'needs_review'): number {
  return lorebook.insertRelation(db, projectId, {
    fromEntity: ids.get('Astra Vale')!,
    toEntity: ids.get('Bram Vale')!,
    kind: 'sister of',
    evidence: 'Astra Vale was the sister of Bram Vale.',
    sourceRefs: JSON.stringify([{ source: 'book', locator: 'p. 1', chunk: chunkId }]),
    reviewStatus: status,
    confidence: 0.9,
  });
}

function retrieval(db: Db, projectId: number): unknown {
  // Retrieval is what may read the bank: keeper lookup and the answer path.
  // The `confirmedByUser` label is dropped from the comparison on purpose: the
  // claim is that the verdict moves no row and no order, while the label
  // itself is expected to change (that is what it is for).
  const pair = lorebook.lookupKeeperPair(db, projectId, 'Astra Vale', 'Bram Vale').map((row) => ({
    id: row.id,
    fromId: row.fromId,
    toId: row.toId,
    kind: row.kind,
    reviewStatus: row.reviewStatus,
    evidence: row.evidence,
  }));
  return {
    pair,
    answer: lorebook.bankAnswerForQuestion(db, projectId, 'Is Astra Vale related to Bram Vale?'),
    keepers: db.all<{ id: number }>(
      "SELECT id FROM canon_relation WHERE project_id = ? AND review_status IN ('accepted','attested','user_confirmed') ORDER BY id",
      projectId,
    ),
  };
}

test('a confirmation without a sentence at bar stays in review', () => {
  const { db, projectId, ids, chunkId } = bookProject('verdict-no-proof');
  // Evidence empty: the row has no proving sentence.
  const id = Number(
    db.run(
      `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, confidence, created_at)
       VALUES (?, ?, ?, 'sister of', '', ?, 'needs_review', 0.4, ?)`,
      projectId, ids.get('Astra Vale')!, ids.get('Bram Vale')!, JSON.stringify([{ source: 'book', locator: 'p. 1', chunk: chunkId }]), AT,
    ).lastInsertRowid,
  );
  assert.equal(loreDiag.correctRelation(db, projectId, id, { confirm: true }), true);
  const row = db.get<{ review_status: string; confirmed_by_user: number }>(
    'SELECT review_status, confirmed_by_user FROM canon_relation WHERE id = ?',
    id,
  )!;
  assert.equal(row.review_status, 'needs_review', 'no sentence means no promotion');
  assert.equal(row.confirmed_by_user, 1, 'the label is kept for audit');
});

test('confirming a row never changes its tier', () => {
  const { db, projectId, ids, chunkId } = bookProject('verdict-tier');
  const id = seedTie(db, projectId, ids, chunkId, 'needs_review');
  const before = retrieval(db, projectId);
  loreDiag.correctRelation(db, projectId, id, { confirm: true });
  assert.equal(
    db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', id)!.review_status,
    'needs_review',
  );
  assert.deepEqual(retrieval(db, projectId), before, 'a verdict moves no retrieval row');
});

test('replaying a confirmations file restores the label and moves zero rows', () => {
  const source = bookProject('verdict-source');
  const target = bookProject('verdict-target');
  const srcId = seedTie(source.db, source.projectId, source.ids, source.chunkId, 'accepted');
  const tgtId = seedTie(target.db, target.projectId, target.ids, target.chunkId, 'accepted');
  // The human agreed with this row: status tier stays `accepted`, label set.
  source.db.run("UPDATE canon_relation SET confirmed_by_user = 1 WHERE id = ?", srcId);
  const file = lorebook.exportRulings(source.db, source.projectId);
  assert.equal(file.keepers.length, 1);

  const before = retrieval(target.db, target.projectId);
  const result = lorebook.replayRulings(target.db, target.projectId, file, { write: true });
  assert.equal(result.keepers.applied + result.keepers.already_present, 1);
  const after = retrieval(target.db, target.projectId);
  assert.deepEqual(after, before, 'candidates, scores and order are byte-identical');

  const row = target.db.get<{ review_status: string; confirmed_by_user: number }>(
    'SELECT review_status, confirmed_by_user FROM canon_relation WHERE id = ?',
    tgtId,
  )!;
  assert.equal(row.review_status, 'accepted', 'the tier is the row\'s own evidence');
  assert.equal(row.confirmed_by_user, 1, 'the label was restored');
});

test('a confirmation replay never creates a retrievable row', () => {
  const source = bookProject('verdict-new-source');
  const target = bookProject('verdict-new-target');
  const srcId = seedTie(source.db, source.projectId, source.ids, source.chunkId, 'accepted');
  source.db.run("UPDATE canon_relation SET confirmed_by_user = 1 WHERE id = ?", srcId);
  const file = lorebook.exportRulings(source.db, source.projectId);

  assert.equal(target.db.get<{ n: number }>('SELECT count(*) AS n FROM canon_relation WHERE project_id = ?', target.projectId)!.n, 0);
  const before = retrieval(target.db, target.projectId);
  lorebook.replayRulings(target.db, target.projectId, file, { write: true });
  const after = retrieval(target.db, target.projectId);
  assert.deepEqual(after, before, 'a verdict-only row is parked, not retrievable');

  const parked = target.db.get<{ review_status: string; confirmed_by_user: number }>(
    'SELECT review_status, confirmed_by_user FROM canon_relation WHERE project_id = ?',
    target.projectId,
  )!;
  assert.ok(parked, 'the label was recorded');
  assert.equal(parked.review_status, 'needs_review');
  assert.equal(parked.confirmed_by_user, 1);
});
