/**
 * Milestone 5: combined-investigation births and bounded enumeration.
 * Invented names only; no book text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/controller.ts';
import { buildPairThreads } from '../../fanfable/src/pair-threads.ts';
import { syncThreads } from '../../fanfable/src/threads.ts';
import * as threadWeb from '../../fanfable/src/threads.ts';
import * as meetingWeb from '../../fanfable/src/meetings.ts';
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
      '/enum-source',
      'Probe',
      'sha-enum',
      AT,
    ).lastInsertRowid,
  );
}

function addChunk(db: Db, projectId: number, sourceId: number, seq: number, text: string): number {
  return Number(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sourceId,
      projectId,
      seq,
      `p. ${seq}`,
      '',
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
}

function setup(name: string, texts = 6) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const source = addSource(db, project.id);
  const chunks: number[] = [];
  for (let i = 0; i < texts; i++) {
    chunks.push(addChunk(db, project.id, source, i + 1, `Mara Voss met Corin Hale at the gate ${i + 1}.`));
  }
  const mara = addEntity(db, project.id, 'Mara Voss');
  const corin = addEntity(db, project.id, 'Corin Hale');
  buildPairThreads(db, project.id);
  syncThreads(db, project.id);
  const pair = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' AND a_entity = ? AND b_entity = ?",
    project.id,
    Math.min(mara, corin),
    Math.max(mara, corin),
  )!.id;
  return { db, project: project.id, chunks, mara, corin, pair };
}

/** A second (or third) period thread for the same pair: a root, not a child. */
function addPeriodThread(db: Db, pair: number, label: string, seq: number): number {
  return Number(
    db.run(
      `INSERT INTO canon_thread
         (project_id, kind, a_entity, b_entity, status, birth_reason, period_label,
          period_from_seq, period_to_seq, temporal_status, created_at, updated_at)
       SELECT project_id, kind, a_entity, b_entity, 'open', '', ?, ?, ?, 'current', created_at, updated_at
         FROM canon_thread WHERE id = ?`,
      label,
      seq,
      seq,
      pair,
    ).lastInsertRowid,
  );
}

function note(db: Db, project: number, thread: number, chunk: number, claim: string, seq: number): number {
  return threadWeb.addNote(db, project, thread, {
    chunkId: chunk,
    locator: `p. ${seq}`,
    quote: `Mara Voss met Corin Hale at the gate ${seq}.`,
    claim,
    strength: 0.5,
  });
}

test('combined_investigation births one spanning thread from two periods', () => {
  const { db, project, pair, chunks } = setup('combined-fires');
  const second = addPeriodThread(db, pair, 'p2', 50);
  note(db, project, pair, chunks[0]!, 'they meet at the gate', 1);
  note(db, project, second, chunks[1]!, 'they meet again later', 2);

  const result = meetingWeb.runMeetings(db, project);
  assert.equal(result.birthsCreated, 1);
  assert.equal(result.birthsByTrigger.combined_investigation, 1);

  const birth = db.get<{ trigger: string; child_thread: number; reason: string }>(
    'SELECT trigger, child_thread, reason FROM canon_birth WHERE project_id = ?',
    project,
  )!;
  assert.equal(birth.trigger, 'combined_investigation');
  assert.match(birth.reason, /p1|single stretch/);

  const child = db.get<{ kind: string; period_label: string; temporal_status: string; parent_a_thread: number; parent_b_thread: number }>(
    'SELECT kind, period_label, temporal_status, parent_a_thread, parent_b_thread FROM canon_thread WHERE id = ?',
    birth.child_thread,
  )!;
  assert.equal(child.kind, 'pair');
  assert.equal(child.period_label, 'combined');
  assert.equal(child.temporal_status, 'current');
  assert.equal(child.parent_a_thread, Math.min(pair, second));
  assert.equal(child.parent_b_thread, Math.max(pair, second));
  db.close();
});

