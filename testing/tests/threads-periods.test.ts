/**
 * Milestone 4, part A: time-scoped pair threads.
 * Invented names only; no book text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { buildPairThreads } from '../../fanfable/src/web/pair-threads.ts';
import { runMigrations, tableExists } from '../../fanfable/src/core/migrations.ts';
import {
  PERIOD_GAP_SEQS,
  derivePairPeriods,
  pickPeriodThread,
  syncThreads,
} from '../../fanfable/src/web/threads.ts';
import { backfillThreadNotes } from '../../fanfable/src/web/note-ingest.ts';
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
      '/period-source',
      'Probe',
      'sha-period',
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

/** A pair seen at the start of the book and again far later. */
function setup(name: string, seqs: number[]) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const source = addSource(db, project.id);
  for (const seq of seqs) {
    addChunk(db, project.id, source, seq, `Mara Voss met Corin Hale near the marker ${seq}.`);
  }
  const mara = addEntity(db, project.id, 'Mara Voss');
  const corin = addEntity(db, project.id, 'Corin Hale');
  buildPairThreads(db, project.id);
  return { db, project: project.id, source, mara, corin };
}

function periodRows(db: Db, projectId: number) {
  return db.all<{
    id: number;
    period_label: string;
    period_from_seq: number | null;
    period_to_seq: number | null;
    temporal_status: string;
  }>(
    `SELECT id, period_label, period_from_seq, period_to_seq, temporal_status
       FROM canon_thread
      WHERE project_id = ? AND kind = 'pair'
      ORDER BY period_from_seq ASC, id ASC`,
    projectId,
  );
}

test('a pair with no gap keeps the legacy single identity', () => {
  const periods = derivePairPeriods([1, 2, 3, 20, 41]);
  assert.equal(periods.length, 1);
  assert.equal(periods[0]!.label, '');
  assert.equal(periods[0]!.temporalStatus, 'unknown');
  assert.equal(periods[0]!.fromSeq, 1);
  assert.equal(periods[0]!.toSeq, 41);
});

test('a gap wider than the threshold splits the pair into periods', () => {
  const seqs = [1, 2, 3, 3 + PERIOD_GAP_SEQS + 1];
  const periods = derivePairPeriods(seqs);
  assert.equal(periods.length, 2);
  assert.deepEqual(
    periods.map((p) => p.label),
    ['p1', 'p2'],
  );
  assert.deepEqual(
    periods.map((p) => p.temporalStatus),
    ['historical', 'current'],
  );
  assert.deepEqual(
    periods.map((p) => [p.fromSeq, p.toSeq]),
    [
      [1, 3],
      [3 + PERIOD_GAP_SEQS + 1, 3 + PERIOD_GAP_SEQS + 1],
    ],
  );
});

test('period derivation is deterministic and ignores duplicates', () => {
  const seqs = [60, 1, 2, 2, 120];
  assert.deepEqual(derivePairPeriods(seqs), derivePairPeriods([...seqs].reverse()));
  assert.deepEqual(derivePairPeriods([]), []);
});

test('syncThreads creates one thread per period with the right status', () => {
  const { db, project } = setup('period-sync', [1, 2, 60, 61]);
  const result = syncThreads(db, project);
  const rows = periodRows(db, project);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.period_label, r.temporal_status]),
    [
      ['p1', 'historical'],
      ['p2', 'current'],
    ],
  );
  assert.equal(result.pairThreadsCreated, 2);
  assert.equal(result.pairPeriodsCreated, 2);

  const again = syncThreads(db, project);
  assert.equal(again.pairThreadsCreated, 0, 'a rerun creates no threads');
  assert.equal(again.pairPeriodsCreated, 0);
  assert.equal(periodRows(db, project).length, 2);
  db.close();
});

test('a single-period pair is created with an empty label', () => {
  const { db, project } = setup('period-single', [1, 2, 3]);
  syncThreads(db, project);
  const rows = periodRows(db, project);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.period_label, '');
  assert.equal(rows[0]!.temporal_status, 'unknown');
  db.close();
});

test('a root pair may repeat across periods but not within one', () => {
  const { db, project, mara, corin } = setup('period-unique', [1, 2, 60]);
  syncThreads(db, project);
  const insert = (label: string) =>
    db.run(
      `INSERT INTO canon_thread
         (project_id, kind, a_entity, b_entity, status, birth_reason, period_label, temporal_status, created_at, updated_at)
       VALUES (?, 'pair', ?, ?, 'open', '', ?, 'unknown', ?, ?)`,
      project,
      Math.min(mara, corin),
      Math.max(mara, corin),
      label,
      AT,
      AT,
    );
  assert.throws(() => insert('p1'), /UNIQUE/i, 'the same period cannot repeat');
  // A period that does not exist yet is a legitimate new investigation.
  insert('p3');
  assert.equal(periodRows(db, project).length, 3);
  db.close();
});

