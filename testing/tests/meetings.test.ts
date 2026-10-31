/**
 * Evidence web, milestone 2: meetings, scoped sharing, births.
 * Invented names only; no model, no book text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { buildPairThreads } from '../../fanfable/src/web/pair-threads.ts';
import { runMigrations, tableExists } from '../../fanfable/src/core/migrations.ts';
import * as threadWeb from '../../fanfable/src/web/threads.ts';
import * as meetingWeb from '../../fanfable/src/web/meetings.ts';
import { tempDb } from './helpers.ts';
import { Db as SqliteDb } from '../../fanfable/src/core/db.ts';
import { resolve } from 'node:path';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(db: Db, projectId: number, name: string, opts: { kind?: string; reviewStatus?: string } = {}): number {
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
      '/meeting-source',
      'Probe',
      'sha-meeting',
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

/** Two people who share passages, so a pair thread exists. */
function setup(name: string, chunkCount = 6) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const source = addSource(db, project.id);
  const mara = addEntity(db, project.id, 'Mara Voss');
  const corin = addEntity(db, project.id, 'Corin Hale');
  const chunks: number[] = [];
  for (let i = 0; i < chunkCount; i++) {
    chunks.push(addChunk(db, project.id, source, i + 1, `Mara Voss met Corin Hale at the gate ${i + 1}.`));
  }
  buildPairThreads(db, project.id);
  threadWeb.syncThreads(db, project.id);
  const pair = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' AND a_entity = ? AND b_entity = ?",
    project.id,
    Math.min(mara, corin),
    Math.max(mara, corin),
  )!.id;
  const personMara = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'person' AND a_entity = ? AND b_entity IS NULL",
    project.id,
    mara,
  )!.id;
  const personCorin = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'person' AND a_entity = ? AND b_entity IS NULL",
    project.id,
    corin,
  )!.id;
  return { db, project: project.id, mara, corin, pair, personMara, personCorin, chunks };
}

function addEvent(db: Db, projectId: number, sourceId: number, chunkId: number, title: string): number {
  return Number(
    db.run(
      `INSERT INTO canon_event (project_id, source_id, chunk_id, locator, title, summary, quote, created_at)
       VALUES (?, ?, ?, '', ?, '', '', ?)`,
      projectId,
      sourceId,
      chunkId,
      title,
      AT,
    ).lastInsertRowid,
  );
}

test('combineSupport is one minus the product, with independence damping', () => {
  assert.deepEqual(meetingWeb.combineSupport([]), { score: 0, independent: 0 });
  const single = meetingWeb.combineSupport([{ strength: 0.4, seq: 10 }]);
  assert.ok(Math.abs(single.score - 0.4) < 1e-9);
  assert.equal(single.independent, 1);

  const two = meetingWeb.combineSupport([
    { strength: 0.4, seq: 10 },
    { strength: 0.8, seq: 20 },
  ]);
  assert.ok(Math.abs(two.score - 0.88) < 1e-9, `expected 0.88, got ${two.score}`);

  // Same chunk twice: counted once, at the higher strength.
  const dupes = meetingWeb.combineSupport([
    { strength: 0.4, seq: 10 },
    { strength: 0.9, seq: 10 },
  ]);
  assert.ok(Math.abs(dupes.score - 0.9) < 1e-9);
  assert.equal(dupes.independent, 1);

  // Adjacent chunks are not independent: each counts at half.
  // 1 - (0.6 * 0.6) = 0.64.
  const adjacent = meetingWeb.combineSupport([
    { strength: 0.8, seq: 10 },
    { strength: 0.8, seq: 11 },
  ]);
  assert.ok(Math.abs(adjacent.score - 0.64) < 1e-9, `expected 0.64, got ${adjacent.score}`);

  // Far apart: full weight.
  const apart = meetingWeb.combineSupport([
    { strength: 0.5, seq: 10 },
    { strength: 0.5, seq: 40 },
  ]);
  assert.ok(Math.abs(apart.score - 0.75) < 1e-9);
});

test('significant tokens drop stopwords and punctuation, and overlap is sorted', () => {
  assert.deepEqual(meetingWeb.significantTokens('The KEYS, and the gate!'), ['keys', 'gate']);
  assert.deepEqual(meetingWeb.matchedTokens('the keys at the gate', 'who holds the gate keys'), ['gate', 'keys']);
  assert.deepEqual(meetingWeb.matchedTokens('nothing shared here', 'a distant question'), []);
});

