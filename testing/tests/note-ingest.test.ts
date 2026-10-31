/**
 * Milestone 3: note ingestion into threads.
 * Invented names only; no book text. Extraction uses a mock provider.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { buildPairThreads } from '../../fanfable/src/web/pair-threads.ts';
import { runMigrations, tableExists } from '../../fanfable/src/core/migrations.ts';
import { syncThreads } from '../../fanfable/src/web/threads.ts';
import { runMeetings, combineSupport } from '../../fanfable/src/web/meetings.ts';
import * as ingest from '../../fanfable/src/web/note-ingest.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(
  db: Db,
  projectId: number,
  name: string,
  opts: { evidence?: string; firstChunk?: number | null; confidence?: number } = {},
): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, summary, attributes, role, status, first_chunk, evidence,
          source_refs, mentions, confidence, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, '[]', '', '{}', '', '', ?, ?, ?, 1, ?, 'accepted', ?, ?)`,
      projectId,
      name,
      opts.firstChunk ?? null,
      opts.evidence ?? '',
      opts.firstChunk ? JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: opts.firstChunk }]) : '[]',
      opts.confidence ?? 1,
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
      '/note-source',
      'Probe',
      'sha-note',
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

const TEXTS = [
  'Mara Voss met Corin Hale at the gate and swore an oath to him.',
  'Corin Hale kept the ledger under the bridge that night.',
  'Mara Voss argued with Tor about the keys.',
  'Tor waited by the wall alone for an hour, until Corin Hale found him.',
];

function setup(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const source = addSource(db, project.id);
  const chunks = TEXTS.map((text, i) => addChunk(db, project.id, source, i + 1, text));
  const mara = addEntity(db, project.id, 'Mara Voss', {
    evidence: 'Mara Voss met Corin Hale at the gate',
    firstChunk: chunks[0]!,
    confidence: 0.9,
  });
  const corin = addEntity(db, project.id, 'Corin Hale', {
    evidence: 'Corin Hale kept the ledger',
    firstChunk: chunks[1]!,
    confidence: 0.8,
  });
  const tor = addEntity(db, project.id, 'Tor', {
    evidence: 'Tor waited by the wall alone',
    firstChunk: chunks[3]!,
    confidence: 0.7,
  });
  buildPairThreads(db, project.id);
  syncThreads(db, project.id);
  return { db, project: project.id, source, chunks, mara, corin, tor };
}

function addRelation(
  db: Db,
  projectId: number,
  rel: {
    from: number;
    to: number;
    kind: string;
    evidence: string;
    chunk: number | null;
    confidence?: number;
    status?: string;
    description?: string;
    supporting?: string;
  },
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
          confidence, review_status, supporting_evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId,
      rel.from,
      rel.to,
      rel.kind,
      rel.description ?? '',
      rel.evidence,
      rel.chunk ? JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: rel.chunk }]) : '[]',
      rel.confidence ?? 0.9,
      rel.status ?? 'accepted',
      rel.supporting ?? '[]',
      AT,
    ).lastInsertRowid,
  );
}

function notes(db: Db, projectId: number): { quote: string; claim: string; is_context: number; strength: number }[] {
  return db.all<{ quote: string; claim: string; is_context: number; strength: number }>(
    'SELECT quote, claim, is_context, strength FROM canon_thread_note WHERE project_id = ? ORDER BY id',
    projectId,
  );
}

test('a quote that is not in its chunk is skipped and never becomes a note', () => {
  const { db, project, mara, corin, chunks } = setup('ingest-verbatim');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'friend',
    evidence: 'a line that was never written anywhere',
    chunk: chunks[0]!,
    confidence: 0.9,
  });
  const counts = ingest.backfillThreadNotes(db, project);
  assert.equal(counts.pairNotes, 0);
  assert.ok(counts.skipped['not-verbatim'] >= 1);
  assert.equal(notes(db, project).filter((n) => n.quote.includes('never written')).length, 0);
  db.close();
});

test('rerunning backfill adds nothing; a different claim on the same quote is allowed', () => {
  const { db, project, mara, corin, chunks } = setup('ingest-dedupe');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'friend',
    evidence: 'Mara Voss met Corin Hale at the gate',
    chunk: chunks[0]!,
  });
  const first = ingest.backfillThreadNotes(db, project);
  assert.equal(first.pairNotes, 1);
  const afterFirst = notes(db, project).length;

  const second = ingest.backfillThreadNotes(db, project);
  assert.equal(second.notes, 0, 'the same passage read twice adds nothing');
  assert.equal(notes(db, project).length, afterFirst);

  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'ally',
    description: 'the meeting was a handover of the keys',
    evidence: 'Mara Voss met Corin Hale at the gate',
    chunk: chunks[0]!,
  });
  const third = ingest.backfillThreadNotes(db, project);
  assert.equal(third.pairNotes, 1, 'a genuinely different claim is a different key');
  assert.equal(notes(db, project).length, afterFirst + 1);
  db.close();
});

test('dedupe keys are a pure function of normalised quote and claim', () => {
  assert.equal(ingest.noteDedupeKey('A  quote', 'a claim'), ingest.noteDedupeKey('A quote', 'A CLAIM'));
  assert.notEqual(ingest.noteDedupeKey('A quote', 'claim one'), ingest.noteDedupeKey('A quote', 'claim two'));
});

test('every relation status becomes a pair note with strength and missing text', () => {
  const { db, project, mara, corin, tor, chunks } = setup('ingest-statuses');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'friend',
    evidence: 'Mara Voss met Corin Hale at the gate',
    chunk: chunks[0]!,
    confidence: 0.9,
    status: 'accepted',
  });
  addRelation(db, project, {
    from: mara,
    to: tor,
    kind: 'rival of',
    evidence: 'Mara Voss argued with Tor',
    chunk: chunks[2]!,
    confidence: 0.4,
    status: 'provisional',
  });
  addRelation(db, project, {
    from: corin,
    to: tor,
    kind: 'employer of',
    evidence: 'Tor waited by the wall alone',
    chunk: chunks[3]!,
    confidence: 0.5,
    status: 'needs_review',
  });

  const counts = ingest.backfillThreadNotes(db, project);
  assert.equal(counts.pairNotes, 3, 'held-aside clues are still clues');

  const rows = db.all<{ kind: string; strength: number; missing: string; review_status: string }>(
    `SELECT n.strength, n.missing, n.claim AS kind
       FROM canon_thread_note n
       JOIN canon_thread t ON t.id = n.thread_id
      WHERE n.project_id = ? AND t.kind = 'pair' AND n.is_context = 0
      ORDER BY n.id`,
    project,
  );
  assert.equal(rows.length, 3);
  assert.ok(rows.some((r) => r.missing === '' && r.strength > 0.5));
  assert.ok(rows.some((r) => r.missing === 'below the confidence threshold'));
  assert.ok(rows.some((r) => r.missing.length > 0));
  db.close();
});

test('a provisional relation opens a question that a rerun does not duplicate', () => {
  const { db, project, mara, tor, chunks } = setup('ingest-open-end');
  addRelation(db, project, {
    from: mara,
    to: tor,
    kind: 'rival of',
    evidence: 'Mara Voss argued with Tor',
    chunk: chunks[2]!,
    confidence: 0.4,
    status: 'provisional',
  });
  const first = ingest.backfillThreadNotes(db, project);
  assert.ok(first.openEnds >= 1);

  const opened = db.all<{ question: string; origin: string; would_resolve: string }>(
    `SELECT question, origin, would_resolve FROM canon_open_end
      WHERE project_id = ? AND question LIKE 'does the text establish%'`,
    project,
  );
  assert.equal(opened.length, 1);
  assert.match(opened[0]!.origin, /^note \d+$/);
  assert.match(opened[0]!.would_resolve, /naming both people/);
  assert.match(opened[0]!.question, /rival of/);

  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_open_end WHERE project_id = ?', project)!.n;
  const second = ingest.backfillThreadNotes(db, project);
  assert.equal(second.openEnds, 0, 'the question is not asked twice');
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_open_end WHERE project_id = ?', project)!.n,
    before,
  );
  db.close();
});

test('identity notes are clues, not pair evidence', () => {
  const { db, project, mara, corin } = setup('ingest-identity');
  const counts = ingest.backfillThreadNotes(db, project);
  assert.ok(counts.identityNotes >= 3, 'entity evidence became identity notes');

  const personThread = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'person' AND a_entity = ? AND b_entity IS NULL",
    project,
    mara,
  )!.id;
  const onPerson = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_thread_note WHERE thread_id = ?',
    personThread,
  )!.n;
  assert.ok(onPerson >= 1);

  // An identity note never contributes to pair support: identity notes live on
  // person threads, so a meeting cannot pool them into a birth.
  const identity = db.all<{ strength: number; seq: number }>(
    `SELECT n.strength, COALESCE(c.seq, 0) AS seq
       FROM canon_thread_note n
       JOIN canon_thread t ON t.id = n.thread_id
       LEFT JOIN canon_chunk c ON c.id = n.chunk_id
      WHERE t.kind = 'person' AND n.project_id = ?`,
    project,
  );
  assert.ok(identity.length >= 3);
  assert.ok(identity.every((row) => row.strength > 0), 'identity notes carry their confidence');
  const pairNotes = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM canon_thread_note n JOIN canon_thread t ON t.id = n.thread_id
      WHERE t.kind = 'pair' AND n.project_id = ?`,
    project,
  )!.n;
  assert.equal(pairNotes, 0, 'identity evidence never lands on a pair thread');

  const meetings = runMeetings(db, project, { minConfidence: 0.7 });
  assert.equal(meetings.birthsCreated, 0, 'identity notes alone never birth');
  db.close();
});

test('context notes are marked and never raise a birth score', () => {
  const { db, project, mara, corin, chunks } = setup('ingest-context');
  const window = [{ id: chunks[0]! }];
  const counts = ingest.noteFromExtraction(db, project, window);
  assert.ok(counts.contextNotes >= 1, 'co-presence became a context note');

  const contexts = db.all<{ is_context: number; note_kind: string; strength: number }>(
    "SELECT is_context, note_kind, strength FROM canon_thread_note WHERE project_id = ? AND is_context = 1",
    project,
  );
  assert.ok(contexts.length >= 1);
  assert.ok(contexts.every((row) => row.note_kind === 'context' && row.strength === 0));

  // Support from context notes alone is zero, so no pooled birth can rest on them.
  assert.equal(combineSupport(contexts.map((row) => ({ strength: row.strength, seq: 1 }))).score, 0);

  const meetings = runMeetings(db, project, { minConfidence: 0.7 });
  const pairBirths = db.all<{ id: number }>(
    `SELECT b.id FROM canon_birth b
       JOIN canon_meeting m ON m.id = b.meeting_id
      WHERE m.project_id = ? AND b.trigger = 'pooled_evidence'`,
    project,
  );
  assert.deepEqual(pairBirths, [], 'context alone never pools into a birth');
  assert.equal(meetings.birthsCreated, 0);
  void mara;
  void corin;
  db.close();
});

test('backfill writes no bank rows and never mutates a note', () => {
  const { db, project, mara, corin, chunks } = setup('ingest-safe');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'friend',
    evidence: 'Mara Voss met Corin Hale at the gate',
    chunk: chunks[0]!,
  });
  const protectedBefore = ['canon_relation', 'canon_tie_note', 'canon_tie_hint'].map(
    (t) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, project)!.n,
  );

  ingest.backfillThreadNotes(db, project);
  const snapshot = db.all<Record<string, unknown>>('SELECT * FROM canon_thread_note ORDER BY id');
  ingest.backfillThreadNotes(db, project);
  assert.deepEqual(db.all<Record<string, unknown>>('SELECT * FROM canon_thread_note ORDER BY id'), snapshot);

  assert.deepEqual(
    ['canon_relation', 'canon_tie_note', 'canon_tie_hint'].map(
      (t) => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, project)!.n,
    ),
    protectedBefore,
  );

  // No code path updates or deletes notes.
  const exported = Object.keys(ingest);
  assert.ok(!exported.some((name) => /updateNote|deleteNote|editNote/.test(name)), exported.join(','));
  db.close();
});

test('a dry run counts without writing', () => {
  const { db, project, mara, corin, chunks } = setup('ingest-dry-run');
  addRelation(db, project, {
    from: mara,
    to: corin,
    kind: 'friend',
    evidence: 'Mara Voss met Corin Hale at the gate',
    chunk: chunks[0]!,
  });
  const counts = ingest.backfillThreadNotes(db, project, { dryRun: true });
  assert.ok(counts.notes >= 1);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note WHERE project_id = ?', project)!.n, 0);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_open_end WHERE project_id = ?', project)!.n, 0);
  db.close();
});

test('extraction feeds the web, and an ingestion failure never fails extraction', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'ingest-extract');
  const source = addSource(db, project.id);
  addChunk(db, project.id, source, 1, 'Mara Voss met Corin Hale at the gate.');
  buildPairThreads(db, project.id);
  syncThreads(db, project.id);

  const entities = [
    {
      kind: 'character',
      name: 'Mara Voss',
      aliases: [],
      summary: 'a keeper',
      attributes: {},
      role: '',
      status: '',
      chunk_index: 0,
      evidence: 'Mara Voss met Corin Hale at the gate.',
    },
    {
      kind: 'character',
      name: 'Corin Hale',
      aliases: [],
      summary: 'a keeper',
      attributes: {},
      role: '',
      status: '',
      chunk_index: 0,
      evidence: 'Mara Voss met Corin Hale at the gate.',
    },
  ];
  const relations = [
    {
      from: 'Mara Voss',
      to: 'Corin Hale',
      kind: 'friend',
      description: 'they meet at the gate',
      chunk_index: 0,
      evidence: 'Mara Voss met Corin Hale at the gate.',
      confidence: 0.9,
    },
  ];
  const llm = mockProvider((req) => {
    const sys = (req.system ?? '') as string;
    if (sys.includes('KNOWN ENTITIES')) return JSON.stringify({ relations });
    if (sys.includes('"entities"')) return JSON.stringify({ entities });
    return JSON.stringify({ entities: [], relations: [], facts: [], timeline: [] });
  });

  const stats = await lorebook.extractLore(db, llm as never, project.id, { windowSize: 8, concurrency: 1 });
  assert.ok(stats.relations >= 1, 'extraction still banked the relation');
  const written = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_thread_note WHERE project_id = ?',
    project.id,
  )!.n;
  assert.ok(written >= 1, 'the window fed the web');
  db.close();
});

test('an ingestion failure is logged and extraction completes', async () => {
  const { db } = tempDb();
  const project = createProject(db, 'ingest-extract-fail');
  const source = addSource(db, project.id);
  addChunk(db, project.id, source, 1, 'Mara Voss met Corin Hale at the gate.');
  buildPairThreads(db, project.id);

  const llm = mockProvider((req) => {
    const sys = (req.system ?? '') as string;
    if (sys.includes('KNOWN ENTITIES')) {
      return JSON.stringify({
        relations: [
          {
            from: 'Mara Voss',
            to: 'Corin Hale',
            kind: 'friend',
            description: '',
            chunk_index: 0,
            evidence: 'Mara Voss met Corin Hale at the gate.',
            confidence: 0.9,
          },
        ],
      });
    }
    if (sys.includes('"entities"')) {
      return JSON.stringify({
        entities: [
          {
            kind: 'character',
            name: 'Mara Voss',
            aliases: [],
            summary: '',
            attributes: {},
            role: '',
            status: '',
            chunk_index: 0,
            evidence: 'Mara Voss met Corin Hale at the gate.',
          },
          {
            kind: 'character',
            name: 'Corin Hale',
            aliases: [],
            summary: '',
            attributes: {},
            role: '',
            status: '',
            chunk_index: 0,
            evidence: 'Mara Voss met Corin Hale at the gate.',
          },
        ],
      });
    }
    return JSON.stringify({ entities: [], relations: [], facts: [], timeline: [] });
  });

  // Break note ingestion only: every thread lookup now fails.
  db.raw.exec('ALTER TABLE canon_thread RENAME TO canon_thread_hidden');
  const stats = await lorebook.extractLore(db, llm as never, project.id, { windowSize: 8, concurrency: 1 });
  assert.ok(stats.relations >= 1, 'extraction completed despite the web failing');
  const relations = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?',
    project.id,
  )!.n;
  assert.ok(relations >= 1);
  db.close();
});

test('starvedThreads returns threads with nothing gathered, oldest first', () => {
  const { db, project } = setup('ingest-starved');
  const rows = ingest.starvedThreads(db, project, 5);
  assert.ok(rows.length > 0);
  assert.ok(rows.length <= 5);
  assert.ok(rows.every((row) => row.noteCount === 0 || row.openEndCount > 0));
  const all = ingest.starvedThreads(db, project, 0);
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i - 1]!.createdAt <= all[i]!.createdAt, 'ordered oldest first');
  }
  db.close();
});

test('migration 22 is additive on a v21 database and reruns as a no-op', () => {
  const { db } = tempDb();
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 26);
  assert.ok(
    db.all<{ name: string }>('PRAGMA table_info(canon_thread_note)').some((row) => row.name === 'dedupe_key'),
    'the dedupe column exists',
  );
  const project = createProject(db, 'ingest-migrate');
  const mara = addEntity(db, project.id, 'Mara Voss');
  addEntity(db, project.id, 'Corin Hale');
  const source = addSource(db, project.id);
  addChunk(db, project.id, source, 1, 'Mara Voss met Corin Hale.');
  buildPairThreads(db, project.id);
  syncThreads(db, project.id);
  const before = {
    threads: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread')!.n,
    entities: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity')!.n,
  };

  db.raw.exec('PRAGMA foreign_keys = OFF');
  db.raw.exec('DROP INDEX canon_thread_note_dedupe');
  db.raw.exec('DROP INDEX canon_thread_note_project_time');
  db.raw.exec('ALTER TABLE canon_thread_note DROP COLUMN dedupe_key');
  db.raw.exec('PRAGMA user_version = 21');
  db.raw.exec('PRAGMA foreign_keys = ON');
  assert.equal(tableExists(db.raw, 'canon_thread_note'), true);

  assert.equal(runMigrations(db.raw), 26);
  assert.ok(
    db.all<{ name: string }>('PRAGMA table_info(canon_thread_note)').some((row) => row.name === 'dedupe_key'),
    'the column is recreated',
  );
  assert.deepEqual(
    {
      threads: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread')!.n,
      entities: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity')!.n,
    },
    before,
    'existing data survives',
  );
  assert.ok(db.get<{ id: number }>('SELECT id FROM canon_entity WHERE id = ?', mara));
  assert.equal(runMigrations(db.raw), 26, 'second run stays at 25');
  db.close();
});

test('the dedupe index refuses a repeated key and allows the empty legacy key', () => {
  const { db, project, mara, corin, chunks } = setup('ingest-index');
  const thread = db.get<{ id: number }>(
    "SELECT id FROM canon_thread WHERE project_id = ? AND kind = 'pair' AND a_entity = ? AND b_entity = ?",
    project,
    Math.min(mara, corin),
    Math.max(mara, corin),
  )!.id;
  const insert = (key: string) =>
    db.run(
      `INSERT INTO canon_thread_note (project_id, thread_id, chunk_id, locator, quote, claim, note_kind,
                                      strength, why, missing, is_context, dedupe_key, created_at)
       VALUES (?, ?, ?, '', 'q', 'c', 'observation', 0.5, '', '', 0, ?, ?)`,
      project,
      thread,
      chunks[0]!,
      key,
      AT,
    );
  insert('abc');
  assert.throws(() => insert('abc'), /UNIQUE/i);
  insert('');
  insert('');
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_thread_note WHERE thread_id = ?', thread)!.n,
    3,
    'legacy rows without a dedupe key do not collide',
  );
  db.close();
});

test('strength comes from the evidence, never from a default of one', () => {
  const { db, project, mara, corin, chunks } = setup('ingest-strength-table');
  // Both endpoints named, nothing assessed: a stated tie.
  addRelation(db, project, {
    from: mara, to: corin, kind: 'sister of',
    description: 'the oath names her as his sister',
    evidence: 'Mara Voss met Corin Hale at the gate and swore an oath to him.',
    chunk: chunks[0]!, confidence: 1.0,
  });
  const counts = ingest.backfillThreadNotes(db, project);
  assert.ok(counts.pairNotes >= 1, `no pair note: ${JSON.stringify(counts.skipped)}`);
  const note = db.get<{ strength: number; strength_source: string; is_context: number }>(
    `SELECT n.strength, n.strength_source, n.is_context
       FROM canon_thread_note n JOIN canon_thread t ON t.id = n.thread_id
      WHERE n.project_id = ? AND t.kind = 'pair' ORDER BY n.id LIMIT 1`,
    project,
  )!;
  assert.equal(note.strength_source, 'derived');
  assert.equal(note.strength, 0.9, 'both names stated is strong but not certain');
  assert.equal(note.is_context, 0);
  db.close();
});

test('a one-sided quote is weaker than a stated tie', () => {
  const { db, project, mara, corin, chunks } = setup('ingest-strength-implied');
  addRelation(db, project, {
    from: mara, to: corin, kind: 'sister of',
    description: 'the passage only mentions her',
    evidence: 'Corin Hale kept the ledger',
    chunk: chunks[1]!, confidence: 1.0,
  });
  ingest.backfillThreadNotes(db, project);
  const note = db.get<{ strength: number; strength_source: string }>(
    "SELECT strength, strength_source FROM canon_thread_note WHERE project_id = ? AND note_kind = 'observation' ORDER BY id LIMIT 1",
    project,
  )!;
  assert.equal(note.strength_source, 'derived');
  assert.equal(note.strength, 0.35);
  db.close();
});

test('a scene quote becomes a context note at the bottom of the scale', () => {
  const { db, project, mara, corin, source } = setup('ingest-strength-scene');
  const scene = addChunk(db, project, source, 40, 'The wall stood through the long winter.');
  addRelation(db, project, {
    from: mara, to: corin, kind: 'sister of',
    description: 'no one is even named here',
    evidence: 'The wall stood through the long winter.',
    chunk: scene, confidence: 1.0,
  });
  const counts = ingest.backfillThreadNotes(db, project);
  assert.ok(counts.contextNotes >= 1);
  const note = db.get<{ strength: number; strength_source: string; is_context: number; note_kind: string }>(
    "SELECT strength, strength_source, is_context, note_kind FROM canon_thread_note WHERE project_id = ? AND is_context = 1 ORDER BY id LIMIT 1",
    project,
  )!;
  assert.equal(note.strength, 0.2);
  assert.equal(note.strength_source, 'context');
  assert.equal(note.note_kind, 'context');
  assert.equal(note.is_context, 1);
  db.close();
});

test('an assessed strength is used as stored', () => {
  const { db, project, mara, corin, chunks } = setup('ingest-strength-assessed');
  addRelation(db, project, {
    from: mara, to: corin, kind: 'sister of',
    description: 'the assessment settled this',
    evidence: 'Mara Voss met Corin Hale at the gate and swore an oath to him.',
    chunk: chunks[0]!, confidence: 1.0,
    supporting: JSON.stringify([{ assessment: { strength: 0.62, why: 'stated but hedged' } }]),
  });
  ingest.backfillThreadNotes(db, project);
  const note = db.get<{ strength: number; strength_source: string }>(
    'SELECT strength, strength_source FROM canon_thread_note WHERE project_id = ? ORDER BY id LIMIT 1',
    project,
  )!;
  assert.equal(note.strength_source, 'assessed');
  assert.equal(note.strength, 0.62);
  db.close();
});

test('an identity note never restates our own kind column', () => {
  const { db, project, mara } = setup('ingest-identity-claim');
  ingest.backfillThreadNotes(db, project);
  const claims = db.all<{ claim: string }>(
    `SELECT n.claim FROM canon_thread_note n JOIN canon_thread t ON t.id = n.thread_id
      WHERE n.project_id = ? AND t.kind = 'person' AND t.a_entity = ?`,
    project,
    mara,
  );
  assert.ok(claims.length >= 1);
  for (const row of claims) assert.doesNotMatch(row.claim, /is recorded as/);
  db.close();
});

test('an entity with no evidence and no summary is skipped', () => {
  const { db, project } = setup('ingest-identity-none');
  const bare = addEntity(db, project, 'Silent One');
  db.run("UPDATE canon_entity SET evidence = '', summary = '' WHERE id = ?", bare);
  const counts = ingest.backfillThreadNotes(db, project);
  assert.ok(counts.skipped['no-identity-evidence'] >= 1);
  db.close();
});