test('combined_investigation does not fire for one period alone', () => {
  const { db, project, pair, chunks } = setup('combined-one-period');
  note(db, project, pair, chunks[0]!, 'they meet at the gate', 1);
  const result = meetingWeb.runMeetings(db, project);
  assert.equal(result.birthsCreated, 0);
  db.close();
});

test('combined_investigation does not fire when one parent has no pair note', () => {
  const { db, project, pair, chunks } = setup('combined-one-sided');
  const second = addPeriodThread(db, pair, 'p2', 50);
  note(db, project, pair, chunks[0]!, 'they meet at the gate', 1);
  // The second period has only a context note: sharing, not evidence.
  threadWeb.addNote(db, project, second, {
    chunkId: chunks[1]!,
    locator: 'p. 2',
    quote: 'Mara Voss met Corin Hale at the gate 2.',
    claim: 'both appear here',
    strength: 0,
    isContext: true,
    noteKind: 'context',
  });
  const result = meetingWeb.runMeetings(db, project);
  assert.equal(result.birthsCreated, 0);
  db.close();
});

test('combined_investigation needs two independent notes', () => {
  const { db, project, pair, chunks } = setup('combined-not-independent');
  const second = addPeriodThread(db, pair, 'p2', 50);
  // Both notes cite the same passage, so they are one observation, not two.
  note(db, project, pair, chunks[0]!, 'they meet at the gate', 1);
  note(db, project, second, chunks[0]!, 'they keep meeting', 1);
  const result = meetingWeb.runMeetings(db, project, { minConfidence: 0.7 });
  assert.equal(result.birthsByTrigger.combined_investigation, 0);
  db.close();
});

test('combined_investigation does not chain from an existing combined child', () => {
  const { db, project, pair, chunks } = setup('combined-no-chain');
  const second = addPeriodThread(db, pair, 'p2', 50);
  note(db, project, pair, chunks[0]!, 'they meet at the gate', 1);
  note(db, project, second, chunks[1]!, 'they meet again later', 2);
  meetingWeb.runMeetings(db, project);
  const child = db.get<{ child_thread: number }>(
    'SELECT child_thread FROM canon_birth WHERE project_id = ?',
    project,
  )!.child_thread;
  // Give the child a note of its own; it must never become a parent side.
  note(db, project, child, chunks[2]!, 'the whole span holds', 3);
  const secondRun = meetingWeb.runMeetings(db, project);
  assert.equal(secondRun.birthsCreated, 0, 'a child never births another generation');
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_birth WHERE project_id = ?', project)!.n,
    1,
  );
  db.close();
});