test('matching is deterministic and normalized, never by name string', () => {
  const { db, project, pair, personMara, personCorin } = setup('meeting-match');
  const candidates = meetingWeb.candidateMeetings(db, project);

  // A pair thread meets each of its endpoints' person threads, and nothing else.
  const keys = candidates.map((c) => `${c.matchKind}:${c.threadA}|${c.threadB}`);
  assert.ok(keys.includes(`shared_person:${Math.min(personMara, pair)}|${Math.max(personMara, pair)}`));
  assert.ok(keys.includes(`shared_person:${Math.min(personCorin, pair)}|${Math.max(personCorin, pair)}`));
  assert.ok(candidates.every((c) => c.threadA < c.threadB), 'every meeting is normalized');
  assert.ok(
    !candidates.some((c) => c.threadA === personMara && c.threadB === personCorin),
    'two unrelated person threads never meet',
  );
  // Re-running the enumeration gives the identical list.
  assert.deepEqual(meetingWeb.candidateMeetings(db, project), candidates);
  db.close();
});

test('two threads about one pair meet as shared_pair once a child exists', () => {
  const { db, project, pair } = setup('meeting-shared-pair');
  const child = addPeriodThread(db, pair, 'p2', 60);
  const candidates = meetingWeb.candidateMeetings(db, project);
  const shared = candidates.filter((c) => c.matchKind === 'shared_pair');
  assert.equal(shared.length, 1);
  const pairRow = db.get<{ a_entity: number; b_entity: number }>(
    'SELECT a_entity, b_entity FROM canon_thread WHERE id = ?',
    pair,
  )!;
  assert.equal(
    shared[0]!.matchKey,
    `pair:${Math.min(pairRow.a_entity, pairRow.b_entity)}:${Math.max(pairRow.a_entity, pairRow.b_entity)}`,
  );
  assert.ok([shared[0]!.threadA, shared[0]!.threadB].includes(child));
  // Both threads about the same pair are also both endpoints' person subjects;
  // the pair subject must win, so they meet exactly once.
  assert.equal(
    candidates.filter((c) => c.threadA === Math.min(child, pair) && c.threadB === Math.max(child, pair)).length,
    1,
  );
  db.close();
});

test('meetingRelevance derives scope from the thread kind', () => {
  const fromPerson = meetingWeb.meetingRelevance('person:7', 'person:7');
  assert.equal(fromPerson.relevant, true);
  assert.equal(fromPerson.scope, 'identity');

  const pairToPerson = meetingWeb.meetingRelevance('pair:7:9', 'person:7');
  assert.equal(pairToPerson.relevant, true);
  assert.equal(pairToPerson.scope, 'pair');

  const unrelated = meetingWeb.meetingRelevance('pair:7:9', 'person:4');
  assert.equal(unrelated.relevant, false);
});

