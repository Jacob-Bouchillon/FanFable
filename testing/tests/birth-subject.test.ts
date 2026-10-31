/**
 * Birth subject follows the evidence; one born thread per subject.
 * Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/controller.ts';
import { buildPairThreads } from '../../fanfable/src/web/pair-threads.ts';
import { syncThreads } from '../../fanfable/src/web/threads.ts';
import * as threadWeb from '../../fanfable/src/web/threads.ts';
import * as meetingWeb from '../../fanfable/src/web/meetings.ts';
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

function addSource(db: Db, projectId: number): number {
  return Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      '/birth-source',
      'Probe',
      'sha-birth',
      AT,
    ).lastInsertRowid,
  );
}

function addChunk(db: Db, projectId: number, sourceId: number, seq: number, text: string): number {
  return Number(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
       VALUES (?, ?, ?, ?, '', ?, ?)`,
      sourceId,
      projectId,
      seq,
      `p. ${seq}`,
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
}

/** A pair with two labelled periods, so the base thread is not a parent. */
function setupPeriods(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const source = addSource(db, project.id);
  const early = [1, 2, 3].map((seq) =>
    addChunk(db, project.id, source, seq, `Mara Voss met Corin Hale near the marker ${seq}.`),
  );
  const late = [60, 61, 62].map((seq) =>
    addChunk(db, project.id, source, seq, `Mara Voss met Corin Hale near the marker ${seq}.`),
  );
  const mara = addEntity(db, project.id, 'Mara Voss');
  const corin = addEntity(db, project.id, 'Corin Hale');
  buildPairThreads(db, project.id);
  syncThreads(db, project.id);
  const periods = db.all<{ id: number; period_label: string }>(
    "SELECT id, period_label FROM canon_thread WHERE project_id = ? AND kind = 'pair' ORDER BY id",
    project.id,
  );
  assert.equal(periods.length, 2, 'the fixture must have two labelled periods');
  return { db, project: project.id, mara, corin, early, late, periods };
}

