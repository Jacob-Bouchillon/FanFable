/**
 * Accepted-relation audit: recheck every `accepted` row against the current
 * guard, demote failures, never touch user-confirmed rows. Generic names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

type Db = ReturnType<typeof tempDb>['db'];

function addEntity(db: Db, projectId: number, name: string): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, '[]', '', '', 1, '', '[]', 'accepted', ?, ?)`,
      projectId,
      name,
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function addChunk(db: Db, projectId: number, text: string): number {
  const sourceId = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      `/audit-source-${Math.random().toString(36).slice(2)}`,
      'Audit',
      'sha-audit',
      AT,
    ).lastInsertRowid,
  );
  return Number(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sourceId,
      projectId,
      1,
      'p. 1',
      '',
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
}

function addRelation(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  kind: string,
  opts: { status?: string; evidence?: string; refs?: string; confirmedByUser?: boolean } = {},
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
          confidence, review_status, confirmed_by_user, created_at)
       VALUES (?, ?, ?, ?, '', ?, ?, 1.0, ?, ?, ?)`,
      projectId,
      from,
      to,
      kind,
      opts.evidence ?? '',
      opts.refs ?? '[]',
      opts.status ?? 'accepted',
      opts.confirmedByUser ? 1 : 0,
      AT,
    ).lastInsertRowid,
  );
}

function refsFor(chunk: number): string {
  return JSON.stringify([{ source: 'Audit', locator: 'p. 1', chunk }]);
}

function statusOf(db: Db, id: number): string {
  return db.get<{ review_status: string }>('SELECT review_status FROM canon_relation WHERE id = ?', id)!.review_status;
}

test('the three cited shapes now pass the mechanical guard', () => {
  const { db } = tempDb();
  const project = createProject(db, 'audit-shapes');
  const chunk = addChunk(
    db,
    project.id,
    'Mara and Uncle Rook watched Tor unwrap the parcel. ' +
      'Uncle Rook seized Pip around the waist and threw him into the hall. ' +
      'Tor asked Aunt Mara dully late that afternoon.',
  );
  const rook = addEntity(db, project.id, 'Uncle Rook');
  const tor = addEntity(db, project.id, 'Tor');
  const pip = addEntity(db, project.id, 'Pip');
  const auntMara = addEntity(db, project.id, 'Aunt Mara');
  const coordinated = addRelation(db, project.id, rook, tor, 'uncle of', {
    evidence: 'Mara and Uncle Rook watched Tor unwrap the parcel.',
    refs: refsFor(chunk),
  });
  const action = addRelation(db, project.id, rook, pip, 'uncle of', {
    evidence: 'Uncle Rook seized Pip around the waist and threw him into the hall.',
    refs: refsFor(chunk),
  });
  const titleInsideName = addRelation(db, project.id, tor, auntMara, 'aunt of', {
    evidence: 'Tor asked Aunt Mara dully late that afternoon.',
    refs: refsFor(chunk),
  });

  const result = lorebook.auditAcceptedRelations(db, project.id, { write: true });
  assert.equal(result.audited, 3);
  assert.deepEqual(result.failing, {});
  for (const id of [coordinated, action, titleInsideName]) {
    assert.equal(result.rows.find((row) => row.id === id)?.guard, 'ok');
    assert.equal(result.rows.find((row) => row.id === id)?.action, 'keep');
    assert.equal(statusOf(db, id), 'accepted');
  }
  db.close();
});

test('a genuinely asserted row passes and is untouched', () => {
  const { db, path } = tempDb();
  const project = createProject(db, 'audit-pass');
  const chunk = addChunk(db, project.id, 'Mara was the aunt of Tor.');
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  const good = addRelation(db, project.id, mara, tor, 'aunt of', {
    evidence: 'Mara was the aunt of Tor.',
    refs: refsFor(chunk),
  });
  // A failure alongside it, so the write path runs.
  const badChunk = addChunk(db, project.id, 'Mara and Tor came in together.');
  const bad = addRelation(db, project.id, mara, tor, 'friend of', {
    evidence: 'This sentence is not in the book.',
    refs: refsFor(badChunk),
  });

  const result = lorebook.auditAcceptedRelations(db, project.id, { write: true });
  assert.equal(result.passing, 1);
  assert.equal(result.changed, 1);
  assert.equal(statusOf(db, good), 'accepted');
  assert.equal(statusOf(db, bad), 'provisional');
  assert.ok(result.backupPath && existsSync(result.backupPath), 'snapshot written before demotion');
  assert.ok(result.backupPath!.startsWith(path), 'backup sits beside the database');
  db.close();
});

test('a missing or non-verbatim quote fails', () => {
  const { db } = tempDb();
  const project = createProject(db, 'audit-quote');
  const chunk = addChunk(db, project.id, 'Mara counted the lantern before dawn.');
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  const missing = addRelation(db, project.id, mara, tor, 'friend of');
  const stale = addRelation(db, project.id, tor, mara, 'friend of', {
    evidence: 'This sentence is not in the book.',
    refs: refsFor(chunk),
  });

  const result = lorebook.auditAcceptedRelations(db, project.id, { write: true });
  assert.deepEqual(result.failing, { 'quote-not-verbatim': 2 });
  assert.equal(statusOf(db, missing), 'provisional');
  assert.equal(statusOf(db, stale), 'provisional');
  db.close();
});

test('a quote naming both people but asserting nothing passes the mechanical guard', () => {
  const { db } = tempDb();
  const project = createProject(db, 'audit-cooccurrence');
  const chunk = addChunk(db, project.id, 'Mara and Tor spoke about their aunt.');
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  const row = addRelation(db, project.id, mara, tor, 'aunt of', {
    evidence: 'Mara and Tor spoke about their aunt.',
    refs: refsFor(chunk),
  });

  const result = lorebook.auditAcceptedRelations(db, project.id, { write: true });
  assert.deepEqual(result.failing, {});
  assert.equal(result.passing, 1);
  assert.equal(statusOf(db, row), 'accepted');
  db.close();
});

test('direction is reported, not judged', () => {
  const { db } = tempDb();
  const project = createProject(db, 'audit-direction');
  const chunk = addChunk(db, project.id, 'Mara was mentor to Tor.');
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  const row = addRelation(db, project.id, mara, tor, 'mentor of', {
    evidence: 'Mara was mentor to Tor.',
    refs: refsFor(chunk),
  });

  const result = lorebook.auditAcceptedRelations(db, project.id, { write: true });
  assert.equal(result.audited, 1);
  assert.equal(result.passing, 1);
  assert.equal(result.cannotJudge, 0);
  const audited = result.rows[0]!;
  assert.equal(audited.guard, 'ok');
  assert.equal(audited.direction, 'unknown');
  assert.equal(audited.cannotJudge, false);
  assert.equal(audited.action, 'keep');
  assert.equal(statusOf(db, row), 'accepted');
  db.close();
});

test('user_confirmed rows are never read or altered', () => {
  const { db } = tempDb();
  const project = createProject(db, 'audit-confirmed');
  const chunk = addChunk(db, project.id, 'Mara and Tor came in together.');
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  const confirmed = addRelation(db, project.id, mara, tor, 'aunt of', {
    status: 'user_confirmed',
    evidence: 'Mara and Tor came in together.',
    refs: refsFor(chunk),
    confirmedByUser: true,
  });

  const result = lorebook.auditAcceptedRelations(db, project.id, { write: true });
  assert.equal(result.audited, 0);
  assert.equal(result.changed, 0);
  assert.equal(statusOf(db, confirmed), 'user_confirmed');
  db.close();
});

test('a second write run changes nothing', () => {
  const { db } = tempDb();
  const project = createProject(db, 'audit-idempotent');
  const chunk = addChunk(db, project.id, 'Mara and Tor came in together.');
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  addRelation(db, project.id, mara, tor, 'aunt of', {
    evidence: 'This sentence is not in the book.',
    refs: refsFor(chunk),
  });

  const first = lorebook.auditAcceptedRelations(db, project.id, { write: true });
  assert.equal(first.changed, 1);
  const second = lorebook.auditAcceptedRelations(db, project.id, { write: true });
  assert.equal(second.audited, 0);
  assert.equal(second.changed, 0);
  assert.equal(second.backupPath, undefined, 'no new snapshot when nothing changes');
  db.close();
});

test('strict integrity wins: guard-passing non-verbatim quotes demote, verbatim keepers stay', () => {
  const { db } = tempDb();
  const project = createProject(db, 'audit-strict-wins');
  const chunk = addChunk(db, project.id, 'Mara was the aunt of Tor. Tor asked Aunt Mara dully late that afternoon.');
  const mara = addEntity(db, project.id, 'Mara');
  const tor = addEntity(db, project.id, 'Tor');
  const verbatim = addRelation(db, project.id, mara, tor, 'aunt of', {
    evidence: 'Mara was the aunt of Tor.',
    refs: refsFor(chunk),
  });
  // Each of the four passes the word-level guard (punctuation stripped) but
  // fails strict verbatim (presentation kept): extra straight quotes, extra
  // curly quotes, trailing ellipsis, quoted second sentence.
  const strictCases: Array<{ kind: string; evidence: string }> = [
    { kind: 'uncle of', evidence: '"Mara was the aunt of Tor."' },
    { kind: 'mentor of', evidence: '“Mara was the aunt of Tor.”' },
    { kind: 'ally of', evidence: 'Mara was the aunt of Tor...' },
    { kind: 'friend of', evidence: '"Tor asked Aunt Mara dully late that afternoon."' },
  ];
  const strictFails = strictCases.map(({ kind, evidence }) =>
    addRelation(db, project.id, mara, tor, kind, { evidence, refs: refsFor(chunk) }),
  );

  // Dry run by default: nothing written, but failures already reported.
  const dry = lorebook.auditAcceptedRelations(db, project.id);
  assert.equal(dry.audited, 5);
  assert.equal(dry.passing, 1);
  assert.deepEqual(dry.failing, { 'quote-not-verbatim': 4 });
  assert.equal(dry.changed, 0);
  for (const id of strictFails) {
    assert.equal(dry.rows.find((row) => row.id === id)?.guard, 'quote-not-verbatim');
    assert.equal(dry.rows.find((row) => row.id === id)?.action, 'demote');
  }
  assert.equal(dry.rows.find((row) => row.id === verbatim)?.guard, 'ok');
  assert.equal(dry.rows.find((row) => row.id === verbatim)?.action, 'keep');

  const wrote = lorebook.auditAcceptedRelations(db, project.id, { write: true });
  assert.equal(wrote.changed, 4);
  assert.equal(statusOf(db, verbatim), 'accepted');
  for (const id of strictFails) assert.equal(statusOf(db, id), 'provisional');
  // Never deletes: all five rows still exist.
  const remaining = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?',
    project.id,
  );
  assert.equal(remaining?.n, 5);
  // Strict integrity now agrees: no accepted keeper is unverified.
  assert.deepEqual(lorebook.findUnverifiedKeepers(db, project.id), []);
  db.close();
});