test('running meetings is idempotent and revision moves only on new evidence', () => {
  const { db, project, pair, chunks } = setup('meeting-idempotent');
  // Two periods of the same pair give the meeting two sides of pair evidence.
  const later = Number(
    db.run(
      `INSERT INTO canon_thread
         (project_id, kind, a_entity, b_entity, status, birth_reason, period_label,
          period_from_seq, period_to_seq, temporal_status, created_at, updated_at)
       SELECT project_id, kind, a_entity, b_entity, 'open', '', 'p2', 50, 50, 'current', created_at, updated_at
         FROM canon_thread WHERE id = ?`,
      pair,
    ).lastInsertRowid,
  );
  threadWeb.addNote(db, project, pair, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate 1.',
    claim: 'they meet at the gate',
    strength: 0.5,
  });
  threadWeb.addNote(db, project, later, {
    chunkId: chunks[1]!,
    locator: 'p. 2',
    quote: 'Mara Voss met Corin Hale at the gate 2.',
    claim: 'they meet again later',
    strength: 0.5,
  });
  const first = meetingWeb.runMeetings(db, project);
  assert.equal(first.meetingsCreated, 1, 'only the crossing pair meeting is recorded');
  assert.equal(first.exchangesAdded, 2);
  // Two periods of one pair with a note each is a combined investigation.
  assert.equal(first.birthsCreated, 1);
  assert.equal(first.birthsByTrigger.combined_investigation, 1);

  const before = db.get<{ revision: number; notes_exchanged: number }>(
    'SELECT COALESCE(SUM(revision), 0) AS revision, COALESCE(SUM(notes_exchanged), 0) AS notes_exchanged FROM canon_meeting WHERE project_id = ?',
    project,
  )!;
  const second = meetingWeb.runMeetings(db, project);
  assert.equal(second.meetingsCreated, 0);
  assert.equal(second.exchangesAdded, 0);
  assert.equal(second.wantsResolved, 0);
  assert.equal(second.birthsCreated, 0);
  const after = db.get<{ revision: number; notes_exchanged: number }>(
    'SELECT COALESCE(SUM(revision), 0) AS revision, COALESCE(SUM(notes_exchanged), 0) AS notes_exchanged FROM canon_meeting WHERE project_id = ?',
    project,
  )!;
  assert.deepEqual(after, before, 'same evidence leaves the meetings untouched');

  // New evidence on one side appends exactly one exchange and bumps revision once.
  threadWeb.addNote(db, project, later, {
    chunkId: chunks[2]!,
    locator: 'p. 3',
    quote: 'Mara Voss met Corin Hale at the gate 3.',
    claim: 'they keep meeting through the year',
    strength: 0.4,
  });
  const third = meetingWeb.runMeetings(db, project);
  assert.equal(third.meetingsCreated, 0);
  assert.equal(third.exchangesAdded, 1);
  const bumped = db.get<{ revision: number }>(
    'SELECT COALESCE(SUM(revision), 0) AS revision FROM canon_meeting WHERE project_id = ?',
    project,
  )!;
  assert.equal(bumped.revision, before.revision + 1);
  db.close();
});

test('an identity note resolves a want but never raises birth support', () => {
  const { db, project, pair, personMara, chunks } = setup('meeting-scope');
  const want = threadWeb.addOpenEnd(db, project, pair, {
    question: 'Who holds the gate keys?',
    wouldResolve: 'a passage about the gate keys',
  });
  threadWeb.addNote(db, project, personMara, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss held the gate keys.',
    claim: 'mara holds the gate keys',
    strength: 0.95,
  });

  const result = meetingWeb.runMeetings(db, project);
  assert.equal(result.wantsResolved, 1, 'the want is answered on the spot');
  assert.equal(result.birthsCreated, 0, 'identity evidence never births');
  const end = db.get<{ status: string; resolved_by_note_id: number }>(
    'SELECT status, resolved_by_note_id FROM canon_open_end WHERE id = ?',
    want,
  )!;
  assert.equal(end.status, 'resolved');
  assert.ok(end.resolved_by_note_id > 0);

  const meeting = meetingWeb.listMeetings(db, project)[0]!;
  const loaded = meetingWeb.loadMeeting(db, project, meeting.id)!;
  assert.equal(loaded.exchanges[0]!.scope, 'identity');
  assert.equal(loaded.child, null, 'no child from identity-only sharing');
  db.close();
});

test('resolved_want refuses to copy a parent, and says why', () => {
  const { db, project, pair, personMara, chunks } = setup('meeting-trigger-want');
  threadWeb.addOpenEnd(db, project, personMara, {
    question: 'What do they owe each other?',
    wouldResolve: 'a passage about the sworn oath between them',
  });
  threadWeb.addNote(db, project, pair, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss swore an oath to Corin Hale.',
    claim: 'the sworn oath binds them',
    strength: 0.6,
  });

  const result = meetingWeb.runMeetings(db, project);
  assert.equal(result.wantsResolved, 1);
  // The evidence points at a pair that is already one of the parents, so a
  // child would be a copy of an existing investigation, not a new one.
  assert.equal(result.birthsCreated, 0);
  assert.equal(result.birthsRefused['child-equals-parent'], 1);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_birth WHERE project_id = ?', project)!.n,
    0,
  );
  db.close();
});

