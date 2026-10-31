/**
 * Starved-first window selection and visible contradictions.
 * Invented names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { buildPairThreads } from '../../fanfable/src/web/pair-threads.ts';
import { syncThreads } from '../../fanfable/src/web/threads.ts';
import * as threadWeb from '../../fanfable/src/web/threads.ts';
import { runMigrations } from '../../fanfable/src/core/migrations.ts';
import {
  kindsOppose,
  markContradictions,
  dismissConflict,
  starvedThreads,
  starvedWindowScores,
} from '../../fanfable/src/web/note-ingest.ts';
import { selectWindows, starvedCandidateIndices } from '../../fanfable/src/lorebook.ts';
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

function addChunks(db: Db, projectId: number, count: number): number[] {
  const source = Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      '/starved-probe',
      'Probe',
      'sha-starved',
      AT,
    ).lastInsertRowid,
  );
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      Number(
        db.run(
          `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
           VALUES (?, ?, ?, ?, '', ?, ?)`,
          source,
          projectId,
          i + 1,
          `p. ${i + 1}`,
          `Mara Voss met Corin Hale at the marker ${i + 1}.`,
          10,
        ).lastInsertRowid,
      ),
    );
  }
  return ids;
}

function setup(name: string, chunkCount = 24) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const chunks = addChunks(db, project.id, chunkCount);
  const mara = addEntity(db, project.id, 'Mara Voss');
  const corin = addEntity(db, project.id, 'Corin Hale');
  buildPairThreads(db, project.id);
  syncThreads(db, project.id);
  return { db, project: project.id, chunks, mara, corin };
}

test('the opposition map is symmetric and closed', () => {
  assert.equal(kindsOppose('enemy of', 'ally of'), true);
  assert.equal(kindsOppose('ally of', 'enemy of'), true);
  assert.equal(kindsOppose('trusted', 'distrusted'), true);
  assert.equal(kindsOppose('friend', 'enemy of'), true);
  assert.equal(kindsOppose('friend', 'friend'), false);
  assert.equal(kindsOppose('mentor', 'apprentice of'), false);
  assert.equal(kindsOppose('', ''), false);
});

test('opposed notes on one thread make exactly one conflict, and a rerun adds none', () => {
  const { db, project, chunks } = setup('conflict-same', 4);
  const thread = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' ORDER BY id LIMIT 1",
    project,
  )!.id;
  const a = threadWeb.addNote(db, project, thread, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the marker 1.',
    claim: 'they are enemies',
    strength: 0.8,
  });
  const b = threadWeb.addNote(db, project, thread, {
    chunkId: chunks[1]!,
    locator: 'p. 2',
    quote: 'Mara Voss met Corin Hale at the marker 2.',
    claim: 'they are allies',
    strength: 0.8,
  });
  db.run("UPDATE canon_thread_note SET claim_kind = 'enemy of' WHERE id = ?", a);
  db.run("UPDATE canon_thread_note SET claim_kind = 'ally of' WHERE id = ?", b);

  const first = markContradictions(db, project);
  assert.equal(first.created, 1);
  const row = db.get<{ note_low: number; note_high: number; basis: string; status: string }>(
    'SELECT note_low, note_high, basis, status FROM canon_thread_conflict WHERE project_id = ?',
    project,
  )!;
  assert.equal(row.note_low, Math.min(a, b));
  assert.equal(row.note_high, Math.max(a, b));
  assert.equal(row.status, 'visible');
  assert.match(row.basis, /^opposed-kind:/);

  const second = markContradictions(db, project);
  assert.equal(second.created, 0);
  assert.equal(second.alreadyPresent, 1);
  db.close();
});

test('identical kinds, context notes and weak notes never conflict', () => {
  const { db, project, chunks } = setup('conflict-negatives', 4);
  const thread = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' ORDER BY id LIMIT 1",
    project,
  )!.id;
  const add = (seq: number, claim: string, strength: number, kind: string, context = false): void => {
    const id = threadWeb.addNote(db, project, thread, {
      chunkId: chunks[seq]!,
      locator: `p. ${seq + 1}`,
      quote: `Mara Voss met Corin Hale at the marker ${seq + 1}.`,
      claim,
      strength,
      isContext: context,
      noteKind: context ? 'context' : 'observation',
    });
    db.run('UPDATE canon_thread_note SET claim_kind = ? WHERE id = ?', kind, id);
  };
  add(0, 'same one', 0.8, 'enemy of');
  add(1, 'same two', 0.8, 'enemy of');
  add(2, 'weak', 0.1, 'ally of');
  add(3, 'context', 0.8, 'ally of', true);
  const counts = markContradictions(db, project);
  assert.equal(counts.created, 0, 'no opposed pair qualifies');
  db.close();
});

test('opposed notes on different threads are change over time, not conflict', () => {
  const { db, project, chunks, mara, corin } = setup('conflict-cross-period', 6);
  const first = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' AND period_label = ''",
    project,
  )!.id;
  const second = Number(
    db.run(
      `INSERT INTO canon_thread
         (project_id, kind, a_entity, b_entity, status, birth_reason, period_label, temporal_status, created_at, updated_at)
       VALUES (?, 'pair', ?, ?, 'open', '', 'p2', 'current', ?, ?)`,
      project,
      Math.min(mara, corin),
      Math.max(mara, corin),
      AT,
      AT,
    ).lastInsertRowid,
  );
  const a = threadWeb.addNote(db, project, first, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the marker 1.',
    claim: 'enemies early',
    strength: 0.8,
  });
  const b = threadWeb.addNote(db, project, second, {
    chunkId: chunks[4]!,
    locator: 'p. 5',
    quote: 'Mara Voss met Corin Hale at the marker 5.',
    claim: 'allies later',
    strength: 0.8,
  });
  db.run("UPDATE canon_thread_note SET claim_kind = 'enemy of' WHERE id = ?", a);
  db.run("UPDATE canon_thread_note SET claim_kind = 'ally of' WHERE id = ?", b);
  const counts = markContradictions(db, project);
  assert.equal(counts.created, 0, 'one thread is one period; across periods it is change');
  db.close();
});

test('a dismissed conflict stays dismissed and is never recreated', () => {
  const { db, project, chunks } = setup('conflict-dismiss', 4);
  const thread = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' ORDER BY id LIMIT 1",
    project,
  )!.id;
  const a = threadWeb.addNote(db, project, thread, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the marker 1.',
    claim: 'enemies',
    strength: 0.8,
  });
  const b = threadWeb.addNote(db, project, thread, {
    chunkId: chunks[1]!,
    locator: 'p. 2',
    quote: 'Mara Voss met Corin Hale at the marker 2.',
    claim: 'allies',
    strength: 0.8,
  });
  db.run("UPDATE canon_thread_note SET claim_kind = 'enemy of' WHERE id = ?", a);
  db.run("UPDATE canon_thread_note SET claim_kind = 'ally of' WHERE id = ?", b);
  markContradictions(db, project);
  const conflict = db.get<{ id: number }>('SELECT id FROM canon_thread_conflict WHERE project_id = ?', project)!.id;
  assert.equal(dismissConflict(db, conflict), true);
  assert.equal(dismissConflict(db, conflict), false, 'dismissing twice changes nothing');

  const again = markContradictions(db, project);
  assert.equal(again.created, 0);
  assert.equal(again.dismissedSkipped, 1);
  assert.equal(
    db.get<{ status: string }>('SELECT status FROM canon_thread_conflict WHERE id = ?', conflict)!.status,
    'dismissed',
  );
  db.close();
});

test('starved threads rank zero-note first, then oldest question, then fewest notes', () => {
  const { db, project, chunks } = setup('starved-rank', 12);
  const threads = db.all<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? ORDER BY id",
    project,
  );
  // Give the first thread two notes so it is not starved by emptiness.
  for (const seq of [0, 1]) {
    threadWeb.addNote(db, project, threads[0]!.id, {
      chunkId: chunks[seq]!,
      locator: `p. ${seq + 1}`,
      quote: `Mara Voss met Corin Hale at the marker ${seq + 1}.`,
      claim: 'a clue',
      strength: 0.5,
    });
  }
  // An old question on that thread makes it starved by age.
  db.run(
    `INSERT INTO canon_open_end (project_id, thread_id, question, origin, would_resolve, status, created_at)
     VALUES (?, ?, 'old question', '', '', 'open', ?)`,
    project,
    threads[0]!.id,
    '2020-01-01T00:00:00.000Z',
  );
  const rows = starvedThreads(db, project, 20);
  assert.ok(rows.length > 0);
  const zeroNoteCount = rows.filter((row) => row.noteCount === 0).length;
  assert.ok(zeroNoteCount > 0);
  assert.ok(
    rows.slice(0, zeroNoteCount).every((row) => row.noteCount === 0),
    'threads with nothing gathered lead',
  );
  const noted = rows.find((row) => row.id === threads[0]!.id);
  assert.ok(noted, 'the noted thread with an old question is still listed, after the empty ones');
  assert.ok(rows.indexOf(noted) >= zeroNoteCount);
  const capped = starvedThreads(db, project, 1);
  assert.equal(capped.length, 1);
  db.close();
});

test('windows map to starved threads and skip mined ones', () => {
  const { db, project, chunks } = setup('starved-windows', 24);
  const thread = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' ORDER BY id LIMIT 1",
    project,
  )!.id;
  // Passages in windows 0 and 2 (windowSize 8).
  for (const chunkId of [chunks[0]!, chunks[16]!]) {
    db.run(
      'INSERT INTO canon_thread_passage (thread_id, chunk_id, seq, first_seen_at) VALUES (?, ?, 0, ?)',
      thread,
      chunkId,
      AT,
    );
  }
  const before = starvedWindowScores(db, project, { windowSize: 8, limit: 10 });
  assert.ok(before.windows.some((w) => w.index === 0));
  assert.ok(before.windows.some((w) => w.index === 2));
  assert.ok(before.threadsCovered >= 1);

  // A window counts as mined only when every passage in it is mined.
  db.run(
    `UPDATE canon_chunk SET lore_mined = 1 WHERE project_id = ? AND id IN (${chunks.slice(0, 8).map(() => '?').join(',')})`,
    project,
    ...chunks.slice(0, 8),
  );
  const after = starvedWindowScores(db, project, { windowSize: 8, limit: 10 });
  assert.ok(!after.windows.some((w) => w.index === 0), 'a mined window is not offered');
  db.close();
});

test('starvedFirst 0 reproduces the old selection exactly', () => {
  const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ score: i, reasons: [`r${i}`] }));
  const base = selectWindows(scores, { maxWindows: 4, priorityFirst: 4, seed: 42 });
  const again = selectWindows(scores, { maxWindows: 4, priorityFirst: 4, seed: 42 });
  assert.deepEqual(base.selected, again.selected);
  assert.deepEqual(base.selected, [4, 5, 6, 7], 'pure priority order with no reservation');
});

test('starvedCandidateIndices maps the same path extract uses, capped at N', () => {
  const { db, project, chunks } = setup('starved-map', 24);
  const windowSize = 8;
  const chunkObjs = chunks.map((id) => ({ id }));
  // Full-run candidate list: every window, as extract builds it.
  const candidateByFirstChunk = new Map<number, number>();
  for (let i = 0; i < chunkObjs.length / windowSize; i++) {
    candidateByFirstChunk.set(chunkObjs[i * windowSize]!.id, i);
  }
  const starved = starvedWindowScores(db, project, { windowSize, limit: 10 });
  assert.ok(starved.windows.length > 0, 'empty threads starve windows');
  const two = starvedCandidateIndices(candidateByFirstChunk, chunkObjs, starved.windows, 2, windowSize);
  assert.ok(two.length >= 1 && two.length <= 2, 'first N starved windows map to candidates');
  assert.equal(new Set(two).size, two.length, 'distinct candidates');
  for (const i of two) assert.ok(i >= 0 && i < chunkObjs.length / windowSize, 'in range');
  const repeat = starvedCandidateIndices(candidateByFirstChunk, chunkObjs, starved.windows, 2, windowSize);
  assert.deepEqual(repeat, two, 'deterministic');
  assert.deepEqual(
    starvedCandidateIndices(candidateByFirstChunk, chunkObjs, starved.windows, 0, windowSize),
    [],
    'default 0 reserves nothing',
  );
  db.close();
});

test('migration 25 adds the column and the conflict table, and reruns as a no-op', () => {
  const { db } = tempDb();
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 26);
  const columns = db.all<{ name: string }>('PRAGMA table_info(canon_thread_note)').map((row) => row.name);
  assert.ok(columns.includes('claim_kind'));
  assert.ok(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'canon_thread_conflict'")!
      .n > 0,
  );
  assert.equal(runMigrations(db.raw), 26, 'second run stays at 25');
  db.close();
});