test('the run cap defers the remainder without losing it', () => {
  const { db, project, pair, chunks, mara } = setup('combined-cap', 8);
  // Pair one: two periods, a note on each side.
  const second = addPeriodThread(db, pair, 'p2', 50);
  note(db, project, pair, chunks[0]!, 'they meet at the gate', 1);
  note(db, project, second, chunks[1]!, 'they meet again later', 2);

  // Pair two: another pair, also two periods with notes on both sides.
  const tor = addEntity(db, project, 'Tor');
  const source = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ?', project)!.id;
  const millA = addChunk(db, project, source, 200, 'Mara Voss met Tor at the mill 200.');
  const millB = addChunk(db, project, source, 201, 'Mara Voss met Tor at the mill 201.');
  buildPairThreads(db, project);
  syncThreads(db, project);
  const pairTwo = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' AND a_entity = ? AND b_entity = ? AND period_label = ''",
    project,
    Math.min(mara, tor),
    Math.max(mara, tor),
  )!.id;
  const secondTwo = addPeriodThread(db, pairTwo, 'p2', 250);
  threadWeb.addNote(db, project, pairTwo, {
    chunkId: millA,
    locator: 'p. 200',
    quote: 'Mara Voss met Tor at the mill 200.',
    claim: 'they meet at the mill',
    strength: 0.5,
  });
  threadWeb.addNote(db, project, secondTwo, {
    chunkId: millB,
    locator: 'p. 201',
    quote: 'Mara Voss met Tor at the mill 201.',
    claim: 'they meet again at the mill',
    strength: 0.5,
  });

  const first = meetingWeb.runMeetings(db, project, { maxBirthsPerRun: 1 });
  assert.equal(first.birthsCreated, 1, 'the cap holds the run to one birth');
  assert.ok(first.birthsDeferred >= 1, 'the remainder is reported, not dropped');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_birth WHERE project_id = ?', project)!.n, 1);

  // Drain the backlog one birth per run; the cap is per run, not per lineage.
  let created = first.birthsCreated;
  let deferred = first.birthsDeferred;
  let runs = 1;
  while (deferred > 0 && runs < 40) {
    const next = meetingWeb.runMeetings(db, project, { maxBirthsPerRun: 1 });
    assert.ok(next.birthsCreated <= 1, 'each run respects the cap');
    created += next.birthsCreated;
    deferred = next.birthsDeferred;
    runs++;
  }
  assert.ok(runs >= 1, 'the drain loop ran');
  assert.equal(deferred, 0, 'the backlog drains completely');
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_birth WHERE project_id = ?', project)!.n,
    created,
    'every admitted birth was created exactly once',
  );

  const settled = meetingWeb.runMeetings(db, project, { maxBirthsPerRun: 1 });
  assert.equal(settled.birthsCreated, 0, 'nothing is born twice');
  assert.equal(settled.birthsDeferred, 0, 'nothing is left to defer');
  db.close();
});

test('enumeration matches the pairwise reference on a period fixture', () => {
  const { db, project, pair } = setup('enum-reference', 6);
  addPeriodThread(db, pair, 'p2', 50);
  addPeriodThread(db, pair, 'p3', 120);
  const mara = db.get<{ id: number }>("SELECT id FROM canon_entity WHERE project_id = ? AND name = 'Mara Voss'", project)!.id;
  const tor = addEntity(db, project, 'Tor');
  const source = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ?', project)!.id;
  addChunk(db, project, source, 200, 'Mara Voss met Tor by the mill.');
  buildPairThreads(db, project);
  syncThreads(db, project);

  const actual = meetingWeb.candidateMeetings(db, project)
    .map((c) => `${c.matchKey}|${c.threadA}|${c.threadB}`)
    .sort();

  // Reference: every unordered pair of root threads sharing exactly one
  // subject (same pair, or one shared person), with no ancestry walk.
  const rows = db.all<{ id: number; kind: string; a_entity: number; b_entity: number | null; parent_a_thread: number | null }>(
    'SELECT id, kind, a_entity, b_entity, parent_a_thread FROM canon_thread WHERE project_id = ? ORDER BY id',
    project,
  );
  const subjectOf = (row: { kind: string; a_entity: number; b_entity: number | null }): string =>
    row.kind === 'person'
      ? `person:${row.a_entity}`
      : `pair:${Math.min(row.a_entity, row.b_entity!)}:${Math.max(row.a_entity, row.b_entity!)}`;
  const peopleOf = (row: { kind: string; a_entity: number; b_entity: number | null }): number[] =>
    row.kind === 'person' ? [row.a_entity] : [row.a_entity, row.b_entity!];
  const expected = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (a.parent_a_thread !== null || b.parent_a_thread !== null) continue;
      const sa = subjectOf(a);
      const sb = subjectOf(b);
      const lo = Math.min(a.id, b.id);
      const hi = Math.max(a.id, b.id);
      if (sa === sb) {
        expected.add(`${sa}|${lo}|${hi}`);
        continue;
      }
      const shared = peopleOf(a).filter((id) => peopleOf(b).includes(id));
      if (shared.length === 1) expected.add(`person:${shared[0]}|${lo}|${hi}`);
    }
  }
  assert.deepEqual(actual, [...expected].sort(), 'the indexed pass admits the same groups');
  void mara;
  void tor;
  db.close();
});