test('one-sided pair evidence never births', () => {
  const { db, project, pair, personMara, chunks } = setup('meeting-one-sided', 8);
  // Pair-scope evidence exists on one side only.
  threadWeb.addNote(db, project, pair, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate 1.',
    claim: 'they keep meeting',
    strength: 0.9,
  });

  // A want on the person thread makes the two threads meet, but identity
  // evidence can never stand in for the missing side of pair evidence.
  threadWeb.addOpenEnd(db, project, personMara, {
    question: 'Anything about the ledger?',
    wouldResolve: 'a passage about the ledger',
  });

  const result = meetingWeb.runMeetings(db, project, { minConfidence: 0.7 });
  assert.equal(result.birthsCreated, 0, 'one-sided pair evidence cannot birth');
  assert.ok(result.meetingsRefused > 0, 'the one-sided candidate is refused outright');
  assert.ok(result.refusedByReason['one-sided'] > 0, 'and tallied as one-sided');
  const births = db.all<{ trigger: string }>('SELECT trigger FROM canon_birth WHERE project_id = ?', project);
  assert.deepEqual(births, []);
  db.close();
});

test('below-threshold evidence on one passage is refused, not combined', () => {
  const { db, project, pair, chunks } = setup('meeting-below-threshold', 10);
  const child = addPeriodThread(db, pair, 'p2', 60);
  // Both notes cite the SAME passage, so they are not independent evidence and
  // the combined-investigation trigger cannot fire either.
  threadWeb.addNote(db, project, pair, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate 1.',
    claim: 'they keep meeting',
    strength: 0.2,
  });
  threadWeb.addNote(db, project, child, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate 1.',
    claim: 'they keep meeting',
    strength: 0.2,
  });

  const result = meetingWeb.runMeetings(db, project, { minConfidence: 0.7, minAdmissionStrength: 0 });
  // 1 - (0.8 * 0.8) = 0.36, well under the bar, and only one independent note.
  assert.equal(result.birthsCreated, 0);
  assert.ok(result.birthsSkipped['below-threshold'] > 0);
  db.close();
});

test('pooled_evidence refuses a child that would copy its parent', () => {
  const { db, project, pair, chunks } = setup('meeting-pooled-fire', 10);
  // Two pair threads about one unordered pair meet as shared_pair; each has
  // pair-scope evidence that alone stays under the bar.
  const child = addPeriodThread(db, pair, 'p2', 60);
  threadWeb.addNote(db, project, pair, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate 1.',
    claim: 'they keep meeting',
    strength: 0.55,
  });
  threadWeb.addNote(db, project, child, {
    chunkId: chunks[8]!,
    locator: 'p. 9',
    quote: 'Mara Voss met Corin Hale at the gate 9.',
    claim: 'they keep meeting',
    strength: 0.6,
  });

  const result = meetingWeb.runMeetings(db, project, { minConfidence: 0.7, minAdmissionStrength: 0 });
  // 1 - (0.45 * 0.4) = 0.82 clears the bar, but the only subject the evidence
  // identifies is the pair already under investigation.
  assert.equal(result.birthsCreated, 0);
  assert.equal(result.birthsRefused['child-equals-parent'], 1);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_birth WHERE project_id = ?', project)!.n,
    0,
  );
  db.close();
});

test('shared_event births when both parents cite the same event', () => {
  const { db, project, pair, chunks } = setup('meeting-trigger-event', 6);
  const source = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ?', project)!.id;
  addEvent(db, project, source, chunks[2]!, 'the gate scene');

  // Two periods of the pair: both sides carry pair-scope clues, and both point
  // at the same event, so the meeting is admitted and the event trigger fires.
  const later = Number(
    db.run(
      `INSERT INTO canon_thread
         (project_id, kind, a_entity, b_entity, status, birth_reason, period_label,
          period_from_seq, period_to_seq, temporal_status, created_at, updated_at)
       SELECT project_id, kind, a_entity, b_entity, 'open', '', 'p2', 50, 50, 'current', created_at, updated_at
         FROM canon_thread WHERE id = ?`,
      pair,
    ).lastInsertRowid,
  );
  threadWeb.addNote(db, project, pair, {
    chunkId: chunks[2]!,
    locator: 'p. 3',
    quote: 'Mara Voss met Corin Hale at the gate 3.',
    claim: 'they are at the gate',
    strength: 0.1,
  });
  threadWeb.addNote(db, project, later, {
    chunkId: chunks[2]!,
    locator: 'p. 3',
    quote: 'Mara Voss met Corin Hale at the gate 3.',
    claim: 'both return to the gate',
    strength: 0.1,
  });

  const result = meetingWeb.runMeetings(db, project, { minAdmissionStrength: 0 });
  // The event trigger fires, but its evidence identifies the pair that is
  // already a parent, so no copy is created.
  assert.equal(result.birthsCreated, 0);
  assert.equal(result.birthsRefused['child-equals-parent'], 1);
  db.close();
});

