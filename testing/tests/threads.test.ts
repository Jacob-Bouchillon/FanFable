/**
 * Evidence web, milestone 1: thread records, immutable notes, open ends.
 * Invented names only; no model, no book text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { buildPairThreads } from '../../fanfable/src/web/pair-threads.ts';
import { runMigrations, tableExists } from '../../fanfable/src/core/migrations.ts';
import * as threadWeb from '../../fanfable/src/web/threads.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(
  db: Db,
  projectId: number,
  name: string,
  opts: { kind?: string; reviewStatus?: string } = {},
): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, ?, ?, '[]', '', '', 1, '', '[]', ?, ?, ?)`,
      projectId,
      opts.kind ?? 'character',
      name,
      opts.reviewStatus ?? 'accepted',
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
      '/thread-source',
      'Probe',
      'sha-thread',
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

function setup(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const source = addSource(db, project.id);
  const mara = addEntity(db, project.id, 'Mara Voss');
  const corin = addEntity(db, project.id, 'Corin Hale');
  const tor = addEntity(db, project.id, 'Tor');
  const hidden = addEntity(db, project.id, 'Skiv', { reviewStatus: 'quarantined' });
  const chunkOne = addChunk(db, project.id, source, 1, 'Mara Voss met Corin Hale at the gate.');
  addChunk(db, project.id, source, 2, 'Tor waited by the wall.');
  const chunkThree = addChunk(db, project.id, source, 3, 'Mara Voss argued with Corin Hale about the keys.');
  buildPairThreads(db, project.id);
  return { db, project: project.id, mara, corin, tor, hidden, chunkOne, chunkThree };
}

function threadIdOf(db: Db, projectId: number, kind: 'person' | 'pair', a: number, b: number | null): number {
  const row = db.get<{ id: number }>(
    b === null
      ? 'SELECT id FROM canon_thread WHERE project_id = ? AND kind = ? AND a_entity = ? AND b_entity IS NULL'
      : 'SELECT id FROM canon_thread WHERE project_id = ? AND kind = ? AND a_entity = ? AND b_entity = ?',
    projectId,
    kind,
    a,
    ...(b === null ? [] : [b]),
  );
  assert.ok(row, `thread for ${kind} ${a}/${b ?? ''} exists`);
  return row.id;
}

test('sync creates one thread per live person and per co-occurring pair', () => {
  const { db, project, mara, corin, tor, hidden } = setup('thread-sync');
  const result = threadWeb.syncThreads(db, project);
  // Three live characters; the quarantined one has no thread.
  assert.equal(result.personThreadsCreated, 3);
  assert.equal(result.pairThreadsCreated, 1);
  assert.equal(result.threadsTotal, 4);
  assert.equal(result.openEndsTotal, 0);

  const people = db.all<{ a_entity: number }>(
    "SELECT a_entity FROM canon_thread WHERE project_id = ? AND kind = 'person' ORDER BY a_entity",
    project,
  );
  assert.deepEqual(
    people.map((p) => p.a_entity),
    [mara, corin, tor],
  );
  assert.ok(
    !db.get<{ id: number }>('SELECT id FROM canon_thread WHERE project_id = ? AND a_entity = ?', project, hidden),
    'quarantined character has no thread',
  );

  const pair = db.get<{ pair_thread_id: number; a_entity: number; b_entity: number }>(
    "SELECT pair_thread_id, a_entity, b_entity FROM canon_thread WHERE project_id = ? AND kind = 'pair'",
    project,
  )!;
  assert.ok(pair.pair_thread_id > 0, 'pair thread is linked to its structural thread');
  assert.equal(pair.a_entity, Math.min(mara, corin));
  assert.equal(pair.b_entity, Math.max(mara, corin));
  const link = db.get<{ id: number }>(
    'SELECT id FROM canon_pair_thread WHERE id = ? AND project_id = ?',
    pair.pair_thread_id,
    project,
  );
  assert.ok(link, 'the link points at a real canon_pair_thread row');
  db.close();
});

test('a second sync creates nothing and the counts stay put', () => {
  const { db, project } = setup('thread-idempotent');
  const first = threadWeb.syncThreads(db, project);
  assert.equal(first.threadsTotal, 4);
  const second = threadWeb.syncThreads(db, project);
  assert.equal(second.personThreadsCreated, 0);
  assert.equal(second.pairThreadsCreated, 0);
  assert.equal(second.threadsTotal, first.threadsTotal);
  db.close();
});

test('sync never writes the bank or the inbox tables', () => {
  const { db, project } = setup('thread-clean');
  const counts = () =>
    ['canon_relation', 'canon_tie_note', 'canon_tie_hint'].map(
      (table) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, project)!.n,
    );
  const before = counts();
  threadWeb.syncThreads(db, project);
  threadWeb.syncThreads(db, project);
  assert.deepEqual(counts(), before);
  assert.deepEqual(before, [0, 0, 0]);
  db.close();
});

test('an empty thread is open with no notes, never "no relationship"', () => {
  const { db, project, mara, corin } = setup('thread-empty');
  threadWeb.syncThreads(db, project);
  const id = threadIdOf(db, project, 'pair', Math.min(mara, corin), Math.max(mara, corin));
  const loaded = threadWeb.loadThread(db, project, id)!;
  assert.equal(loaded.thread.status, 'open');
  assert.equal(loaded.counts.notes, 0);
  assert.equal(loaded.counts.passages, 0);
  assert.equal(loaded.notes.length, 0);
  assert.equal(loaded.openEnds.length, 0);
  db.close();
});

test('addNote stores immutable values and validates its inputs', () => {
  const { db, project, mara, chunkOne } = setup('thread-note');
  threadWeb.syncThreads(db, project);
  const thread = threadIdOf(db, project, 'person', mara, null);

  const noteId = threadWeb.addNote(db, project, thread, {
    chunkId: chunkOne,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate.',
    claim: 'They meet once at the gate.',
    why: 'one shared scene',
    missing: 'what the meeting meant',
    strength: 0.4,
  });
  const stored = db.get<Record<string, unknown>>('SELECT * FROM canon_thread_note WHERE id = ?', noteId)!;
  assert.equal(stored.quote, 'Mara Voss met Corin Hale at the gate.');
  assert.equal(stored.claim, 'They meet once at the gate.');
  assert.equal(stored.strength, 0.4);
  assert.equal(stored.note_kind, 'observation');
  assert.equal(stored.is_context, 0);

  assert.throws(() => threadWeb.addNote(db, project, thread, { quote: '   ' }), /quote is required/);
  assert.throws(() => threadWeb.addNote(db, project, thread, { quote: 'q', strength: 1.5 }), /between 0 and 1/);
  assert.throws(
    () => threadWeb.addNote(db, project, thread, { quote: 'q', noteKind: 'guess' as never }),
    /unknown note kind/,
  );
  assert.throws(() => threadWeb.addNote(db, project, 99999, { quote: 'q' }), /no thread/);
  db.close();
});

test('a correction is a new row and leaves the original byte-identical', () => {
  const { db, project, mara, chunkOne } = setup('thread-correction');
  threadWeb.syncThreads(db, project);
  const thread = threadIdOf(db, project, 'person', mara, null);
  const first = threadWeb.addNote(db, project, thread, {
    chunkId: chunkOne,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate.',
    claim: 'old claim',
    strength: 0.3,
  });
  const before = db.get<Record<string, unknown>>('SELECT * FROM canon_thread_note WHERE id = ?', first)!;

  const second = threadWeb.addNote(db, project, thread, {
    chunkId: chunkOne,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate.',
    claim: 'the meeting was a handover',
    noteKind: 'correction',
    supersedesNoteId: first,
    strength: 0.6,
  });
  const after = db.get<Record<string, unknown>>('SELECT * FROM canon_thread_note WHERE id = ?', first)!;
  assert.deepEqual(after, before, 'the superseded note is untouched, byte for byte');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note')!.n, 2);

  const correction = db.get<{ supersedes_note_id: number; note_kind: string }>(
    'SELECT supersedes_note_id, note_kind FROM canon_thread_note WHERE id = ?',
    second,
  )!;
  assert.equal(correction.supersedes_note_id, first);
  assert.equal(correction.note_kind, 'correction');
  db.close();
});

test('there is no update or delete path for notes', () => {
  const exported = Object.keys(threadWeb);
  assert.ok(!exported.some((name) => /updateNote|deleteNote|editNote/.test(name)), exported.join(','));
  // A correction always adds a row; the module never issues an UPDATE on the table.
  const source = String(threadWeb.addNote);
  assert.ok(!/UPDATE\s+canon_thread_note/i.test(source));
});

test('resolveOpenEnd links the note, preserves it, and is idempotent', () => {
  const { db, project, mara, chunkOne } = setup('thread-open-end');
  threadWeb.syncThreads(db, project);
  const thread = threadIdOf(db, project, 'person', mara, null);
  const end = threadWeb.addOpenEnd(db, project, thread, {
    question: 'Did the gate meeting settle anything?',
    origin: 'first pass over the opening',
    wouldResolve: 'a later passage about the keys',
  });
  const note = threadWeb.addNote(db, project, thread, {
    chunkId: chunkOne,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate.',
    claim: 'the meeting settled nothing',
    why: 'they argue afterwards',
    strength: 0.5,
  });
  const noteBefore = db.get<Record<string, unknown>>('SELECT * FROM canon_thread_note WHERE id = ?', note)!;

  assert.equal(threadWeb.resolveOpenEnd(db, end, note), true);
  const resolved = db.get<{ status: string; resolved_by_note_id: number; resolved_at: string }>(
    'SELECT status, resolved_by_note_id, resolved_at FROM canon_open_end WHERE id = ?',
    end,
  )!;
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolved_by_note_id, note);
  assert.ok(resolved.resolved_at.length > 0);
  assert.deepEqual(
    db.get<Record<string, unknown>>('SELECT * FROM canon_thread_note WHERE id = ?', note)!,
    noteBefore,
    'resolving never edits the note',
  );

  // Documented choice: the first resolution wins; a retry changes nothing.
  assert.equal(threadWeb.resolveOpenEnd(db, end, note), false);
  const again = db.get<{ status: string; resolved_at: string }>(
    'SELECT status, resolved_at FROM canon_open_end WHERE id = ?',
    end,
  )!;
  assert.equal(again.status, 'resolved');
  assert.equal(again.resolved_at, resolved.resolved_at);
  db.close();
});

test('listThreads puts note-rich threads first and filters by kind', () => {
  const { db, project, mara, corin, chunkOne, chunkThree } = setup('thread-list');
  threadWeb.syncThreads(db, project);
  const pair = threadIdOf(db, project, 'pair', Math.min(mara, corin), Math.max(mara, corin));
  const person = threadIdOf(db, project, 'person', mara, null);
  for (const [i, chunk] of [chunkOne, chunkThree].entries()) {
    threadWeb.addNote(db, project, pair, {
      chunkId: chunk,
      locator: `p. ${i + 1}`,
      quote: `Mara Voss and Corin Hale, passage ${i + 1}.`,
      strength: 0.5,
    });
  }

  const all = threadWeb.listThreads(db, project);
  assert.equal(all[0]!.id, pair, 'richest evidence first');
  assert.equal(all[0]!.noteCount, 2);
  assert.equal(all[0]!.aName, 'Mara Voss');
  assert.equal(all[0]!.bName, 'Corin Hale');

  const people = threadWeb.listThreads(db, project, { kind: 'person' });
  assert.equal(people.length, 3);
  assert.ok(people.every((t) => t.kind === 'person'));
  assert.ok(people.some((t) => t.id === person));

  const limited = threadWeb.listThreads(db, project, { limit: 1 });
  assert.equal(limited.length, 1);
  assert.equal(limited[0]!.id, pair);
  db.close();
});

test('threadsForRead prefers unresolved questions, then thin evidence', () => {
  const { db, project, mara, corin, chunkOne } = setup('thread-for-read');
  threadWeb.syncThreads(db, project);
  const pair = threadIdOf(db, project, 'pair', Math.min(mara, corin), Math.max(mara, corin));
  const person = threadIdOf(db, project, 'person', mara, null);
  threadWeb.addNote(db, project, person, {
    chunkId: chunkOne,
    locator: 'p. 1',
    quote: 'a first observation',
    strength: 0.5,
  });
  threadWeb.addOpenEnd(db, project, pair, { question: 'What are they to each other?' });

  const rows = threadWeb.threadsForRead(db, project, { limit: 2 });
  assert.equal(rows[0]!.id, pair, 'the thread with an open question comes first');
  assert.equal(rows[0]!.openEndCount, 1);
  assert.equal(rows[1]!.noteCount, 0, 'then the thinnest evidence, not the noted thread');

  const all = threadWeb.threadsForRead(db, project);
  const at = (id: number): number => all.findIndex((row) => row.id === id);
  assert.ok(at(pair) < at(person), 'an unanswered question outranks gathered evidence');
  assert.ok(
    all.filter((row) => row.noteCount === 0).every((row) => at(row.id) < at(person)),
    'the noted thread sorts after every empty thread',
  );
  db.close();
});

test('loadThread returns passages in seq order', () => {
  const { db, project, mara, chunkOne, chunkThree } = setup('thread-passages');
  threadWeb.syncThreads(db, project);
  const thread = threadIdOf(db, project, 'person', mara, null);
  // Insert out of order on purpose.
  db.run(
    'INSERT INTO canon_thread_passage (thread_id, chunk_id, seq, first_seen_at) VALUES (?, ?, 3, ?)',
    thread,
    chunkThree,
    AT,
  );
  db.run(
    'INSERT INTO canon_thread_passage (thread_id, chunk_id, seq, first_seen_at) VALUES (?, ?, 1, ?)',
    thread,
    chunkOne,
    AT,
  );
  const loaded = threadWeb.loadThread(db, project, thread)!;
  assert.deepEqual(
    loaded.passages.map((p) => p.seq),
    [1, 3],
  );
  assert.equal(loaded.passages[0]!.locator, 'p. 1');
  assert.deepEqual(
    loaded.passages.map((p) => p.chunkId),
    [chunkOne, chunkThree],
  );
  db.close();
});

test('loadThread is scoped to its project and reports unknown ids as null', () => {
  const { db, project, mara } = setup('thread-scope');
  threadWeb.syncThreads(db, project);
  const thread = threadIdOf(db, project, 'person', mara, null);
  assert.equal(threadWeb.loadThread(db, project + 999, thread), null);
  assert.equal(threadWeb.loadThread(db, project, 987654), null);
  db.close();
});

test('migration 20 is additive on a v19 database and reruns as a no-op', () => {
  const { db } = tempDb();
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 26);
  for (const table of ['canon_thread', 'canon_thread_passage', 'canon_thread_note', 'canon_open_end']) {
    assert.ok(tableExists(db.raw, table), `fresh bank has ${table}`);
  }

  const project = createProject(db, 'thread-migrate');
  const person = addEntity(db, project.id, 'Mara Voss');
  const other = addEntity(db, project.id, 'Corin Hale');
  const source = addSource(db, project.id);
  addChunk(db, project.id, source, 1, 'Mara Voss met Corin Hale.');
  buildPairThreads(db, project.id);
  threadWeb.syncThreads(db, project.id);
  const before = {
    threads: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread')!.n,
    pairs: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_pair_thread')!.n,
    entities: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity')!.n,
  };
  assert.equal(before.threads, 3);

  // Roll the version back and drop only the four new tables: a v19 bank.
  // Foreign keys are suspended for the simulation only: canon_open_end refers
  // to itself, and SQLite refuses the drop while that constraint is enforced.
  db.raw.exec('PRAGMA foreign_keys = OFF');
  for (const table of ['canon_open_end', 'canon_thread_note', 'canon_thread_passage', 'canon_thread']) {
    db.raw.exec(`DROP TABLE ${table}`);
  }
  db.raw.exec('PRAGMA user_version = 19');
  db.raw.exec('PRAGMA foreign_keys = ON');
  assert.equal(tableExists(db.raw, 'canon_thread'), false);

  assert.equal(runMigrations(db.raw), 26);
  for (const table of ['canon_thread', 'canon_thread_passage', 'canon_thread_note', 'canon_open_end']) {
    assert.ok(tableExists(db.raw, table), `${table} is recreated additively`);
  }
  assert.deepEqual(
    {
      pairs: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_pair_thread')!.n,
      entities: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity')!.n,
    },
    { pairs: before.pairs, entities: before.entities },
    'existing data survives the migration',
  );
  assert.ok(db.get<{ id: number }>('SELECT id FROM canon_entity WHERE id = ?', person));
  assert.ok(db.get<{ id: number }>('SELECT id FROM canon_entity WHERE id = ?', other));

  assert.equal(runMigrations(db.raw), 26, 'second run stays at 25');
  db.close();
});

test('the thread identity key refuses a duplicate person thread', () => {
  const { db, project, mara } = setup('thread-unique');
  threadWeb.syncThreads(db, project);
  assert.throws(
    () =>
      db.run(
        `INSERT INTO canon_thread (project_id, kind, a_entity, b_entity, status, birth_reason, created_at, updated_at)
         VALUES (?, 'person', ?, NULL, 'open', '', ?, ?)`,
        project,
        mara,
        AT,
        AT,
      ),
    /UNIQUE/i,
  );
  db.close();
});