test('enumeration reports timing and never throws on a deep chain', () => {
  const { db, project, pair } = setup('enum-depth', 4);
  // Build a 40-deep parent chain: deeper than the cap.
  let previous = pair;
  const ids: number[] = [];
  for (let i = 0; i < 40; i++) {
    const id = Number(
      db.run(
        `INSERT INTO canon_thread
           (project_id, kind, a_entity, b_entity, status, birth_reason, period_label, temporal_status,
            parent_a_thread, parent_b_thread, created_at, updated_at)
         SELECT project_id, kind, a_entity, b_entity, 'open', '', 'combined', 'current', ?, ?, created_at, updated_at
           FROM canon_thread WHERE id = ?`,
        previous,
        previous,
        previous,
      ).lastInsertRowid,
    );
    ids.push(id);
    previous = id;
  }
  const enumeration = meetingWeb.enumerateCandidates(db, project);
  assert.ok(Array.isArray(enumeration.candidates));
  assert.ok(enumeration.groupsSkippedForDepth > 0, 'the cap stopped a branch and said so');
  assert.equal(ids.length, 40);
  db.close();
});

test('a combined child references pooled notes and leaves its parents alone', () => {
  const { db, project, pair, chunks } = setup('combined-refs');
  const second = addPeriodThread(db, pair, 'p2', 50);
  const noteA = note(db, project, pair, chunks[0]!, 'they meet at the gate', 1);
  const noteB = note(db, project, second, chunks[1]!, 'they meet again later', 2);
  const wantA = threadWeb.addOpenEnd(db, project, pair, {
    question: 'What does the gate meeting settle?',
    wouldResolve: 'nothing yet, look later',
  });
  const wantB = threadWeb.addOpenEnd(db, project, second, {
    question: 'What does the later meeting settle?',
    wouldResolve: 'nothing yet either',
  });

  const before = {
    notes: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note WHERE project_id = ?', project)!.n,
    relations: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project)!.n,
    noteA: db.get<Record<string, unknown>>('SELECT * FROM canon_thread_note WHERE id = ?', noteA)!,
    noteB: db.get<Record<string, unknown>>('SELECT * FROM canon_thread_note WHERE id = ?', noteB)!,
  };

  meetingWeb.runMeetings(db, project);
  const child = db.get<{ child_thread: number }>('SELECT child_thread FROM canon_birth WHERE project_id = ?', project)!.child_thread;

  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note WHERE project_id = ?', project)!.n,
    before.notes,
    'a birth copies no notes',
  );
  const refs = db.all<{ note_id: number; role: string }>(
    'SELECT note_id, role FROM canon_thread_note_ref WHERE thread_id = ? ORDER BY note_id',
    child,
  );
  assert.deepEqual(
    refs.map((r) => r.note_id),
    [noteA, noteB].sort((x, y) => x - y),
  );
  assert.ok(refs.every((r) => r.role === 'pooled'));

  assert.deepEqual(db.get<Record<string, unknown>>('SELECT * FROM canon_thread_note WHERE id = ?', noteA)!, before.noteA);
  assert.deepEqual(db.get<Record<string, unknown>>('SELECT * FROM canon_thread_note WHERE id = ?', noteB)!, before.noteB);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project)!.n,
    before.relations,
    'a birth writes no relation',
  );

  const carried = db.all<{ carried_from_open_end_id: number; status: string }>(
    'SELECT carried_from_open_end_id, status FROM canon_open_end WHERE thread_id = ? ORDER BY carried_from_open_end_id',
    child,
  );
  assert.deepEqual(
    carried.map((c) => c.carried_from_open_end_id),
    [wantA, wantB].sort((x, y) => x - y),
  );
  assert.ok(carried.every((c) => c.status === 'open'));
  db.close();
});