test('pooled pair evidence births a pair child, never a person child', () => {
  const { db, project, mara, corin, early, late, periods } = setupPeriods('birth-subject-pair');
  const [p1, p2] = periods;
  threadWeb.addNote(db, project, p1!.id, {
    chunkId: early[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale near the marker 1.',
    claim: 'they meet at the marker',
    strength: 0.55,
  });
  threadWeb.addNote(db, project, p2!.id, {
    chunkId: late[0]!,
    locator: 'p. 60',
    quote: 'Mara Voss met Corin Hale near the marker 60.',
    claim: 'they meet again later',
    strength: 0.6,
  });

  const result = meetingWeb.runMeetings(db, project, { minConfidence: 0.7 });
  assert.equal(result.birthsCreated, 1);
  const birth = db.get<{ child_thread: number; trigger: string }>(
    'SELECT child_thread, trigger FROM canon_birth WHERE project_id = ?',
    project,
  )!;
  const child = db.get<{ kind: string; a_entity: number; b_entity: number | null; birth_reason: string }>(
    'SELECT kind, a_entity, b_entity, birth_reason FROM canon_thread WHERE id = ?',
    birth.child_thread,
  )!;
  assert.equal(child.kind, 'pair', 'the subject follows the pooled evidence');
  assert.equal(child.a_entity, Math.min(mara, corin));
  assert.equal(child.b_entity, Math.max(mara, corin));
  assert.match(child.birth_reason, /subject-source=evidence-pair/);
  assert.match(child.birth_reason, new RegExp(`subject=pair:${Math.min(mara, corin)}:${Math.max(mara, corin)}`));
  db.close();
});

test('a second meeting pooling the same pair enriches instead of birthing', () => {
  const { db, project, early, late, periods } = setupPeriods('birth-enrich');
  const [p1, p2] = periods;
  threadWeb.addNote(db, project, p1!.id, {
    chunkId: early[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale near the marker 1.',
    claim: 'they meet at the marker',
    strength: 0.55,
  });
  threadWeb.addNote(db, project, p2!.id, {
    chunkId: late[0]!,
    locator: 'p. 60',
    quote: 'Mara Voss met Corin Hale near the marker 60.',
    claim: 'they meet again later',
    strength: 0.6,
  });
  meetingWeb.runMeetings(db, project, { minConfidence: 0.7 });
  const birthsAfterFirst = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_birth WHERE project_id = ?',
    project,
  )!.n;
  const childId = db.get<{ child_thread: number }>(
    'SELECT child_thread FROM canon_birth WHERE project_id = ?',
    project,
  )!.child_thread;
  const refsBefore = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_thread_note_ref WHERE thread_id = ?',
    childId,
  )!.n;

  // A third period pools more evidence for the same pair.
  const p3 = Number(
    db.run(
      `INSERT INTO canon_thread
         (project_id, kind, a_entity, b_entity, status, birth_reason, period_label,
          period_from_seq, period_to_seq, temporal_status, created_at, updated_at)
       SELECT project_id, kind, a_entity, b_entity, 'open', '', 'p3', 120, 120, 'current', created_at, updated_at
         FROM canon_thread WHERE id = ?`,
      p1!.id,
    ).lastInsertRowid,
  );
  const thirdChunk = Number(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
       SELECT source_id, project_id, 120, 'p. 120', '', 'Mara Voss met Corin Hale near the marker 120.', 9
         FROM canon_chunk WHERE id = ?`,
      early[0]!,
    ).lastInsertRowid,
  );
  threadWeb.addNote(db, project, p3, {
    chunkId: thirdChunk,
    locator: 'p. 120',
    quote: 'Mara Voss met Corin Hale near the marker 120.',
    claim: 'they meet a third time',
    strength: 0.8,
  });

  const second = meetingWeb.runMeetings(db, project, { minConfidence: 0.7 });
  assert.equal(second.birthsCreated, 0, 'no sibling is born');
  assert.ok(second.birthsEnriched >= 1, 'the existing child is enriched');
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_birth WHERE project_id = ?', project)!.n,
    birthsAfterFirst,
    'a birth row still means one birth',
  );
  const refsAfter = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_thread_note_ref WHERE thread_id = ?',
    childId,
  )!.n;
  assert.ok(refsAfter > refsBefore, 'references grew');
  const meeting = db.get<{ child_thread: number }>(
    "SELECT child_thread FROM canon_meeting WHERE project_id = ? AND child_thread = ?",
    project,
    childId,
  );
  assert.ok(meeting, 'the enriching meeting points at the existing child');
  db.close();
});

test('a child that would copy a parent is refused and counted', () => {
  const { db, project, early, late } = setupPeriods('birth-refuse');
  // Merge the two periods into one legacy thread, so the pair has a single
  // investigation with label '' and any birth for that pair would copy it.
  const legacy = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' AND period_label = 'p1'",
    project,
  )!.id;
  const later = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' AND period_label = 'p2'",
    project,
  )!.id;
  db.run("UPDATE canon_thread SET period_label = '' WHERE id = ?", legacy);
  db.run("UPDATE canon_thread SET status = 'open' WHERE id = ?", later);
  threadWeb.addNote(db, project, legacy, {
    chunkId: early[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale near the marker 1.',
    claim: 'they meet at the marker',
    strength: 0.55,
  });
  threadWeb.addNote(db, project, later, {
    chunkId: late[0]!,
    locator: 'p. 60',
    quote: 'Mara Voss met Corin Hale near the marker 60.',
    claim: 'they meet again later',
    strength: 0.55,
  });
  const result = meetingWeb.runMeetings(db, project, { minConfidence: 0.7 });
  assert.ok(result.birthsRefused['child-equals-parent'] >= 1);
  db.close();
});

test('duplicate born subjects reconcile to one live thread and dormant extras', () => {
  const { db, project, mara, corin, early } = setupPeriods('birth-reconcile');
  const note = threadWeb.addNote(db, project, db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' ORDER BY id LIMIT 1",
    project,
  )!.id, {
    chunkId: early[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale near the marker 1.',
    claim: 'they meet at the marker',
    strength: 0.5,
  });
  const make = (parents: [number, number]): number =>
    Number(
      db.run(
        `INSERT INTO canon_thread
           (project_id, kind, a_entity, b_entity, status, birth_reason, parent_a_thread, parent_b_thread, created_at, updated_at)
         VALUES (?, 'pair', ?, ?, 'open', 'legacy duplicate', ?, ?, ?, ?)`,
        project,
        Math.min(mara, corin),
        Math.max(mara, corin),
        parents[0],
        parents[1],
        AT,
        AT,
      ).lastInsertRowid,
    );
  const first = make([1, 2]);
  const second = make([3, 4]);
  db.run(
    `INSERT INTO canon_thread_note_ref (thread_id, note_id, role, created_at) VALUES (?, ?, 'pooled', ?)`,
    second,
    note,
    AT,
  );

  const report = meetingWeb.reconcileBornThreads(db, project);
  assert.equal(report.duplicateSubjects, 1);
  assert.equal(report.extraThreads, 1);
  const written = meetingWeb.reconcileBornThreads(db, project, { write: true });
  assert.equal(written.markedDormant, 1);

  const rows = db.all<{ id: number; status: string; birth_reason: string }>(
    'SELECT id, status, birth_reason FROM canon_thread WHERE id IN (?, ?) ORDER BY id',
    first,
    second,
  );
  assert.equal(rows[0]!.status, 'open', 'the lowest id stays live');
  assert.equal(rows[1]!.status, 'dormant');
  assert.match(rows[1]!.birth_reason, new RegExp(`superseded-by:${first}`));
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note_ref WHERE thread_id = ?', second)!.n,
    1,
    'notes and references are untouched',
  );
  db.close();
});