test('a pair first seen as one stretch gains period threads without losing the old one', () => {
  const { db, project, source, mara, corin } = setup('period-append', [1, 2, 3]);
  syncThreads(db, project);
  assert.equal(periodRows(db, project).length, 1);
  const legacyId = periodRows(db, project)[0]!.id;

  // New evidence far later splits the pair into two periods.
  addChunk(db, project, source, 90, 'Mara Voss met Corin Hale near the marker 90.');
  buildPairThreads(db, project);
  syncThreads(db, project);
  const rows = periodRows(db, project);
  assert.equal(rows.filter((r) => r.period_label === 'p1').length, 1);
  assert.equal(rows.filter((r) => r.period_label === 'p2').length, 1);
  assert.ok(
    db.get<{ id: number }>('SELECT id FROM canon_thread WHERE id = ?', legacyId),
    'the earlier thread is never deleted',
  );
  void mara;
  void corin;
  db.close();
});

test('a note lands on the period containing its passage', () => {
  const { db, project, mara, corin } = setup('period-notes', [1, 2, 60, 61]);
  syncThreads(db, project);
  const rows = periodRows(db, project);
  const late = rows.find((r) => r.period_label === 'p2')!;
  const early = rows.find((r) => r.period_label === 'p1')!;

  const chunk = db.get<{ id: number }>(
    'SELECT id FROM canon_chunk WHERE project_id = ? AND seq = 60',
    project,
  )!.id;
  db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs, confidence, review_status, created_at)
     VALUES (?, ?, ?, 'friend', '', 'Mara Voss met Corin Hale near the marker 60.', ?, 0.9, 'accepted', ?)`,
    project,
    Math.min(mara, corin),
    Math.max(mara, corin),
    JSON.stringify([{ source: 'Probe', locator: 'p. 60', chunk }]),
    AT,
  );
  backfillThreadNotes(db, project);

  const note = db.get<{ thread_id: number }>(
    "SELECT thread_id FROM canon_thread_note WHERE project_id = ? AND note_kind = 'observation' ORDER BY id LIMIT 1",
    project,
  )!;
  assert.equal(note.thread_id, late.id, 'the late passage attaches to the late period');
  assert.notEqual(note.thread_id, early.id);
  db.close();
});

test('pickPeriodThread prefers a containing period, then the narrowest', () => {
  const threads = [
    { id: 1, periodFromSeq: 1, periodToSeq: 3, periodLabel: 'p1' },
    { id: 2, periodFromSeq: 60, periodToSeq: 61, periodLabel: 'p2' },
  ];
  assert.equal(pickPeriodThread(threads, 60), 2);
  assert.equal(pickPeriodThread(threads, 1), 1);
  assert.equal(pickPeriodThread(threads, 20), 1, 'a gap goes to the nearer period');
  assert.equal(pickPeriodThread(threads, 40), 2, 'a late gap is nearer the late period');
  assert.equal(pickPeriodThread([threads[0]!], 99), 1, 'one thread always answers');
  assert.equal(pickPeriodThread([], 5), null);
});

test('migration 23 is additive on a v22 database and reruns as a no-op', () => {
  const { db } = tempDb();
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 26);
  const columns = db.all<{ name: string }>('PRAGMA table_info(canon_thread)').map((row) => row.name);
  for (const column of ['period_label', 'period_from_seq', 'period_to_seq', 'temporal_status']) {
    assert.ok(columns.includes(column), `${column} exists`);
  }

  const project = createProject(db, 'period-migrate');
  const mara = addEntity(db, project.id, 'Mara Voss');
  addEntity(db, project.id, 'Corin Hale');
  const source = addSource(db, project.id);
  addChunk(db, project.id, source, 1, 'Mara Voss met Corin Hale.');
  buildPairThreads(db, project.id);
  syncThreads(db, project.id);
  const before = {
    threads: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread')!.n,
    entities: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity')!.n,
    pairs: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_pair_thread')!.n,
  };

  db.raw.exec('PRAGMA foreign_keys = OFF');
  db.raw.exec('DROP INDEX canon_thread_root_identity');
  db.raw.exec('DROP INDEX canon_thread_period');
  for (const column of ['period_label', 'period_from_seq', 'period_to_seq', 'temporal_status']) {
    db.raw.exec(`ALTER TABLE canon_thread DROP COLUMN ${column}`);
  }
  db.raw.exec('CREATE UNIQUE INDEX canon_thread_identity ON canon_thread(project_id, kind, a_entity, COALESCE(b_entity, 0)) WHERE parent_a_thread IS NULL');
  db.raw.exec('PRAGMA user_version = 22');
  db.raw.exec('PRAGMA foreign_keys = ON');
  assert.equal(tableExists(db.raw, 'canon_thread'), true);

  assert.equal(runMigrations(db.raw), 26);
  const after = db.all<{ name: string }>('PRAGMA table_info(canon_thread)').map((row) => row.name);
  for (const column of ['period_label', 'period_from_seq', 'period_to_seq', 'temporal_status']) {
    assert.ok(after.includes(column), `${column} is recreated`);
  }
  assert.deepEqual(
    {
      threads: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread')!.n,
      entities: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity')!.n,
      pairs: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_pair_thread')!.n,
    },
    before,
    'existing data survives',
  );
  assert.ok(db.get<{ id: number }>('SELECT id FROM canon_entity WHERE id = ?', mara));
  assert.equal(runMigrations(db.raw), 26, 'second run stays at 25');
  db.close();
});
