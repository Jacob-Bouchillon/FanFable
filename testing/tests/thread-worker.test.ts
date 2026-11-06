/** Thread worker planning, retrieval, validation and application. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import {
  applyWorkerNotes,
  parseWorkerAnswer,
  planThreadWork,
  retrieveEvidence,
  validateWorkerNote,
  type RetrievedPassage,
  type ThreadWorkItem,
  type WorkerNote,
} from '../../fanfable/src/web/thread-worker.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const OLD = new Date(Date.now() - 8 * 86400000).toISOString();
type Db = ReturnType<typeof tempDb>['db'];

function entity(db: Db, projectId: number, name: string): number {
  return Number(db.run(
    'INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    projectId, 'character', name, '[]', AT, AT,
  ).lastInsertRowid);
}

function source(db: Db, projectId: number): number {
  return Number(db.run(
    'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
    projectId, '/worker', 'Worker', 'sha', AT,
  ).lastInsertRowid);
}

function chunk(
  db: Db,
  projectId: number,
  sourceId: number,
  seq: number,
  locator: string,
  text: string,
): number {
  return Number(db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sourceId, projectId, seq, locator, '', text, text.split(/\s+/).length,
  ).lastInsertRowid);
}

function thread(
  db: Db,
  projectId: number,
  kind: 'person' | 'pair',
  a: number,
  b: number | null,
): number {
  return Number(db.run(
    `INSERT INTO canon_thread (project_id, kind, a_entity, b_entity, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?)`,
    projectId, kind, a, b, AT, AT,
  ).lastInsertRowid);
}

function openEnd(
  db: Db,
  projectId: number,
  threadId: number,
  question: string,
  wouldResolve: string,
  createdAt: string,
): number {
  return Number(db.run(
    `INSERT INTO canon_open_end (project_id, thread_id, question, origin, would_resolve, status, created_at)
     VALUES (?, ?, ?, 'worker-test', ?, 'open', ?)`,
    projectId, threadId, question, wouldResolve, createdAt,
  ).lastInsertRowid);
}

function seed(): {
  db: Db;
  projectId: number;
  harry: number;
  ron: number;
  hermione: number;
  pairThread: number;
  personThread: number;
  noteOnlyThread: number;
  openEndId: number;
  both1: number;
  both2: number;
  onlyHarry: number;
  onlyRon: number;
} {
  const { db } = tempDb();
  const project = createProject(db, 'thread-worker');
  const sourceId = source(db, project.id);
  const harry = entity(db, project.id, 'Harry');
  const ron = entity(db, project.id, 'Ron');
  const hermione = entity(db, project.id, 'Hermione');
  const neville = entity(db, project.id, 'Neville');
  const both1 = chunk(db, project.id, sourceId, 1, 'p. 1', 'Harry and Ron went into the forest.');
  const both2 = chunk(db, project.id, sourceId, 2, 'p. 2', 'Ron told Harry about the Stone.');
  const onlyHarry = chunk(db, project.id, sourceId, 3, 'p. 3', 'Harry slept.');
  const onlyRon = chunk(db, project.id, sourceId, 4, 'p. 4', 'Ron ate.');
  const pairThread = thread(db, project.id, 'pair', harry, ron);
  const personThread = thread(db, project.id, 'person', hermione, null);
  const noteOnlyThread = thread(db, project.id, 'person', neville, null);
  db.run(
    `INSERT INTO canon_thread_note (project_id, thread_id, quote, claim, created_at)
     VALUES (?, ?, 'existing', 'existing', ?)`,
    project.id, personThread, AT,
  );
  db.run(
    `INSERT INTO canon_thread_note (project_id, thread_id, quote, claim, created_at)
     VALUES (?, ?, 'elsewhere', 'elsewhere', ?)`,
    project.id, noteOnlyThread, AT,
  );
  const openEndId = openEnd(
    db,
    project.id,
    personThread,
    'What does Hermione know about the Stone?',
    'a passage naming Hermione and the Stone',
    OLD,
  );
  return { db, projectId: project.id, harry, ron, hermione, pairThread, personThread, noteOnlyThread, openEndId, both1, both2, onlyHarry, onlyRon };
}

test('planning picks a note-free thread and a thread with an old open end', () => {
  const fixture = seed();
  const items = planThreadWork(fixture.db, fixture.projectId, 20);
  const pair = items.find((item) => item.threadId === fixture.pairThread)!;
  const person = items.find((item) => item.threadId === fixture.personThread)!;

  assert.ok(pair, 'the note-free pair thread is in the queue');
  assert.equal(pair.kind, 'pair');
  assert.deepEqual(pair.entityIds, [fixture.harry, fixture.ron]);
  assert.equal(pair.noteCount, 0);
  assert.deepEqual(pair.openEnds, []);

  assert.ok(person, 'the thread with an open end is in the queue');
  assert.equal(person.kind, 'person');
  assert.deepEqual(person.entityIds, [fixture.hermione]);
  assert.equal(person.openEnds.length, 1);
  assert.equal(person.openEnds[0]!.id, fixture.openEndId);
  assert.match(person.openEnds[0]!.question, /Hermione/);
  assert.ok(
    !items.some((item) => item.threadId === fixture.noteOnlyThread),
    'a thread with a note and no open end is still excluded',
  );
  fixture.db.close();
});

test('an open end created now is planned with the default zero-day cutoff', () => {
  const fixture = seed();
  const freshOpenEnd = openEnd(
    fixture.db,
    fixture.projectId,
    fixture.noteOnlyThread,
    'What does Neville know?',
    'a passage naming Neville',
    new Date().toISOString(),
  );

  const items = planThreadWork(fixture.db, fixture.projectId, 20);
  const person = items.find((item) => item.threadId === fixture.noteOnlyThread);
  assert.ok(person, 'a fresh open end qualifies under the default cutoff');
  assert.equal(person.openEnds.length, 1);
  assert.equal(person.openEnds[0]!.id, freshOpenEnd);

  const oldOnly = planThreadWork(fixture.db, fixture.projectId, 20, { olderThanDays: 7 });
  assert.ok(
    !oldOnly.some((item) => item.threadId === fixture.noteOnlyThread),
    'the seven-day option still excludes a fresh open end',
  );
  fixture.db.close();
});

test('retrieval keeps chunks naming both endpoints', () => {
  const fixture = seed();
  const item: ThreadWorkItem = {
    threadId: fixture.pairThread,
    kind: 'pair',
    label: 'Harry / Ron',
    entityIds: [fixture.harry, fixture.ron],
    openEnds: [],
    noteCount: 0,
  };
  const passages = retrieveEvidence(fixture.db, fixture.projectId, item, 6);
  assert.deepEqual(passages.map((passage) => passage.chunkId), [fixture.both1, fixture.both2]);
  for (const passage of passages) {
    assert.match(passage.text, /Harry/);
    assert.match(passage.text, /Ron/);
  }
  assert.ok(!passages.some((passage) => passage.chunkId === fixture.onlyHarry));
  assert.ok(!passages.some((passage) => passage.chunkId === fixture.onlyRon));
  fixture.db.close();
});

test('validation rejects a quote not found in the passage', () => {
  const fixture = seed();
  const passage: RetrievedPassage = {
    chunkId: fixture.both1,
    locator: 'p. 1',
    seq: 1,
    text: 'Harry and Ron went into the forest.',
  };
  const note: WorkerNote = { quote: 'Harry went home.', claim: 'Harry went home.', kind: 'observation', strength: 0.8 };
  assert.deepEqual(
    validateWorkerNote(note, passage, new Set(['observation'])),
    { ok: false, reason: 'quote-not-found' },
  );
  fixture.db.close();
});

test('validation rejects a kind outside the allowed set', () => {
  const fixture = seed();
  const passage: RetrievedPassage = {
    chunkId: fixture.both1,
    locator: 'p. 1',
    seq: 1,
    text: 'Harry and Ron went into the forest.',
  };
  const note: WorkerNote = {
    quote: 'Harry and Ron went into the forest.',
    claim: 'Harry and Ron went into the forest together.',
    kind: 'gossip',
    strength: 0.8,
  };
  assert.deepEqual(
    validateWorkerNote(note, passage, new Set(['observation', 'context'])),
    { ok: false, reason: 'kind-not-allowed' },
  );
  fixture.db.close();
});

test('parseWorkerAnswer accepts wrapped and bare arrays and ignores malformed entries', () => {
  const wrapped = parseWorkerAnswer(JSON.stringify({
    notes: [
      { quote: 'q1', claim: 'c1', kind: 'observation', strength: 0.5 },
      { quote: '', claim: 'c2', kind: 'observation', strength: 0.5 },
      'not an object',
    ],
  }));
  assert.deepEqual(wrapped, [{ quote: 'q1', claim: 'c1', kind: 'observation', strength: 0.5 }]);

  const bare = parseWorkerAnswer(JSON.stringify([
    { quote: 'q2', claim: 'c2', kind: 'context', strength: '0.7' },
  ]));
  assert.deepEqual(bare, [{ quote: 'q2', claim: 'c2', kind: 'context', strength: 0.7 }]);
  assert.deepEqual(parseWorkerAnswer('not json'), []);
});

test('dry-run validates and counts without writing', () => {
  const fixture = seed();
  const openEndId = openEnd(
    fixture.db,
    fixture.projectId,
    fixture.pairThread,
    'Who went into the forest with Harry?',
    'a passage naming Harry and Ron',
    OLD,
  );
  const item: ThreadWorkItem = {
    threadId: fixture.pairThread,
    kind: 'pair',
    label: 'Harry / Ron',
    entityIds: [fixture.harry, fixture.ron],
    openEnds: [{ id: openEndId, question: 'Who went into the forest with Harry?', wouldResolve: 'a passage naming Harry and Ron' }],
    noteCount: 0,
  };
  const note: WorkerNote = {
    quote: 'Harry and Ron went into the forest.',
    claim: 'Ron went into the forest with Harry.',
    kind: 'observation',
    strength: 0.9,
  };
  const passage: RetrievedPassage = {
    chunkId: fixture.both1,
    locator: 'p. 1',
    seq: 1,
    text: 'Harry and Ron went into the forest.',
  };

  const counts = applyWorkerNotes(
    fixture.db,
    fixture.projectId,
    item,
    [{ note, passage }],
    { dryRun: true },
  );
  assert.deepEqual(counts, { added: 1, duplicates: 0, rejected: 0, openEndsClosed: 1 });
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note WHERE thread_id = ?', fixture.pairThread)!.n,
    0,
  );
  assert.equal(
    fixture.db.get<{ status: string }>('SELECT status FROM canon_open_end WHERE id = ?', openEndId)!.status,
    'open',
  );
  fixture.db.close();
});

test('writing a note lands it and resolves the matching open end, idempotently', () => {
  const fixture = seed();
  const openEndId = openEnd(
    fixture.db,
    fixture.projectId,
    fixture.pairThread,
    'Who went into the forest with Harry?',
    'a passage naming Harry and Ron',
    OLD,
  );
  const item: ThreadWorkItem = {
    threadId: fixture.pairThread,
    kind: 'pair',
    label: 'Harry / Ron',
    entityIds: [fixture.harry, fixture.ron],
    openEnds: [{ id: openEndId, question: 'Who went into the forest with Harry?', wouldResolve: 'a passage naming Harry and Ron' }],
    noteCount: 0,
  };
  const note: WorkerNote = {
    quote: 'Harry and Ron went into the forest.',
    claim: 'Ron went into the forest with Harry.',
    kind: 'observation',
    strength: 0.9,
  };
  const passage: RetrievedPassage = {
    chunkId: fixture.both1,
    locator: 'p. 1',
    seq: 1,
    text: 'Harry and Ron went into the forest.',
  };

  const first = applyWorkerNotes(
    fixture.db,
    fixture.projectId,
    item,
    [{ note, passage }],
    { dryRun: false },
  );
  assert.deepEqual(first, { added: 1, duplicates: 0, rejected: 0, openEndsClosed: 1 });

  const stored = fixture.db.get<{
    id: number;
    chunk_id: number;
    locator: string;
    quote: string;
    claim: string;
    note_kind: string;
    strength: number;
    is_context: number;
    dedupe_key: string;
    strength_source: string;
  }>('SELECT id, chunk_id, locator, quote, claim, note_kind, strength, is_context, dedupe_key, strength_source FROM canon_thread_note WHERE thread_id = ?', fixture.pairThread)!;
  assert.equal(stored.chunk_id, fixture.both1);
  assert.equal(stored.locator, 'p. 1');
  assert.equal(stored.quote, note.quote);
  assert.equal(stored.claim, note.claim);
  assert.equal(stored.note_kind, 'observation');
  assert.equal(stored.strength, 0.9);
  assert.equal(stored.is_context, 0);
  assert.ok(stored.dedupe_key);
  assert.equal(stored.strength_source, 'worker');

  const open = fixture.db.get<{ status: string; resolved_by_note_id: number | null; resolved_at: string | null }>(
    'SELECT status, resolved_by_note_id, resolved_at FROM canon_open_end WHERE id = ?',
    openEndId,
  )!;
  assert.equal(open.status, 'resolved');
  assert.equal(open.resolved_by_note_id, stored.id);
  assert.ok(open.resolved_at);

  const second = applyWorkerNotes(
    fixture.db,
    fixture.projectId,
    item,
    [{ note, passage }],
    { dryRun: false },
  );
  assert.deepEqual(second, { added: 0, duplicates: 1, rejected: 0, openEndsClosed: 0 });
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note WHERE thread_id = ?', fixture.pairThread)!.n,
    1,
  );
  fixture.db.close();
});