test('one child per meeting and one birth per lineage', () => {
  const { db, project, pair, chunks } = setup('meeting-guards', 8);
  const later = addPeriodThread(db, pair, 'p2', 60);
  threadWeb.addNote(db, project, pair, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate 1.',
    claim: 'they meet at the gate',
    strength: 0.5,
  });
  threadWeb.addNote(db, project, later, {
    chunkId: chunks[1]!,
    locator: 'p. 2',
    quote: 'Mara Voss met Corin Hale at the gate 2.',
    claim: 'they meet again later',
    strength: 0.5,
  });
  meetingWeb.runMeetings(db, project, { minAdmissionStrength: 0 });
  const firstBirths = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_birth WHERE project_id = ?', project)!.n;
  assert.equal(firstBirths, 1);

  // A second run must not birth again.
  meetingWeb.runMeetings(db, project, { minAdmissionStrength: 0 });
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_birth WHERE project_id = ?', project)!.n, 1);

  // The meeting row holds exactly one child.
  const meeting = db.get<{ child_thread: number }>('SELECT child_thread FROM canon_meeting WHERE project_id = ?', project)!;
  assert.ok(meeting.child_thread > 0);

  // Duplicate lineage is refused by the schema itself.
  assert.throws(
    () =>
      db.run(
        `INSERT INTO canon_birth
           (project_id, meeting_id, parent_a_thread, parent_b_thread, child_thread, trigger, combined_score, reason, created_at)
         VALUES (?, ?, ?, ?, ?, 'combined_investigation', 0, 'dup', ?)`,
        project,
        db.get<{ id: number }>('SELECT id FROM canon_meeting WHERE project_id = ?', project)!.id,
        db.get<{ parent_a_thread: number }>('SELECT parent_a_thread FROM canon_birth WHERE project_id = ?', project)!.parent_a_thread,
        db.get<{ parent_b_thread: number }>('SELECT parent_b_thread FROM canon_birth WHERE project_id = ?', project)!.parent_b_thread,
        db.get<{ child_thread: number }>('SELECT child_thread FROM canon_birth WHERE project_id = ?', project)!.child_thread,
        AT,
      ),
    /UNIQUE/i,
  );
  db.close();
});

test('a birth references pooled notes and copies nothing', () => {
  const { db, project, pair, chunks } = setup('meeting-refs', 8);
  const later = addPeriodThread(db, pair, 'p2', 60);
  threadWeb.addOpenEnd(db, project, pair, {
    question: 'What binds them?',
    wouldResolve: 'the oath passage about the sworn bond',
  });
  const noteId = threadWeb.addNote(db, project, pair, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate 1.',
    claim: 'they meet at the gate',
    strength: 0.8,
  });
  const secondNote = threadWeb.addNote(db, project, later, {
    chunkId: chunks[1]!,
    locator: 'p. 2',
    quote: 'Mara Voss met Corin Hale at the gate 2.',
    claim: 'they meet again later',
    strength: 0.8,
  });
  const noteBefore = db.get<Record<string, unknown>>('SELECT * FROM canon_thread_note WHERE id = ?', noteId)!;
  const notesBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note WHERE project_id = ?', project)!.n;
  const relationsBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project)!.n;

  meetingWeb.runMeetings(db, project, { minAdmissionStrength: 0 });
  const child = db.get<{ child_thread: number }>('SELECT child_thread FROM canon_birth WHERE project_id = ?', project)!.child_thread;

  assert.deepEqual(
    db.get<Record<string, unknown>>('SELECT * FROM canon_thread_note WHERE id = ?', noteId)!,
    noteBefore,
    'the pooled note is unchanged',
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note WHERE project_id = ?', project)!.n,
    notesBefore,
    'no note was copied into the child',
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', project)!.n,
    relationsBefore,
    'no relation was written',
  );
  const ref = db.get<{ note_id: number; role: string }>(
    'SELECT note_id, role FROM canon_thread_note_ref WHERE thread_id = ? ORDER BY note_id',
    child,
  )!;
  assert.ok([noteId, secondNote].includes(ref.note_id));
  assert.equal(ref.role, 'pooled');
  // The parent keeps its own note.
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note WHERE thread_id = ?', pair)!.n, 1);
  const loaded = threadWeb.loadThread(db, project, child)!;
  assert.equal(loaded.noteRefs.length, 2);
  assert.deepEqual(
    loaded.noteRefs.map((r) => r.noteId),
    [noteId, secondNote].sort((a, b) => a - b),
  );
  assert.equal(loaded.notes.length, 0, 'referenced, not copied');
  assert.ok(loaded.parents.a, 'parentage is loaded');
  assert.ok(loaded.birth, 'birth provenance is loaded');
  db.close();
});

test('a changed resolution appends and marks the earlier one superseded', () => {
  const { db, project, pair, personMara, chunks } = setup('meeting-resolution-change', 8);
  const want = threadWeb.addOpenEnd(db, project, personMara, {
    question: 'Who holds the gate keys and the ledger?',
    wouldResolve: 'a passage about the gate keys and the ledger',
  });
  // First answer: two matching tokens.
  threadWeb.addNote(db, project, pair, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss holds the gate keys.',
    claim: 'gate keys with mara',
    strength: 0.5,
  });
  meetingWeb.runMeetings(db, project, { minAdmissionStrength: 0 });
  const first = db.get<{ id: number; resolved_by_note_id: number }>(
    'SELECT id, resolved_by_note_id FROM canon_meeting_resolution WHERE open_end_id = ?',
    want,
  )!;

  // A stronger answer later: four matching tokens.
  threadWeb.addNote(db, project, pair, {
    chunkId: chunks[4]!,
    locator: 'p. 5',
    quote: 'The gate keys and the ledger stayed with Mara Voss.',
    claim: 'the gate keys and the ledger belong to mara',
    strength: 0.6,
  });
  meetingWeb.runMeetings(db, project, { minAdmissionStrength: 0 });

  const rows = db.all<{ id: number; superseded_by: number | null; resolved_by_note_id: number }>(
    'SELECT id, superseded_by, resolved_by_note_id FROM canon_meeting_resolution WHERE open_end_id = ? ORDER BY id',
    want,
  );
  assert.equal(rows.length, 2, 'a changed resolution appends a row');
  assert.equal(rows[0]!.id, first.id);
  assert.equal(rows[0]!.superseded_by, rows[1]!.id, 'the earlier row points at its replacement');
  assert.equal(rows[1]!.superseded_by, null);
  assert.notEqual(rows[1]!.resolved_by_note_id, first.resolved_by_note_id);
  // The earlier row is preserved, not rewritten.
  assert.equal(rows[0]!.resolved_by_note_id, first.resolved_by_note_id);
  db.close();
});

test('migration 21 is additive on a v20 database and reruns as a no-op', () => {
  const { db } = tempDb();
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 26);
  for (const table of ['canon_meeting', 'canon_meeting_exchange', 'canon_meeting_resolution', 'canon_birth', 'canon_thread_note_ref']) {
    assert.ok(tableExists(db.raw, table), `fresh bank has ${table}`);
  }
  assert.ok(
    db.all<{ name: string }>('PRAGMA table_info(canon_open_end)').some((row) => row.name === 'carried_from_open_end_id'),
    'the carried-want column exists',
  );

  const project = createProject(db, 'meeting-migrate');
  const mara = addEntity(db, project.id, 'Mara Voss');
  const corin = addEntity(db, project.id, 'Corin Hale');
  const source = addSource(db, project.id);
  addChunk(db, project.id, source, 1, 'Mara Voss met Corin Hale.');
  buildPairThreads(db, project.id);
  threadWeb.syncThreads(db, project.id);
  const before = {
    threads: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread')!.n,
    pairs: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_pair_thread')!.n,
    entities: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity')!.n,
  };

  // Roll back to a v20 bank: drop the five new tables, remove the added column
  // by recreating canon_open_end, and restore the M1 identity index. Foreign
  // keys are suspended for the simulation only (canon_open_end refers to itself).
  db.raw.exec('PRAGMA foreign_keys = OFF');
  for (const table of ['canon_thread_note_ref', 'canon_birth', 'canon_meeting_resolution', 'canon_meeting_exchange', 'canon_meeting']) {
    db.raw.exec(`DROP TABLE ${table}`);
  }
  db.raw.exec('DROP INDEX IF EXISTS canon_thread_identity');
  db.raw.exec('DROP INDEX IF EXISTS canon_thread_root_identity');
  db.raw.exec('DROP INDEX IF EXISTS canon_thread_period');
  db.raw.exec('DROP INDEX canon_thread_born_identity');
  db.raw.exec('CREATE UNIQUE INDEX canon_thread_identity ON canon_thread(project_id, kind, a_entity, COALESCE(b_entity, 0))');
  db.raw.exec('ALTER TABLE canon_open_end DROP COLUMN carried_from_open_end_id');
  db.raw.exec('PRAGMA user_version = 20');
  db.raw.exec('PRAGMA foreign_keys = ON');
  assert.equal(tableExists(db.raw, 'canon_meeting'), false);

  assert.equal(runMigrations(db.raw), 26);
  for (const table of ['canon_meeting', 'canon_meeting_exchange', 'canon_meeting_resolution', 'canon_birth', 'canon_thread_note_ref']) {
    assert.ok(tableExists(db.raw, table), `${table} is recreated additively`);
  }
  assert.deepEqual(
    {
      pairs: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_pair_thread')!.n,
      entities: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity')!.n,
    },
    { pairs: before.pairs, entities: before.entities },
    'existing data survives',
  );
  assert.ok(db.get<{ id: number }>('SELECT id FROM canon_entity WHERE id = ?', mara));
  assert.ok(db.get<{ id: number }>('SELECT id FROM canon_entity WHERE id = ?', corin));
  assert.equal(runMigrations(db.raw), 26, 'second run stays at 25');
  db.close();
});

test('a root thread still cannot duplicate its subject', () => {
  const { db, project, mara } = setup('meeting-root-unique');
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

/* ------------------------------------------- part B: admission and reconcile */

/** A second period thread for the same pair, so a meeting has two pair sides. */
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

test('admission needs pair evidence from both sides; one side is refused', () => {
  const { db, project, pair, chunks } = setup('admit-one-sided', 6);
  const later = addPeriodThread(db, pair, 'p2', 60);
  threadWeb.addNote(db, project, pair, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate 1.',
    claim: 'they meet at the gate',
    strength: 0.5,
  });

  const first = meetingWeb.runMeetings(db, project, { minAdmissionStrength: 0 });
  assert.equal(first.meetingsCreated, 0, 'one side alone is not a meeting');
  assert.ok(first.refusedByReason['one-sided'] >= 1);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_meeting WHERE project_id = ?', project)!.n, 0);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_meeting_exchange')!.n,
    0,
    'a refused candidate leaves no exchange rows',
  );

  // New evidence on the other side admits it, exactly once.
  threadWeb.addNote(db, project, later, {
    chunkId: chunks[1]!,
    locator: 'p. 2',
    quote: 'Mara Voss met Corin Hale at the gate 2.',
    claim: 'they meet again later',
    strength: 0.5,
  });
  const second = meetingWeb.runMeetings(db, project, { minAdmissionStrength: 0 });
  assert.equal(second.meetingsCreated, 1);
  const third = meetingWeb.runMeetings(db, project, { minAdmissionStrength: 0 });
  assert.equal(third.meetingsCreated, 0, 'admission happens once');
  assert.equal(third.exchangesAdded, 0);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_meeting WHERE project_id = ?', project)!.n, 1);
  db.close();
});

test('identity-only meetings are refused unless the flag is set', () => {
  const { db, project, pair, personMara, chunks } = setup('admit-identity', 4);
  threadWeb.addNote(db, project, personMara, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate 1.',
    claim: 'mara is a keeper',
    strength: 0.8,
  });
  // A context note on the pair thread is sharing, not evidence.
  threadWeb.addNote(db, project, pair, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate 1.',
    claim: 'mara and corin share a passage',
    strength: 0,
    isContext: true,
    noteKind: 'context',
  });

  const refused = meetingWeb.runMeetings(db, project, { minAdmissionStrength: 0 });
  assert.equal(refused.meetingsCreated, 0);
  assert.ok(refused.refusedByReason['identity-only'] >= 1);

  const admitted = meetingWeb.runMeetings(db, project, { includeIdentityOnly: true });
  assert.ok(admitted.meetingsCreated >= 1, 'the opt-in admits identity-only sharing');
  db.close();
});

test('a candidate with no shared notes at all leaves nothing behind', () => {
  const { db, project } = setup('admit-empty');
  const result = meetingWeb.runMeetings(db, project, { minAdmissionStrength: 0 });
  assert.equal(result.meetingsCreated, 0);
  // With the note filter, such a candidate never reaches admission at all.
  assert.ok(result.candidatesSkippedNoNotes >= 1);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_meeting WHERE project_id = ?', project)!.n, 0);
  db.close();
});

test('reconciliation reports and deletes only the refused meetings', () => {
  const { db, project, pair, personMara, chunks } = setup('reconcile-fixture', 6);
  const later = addPeriodThread(db, pair, 'p2', 60);
  const noteA = threadWeb.addNote(db, project, pair, {
    chunkId: chunks[0]!,
    locator: 'p. 1',
    quote: 'Mara Voss met Corin Hale at the gate 1.',
    claim: 'they meet at the gate',
    strength: 0.5,
  });
  const noteB = threadWeb.addNote(db, project, later, {
    chunkId: chunks[1]!,
    locator: 'p. 2',
    quote: 'Mara Voss met Corin Hale at the gate 2.',
    claim: 'they meet again later',
    strength: 0.5,
  });
  const identityNote = threadWeb.addNote(db, project, personMara, {
    chunkId: chunks[2]!,
    locator: 'p. 3',
    quote: 'Mara Voss met Corin Hale at the gate 3.',
    claim: 'mara is a keeper',
    strength: 0.8,
  });

  // Build the over-dense state by hand: the old rule recorded every candidate.
  const addMeeting = (a: number, b: number, key: string, kind: string): number =>
    Number(
      db.run(
        `INSERT INTO canon_meeting (project_id, thread_a, thread_b, match_key, match_kind, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
        project,
        a,
        b,
        key,
        kind,
        AT,
        AT,
      ).lastInsertRowid,
    );
  const addExchange = (meeting: number, note: number, direction: string, scope: string): void => {
    db.run(
      `INSERT INTO canon_meeting_exchange (meeting_id, note_id, direction, scope, relevance, created_at)
       VALUES (?, ?, ?, ?, '', ?)`,
      meeting,
      note,
      direction,
      scope,
      AT,
    );
  };

  const crossing = addMeeting(pair, later, `person:1`, 'shared_person');
  addExchange(crossing, noteA, 'a_to_b', 'pair');
  addExchange(crossing, noteB, 'b_to_a', 'pair');

  const identityOnly = addMeeting(pair, personMara, `person:1`, 'shared_person');
  addExchange(identityOnly, identityNote, 'b_to_a', 'identity');

  const oneSided = addMeeting(pair, later, `person:2`, 'shared_person');
  addExchange(oneSided, noteA, 'a_to_b', 'pair');

  const before = ['canon_relation', 'canon_tie_note', 'canon_tie_hint'].map(
    (table) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, project)!.n,
  );
  const notesBefore = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note')!.n;

  const report = meetingWeb.reconcileMeetings(db, project);
  assert.equal(report.examined, 3);
  assert.equal(report.wouldRefuse, 2);
  assert.equal(report.byReason['identity-only'], 1);
  assert.equal(report.byReason['one-sided'], 1);
  assert.equal(report.deleted, 0, 'a report never deletes');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_meeting WHERE project_id = ?', project)!.n, 3);

  const written = meetingWeb.reconcileMeetings(db, project, { write: true });
  assert.equal(written.deleted, 2);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_meeting WHERE project_id = ?', project)!.n, 1);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_meeting_exchange')!.n,
    2,
    'only the crossing meeting keeps its exchanges',
  );
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note')!.n, notesBefore, 'notes untouched');
  assert.deepEqual(
    ['canon_relation', 'canon_tie_note', 'canon_tie_hint'].map(
      (table) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, project)!.n,
    ),
    before,
    'protected tables unchanged',
  );
  db.close();
});

test('reconcile --write refuses a database outside the temp directory', () => {
  const mem = new SqliteDb(':memory:');
  assert.equal(meetingWeb.isTempDatabasePath(':memory:'), false);
  assert.equal(meetingWeb.isTempDatabasePath(resolve('testing/tests/nope.db')), false);
  assert.throws(() => meetingWeb.reconcileMeetings(mem, 1, { write: true }), /refusing --write/);
  mem.close();
});
