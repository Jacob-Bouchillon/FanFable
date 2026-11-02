/**
 * Note-formation tracing.
 *
 * Candidate ids are stable from bank state and window ids. Every candidate
 * gets one terminal disposition; admitted candidates also get a required
 * note.admitted event inside the note transaction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { buildPairThreads } from '../../fanfable/src/web/pair-threads.ts';
import { syncThreads } from '../../fanfable/src/web/threads.ts';
import * as ingest from '../../fanfable/src/web/note-ingest.ts';
import { auditTrace, finishTrace, recordTraceEvent, showTrace, startTrace } from '../../fanfable/src/trace/trace.ts';
import type { NoteAccounting, TraceEventRecord } from '../../fanfable/src/trace/trace.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const CLI = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
type Db = ReturnType<typeof tempDb>['db'];

interface EntitySpec {
  name: string;
  evidence?: string;
  firstChunk?: number | null;
}

function addSource(db: Db, projectId: number): number {
  return Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      '/note-trace-source',
      'Probe',
      'sha-note-trace',
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
      text.split(/\s+/).filter(Boolean).length,
    ).lastInsertRowid,
  );
}

function addEntity(db: Db, projectId: number, spec: EntitySpec): number {
  const firstChunk = spec.firstChunk ?? null;
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, summary, attributes, role, status, first_chunk, evidence,
          source_refs, mentions, confidence, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, '[]', '', '{}', '', '', ?, ?, ?, 1, 1, 'accepted', ?, ?)`,
      projectId,
      spec.name,
      firstChunk,
      spec.evidence ?? '',
      firstChunk ? JSON.stringify([{ source: 'Probe', locator: `p. ${firstChunk}`, chunk: firstChunk }]) : '[]',
      AT,
      AT,
    ).lastInsertRowid,
  );
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
    description?: string;
    confidence?: number;
    status?: string;
  },
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
          confidence, review_status, supporting_evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`,
      projectId,
      rel.from,
      rel.to,
      rel.kind,
      rel.description ?? '',
      rel.evidence,
      rel.chunk ? JSON.stringify([{ source: 'Probe', locator: 'p. 1', chunk: rel.chunk }]) : '[]',
      rel.confidence ?? 0.9,
      rel.status ?? 'accepted',
      AT,
    ).lastInsertRowid,
  );
}

function setup(name: string, texts: string[], entities: EntitySpec[]) {
  const { db, path } = tempDb();
  const project = createProject(db, name);
  const source = addSource(db, project.id);
  const chunks = texts.map((text, index) => addChunk(db, project.id, source, index + 1, text));
  const ids = entities.map((entity) => addEntity(db, project.id, entity));
  buildPairThreads(db, project.id);
  syncThreads(db, project.id);
  return { db, path, projectId: project.id, chunks, entities: ids };
}

function noteRows(db: Db, projectId: number): number {
  return db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_thread_note WHERE project_id = ?',
    projectId,
  )?.n ?? 0;
}

function traceEvents(db: Db, traceId: string): TraceEventRecord[] {
  const view = showTrace(db, traceId);
  assert.ok(view, 'trace view');
  return view.events;
}

function dispositions(events: TraceEventRecord[]): TraceEventRecord[] {
  return events.filter((event) => event.event === ingest.NOTE_EVENT_DISPOSITION);
}

function accountingOf(db: Db, traceId: string): NoteAccounting {
  const audit = auditTrace(db, traceId);
  assert.ok(audit, 'trace audit');
  assert.ok(audit.noteAccounting, 'note accounting');
  return audit.noteAccounting;
}

test('a complete note trace accounts for all four terminal decisions', () => {
  const fixture = setup(
    'note-trace-complete',
    [
      'Mara Voss trusted Corin Hale at the gate.',
      'Corin Hale kept the ledger under the bridge.',
    ],
    [
      { name: 'Mara Voss', evidence: 'Mara Voss trusted Corin Hale', firstChunk: 1 },
      { name: 'Corin Hale', evidence: 'Corin Hale kept the ledger', firstChunk: 2 },
    ],
  );
  const [mara, corin] = fixture.entities as [number, number];
  const [firstChunk] = fixture.chunks as [number];
  const text = 'Mara Voss trusted Corin Hale at the gate.';
  const admitted = addRelation(fixture.db, fixture.projectId, {
    from: mara,
    to: corin,
    kind: 'ally of',
    evidence: text,
    description: text,
    chunk: firstChunk,
  });
  const duplicate = addRelation(fixture.db, fixture.projectId, {
    from: mara,
    to: corin,
    kind: 'companion of',
    evidence: text,
    description: text,
    chunk: firstChunk,
  });
  const rejectedRelation = addRelation(fixture.db, fixture.projectId, {
    from: mara,
    to: corin,
    kind: 'friend of',
    evidence: 'Mara Voss betrayed Corin Hale.',
    description: 'Mara Voss betrayed Corin Hale.',
    chunk: firstChunk,
  });
  const parkedRelation = addRelation(fixture.db, fixture.projectId, {
    from: mara,
    to: corin,
    kind: 'confidant of',
    evidence: '',
    description: '',
    chunk: firstChunk,
  });

  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: firstChunk }]);
  assert.ok(counts.traceId, 'trace id');
  const events = traceEvents(fixture.db, counts.traceId);
  const decisions = new Set(dispositions(events).map((event) => event.decision));
  assert.ok(decisions.has('admitted'), 'admitted disposition');
  assert.ok(decisions.has('deduplicated'), 'deduplicated disposition');
  assert.ok(decisions.has('rejected'), 'rejected disposition');
  assert.ok(decisions.has('parked'), 'parked disposition');

  const bySubject = new Map(dispositions(events).map((event) => [event.subject, event]));
  const admittedEvent = bySubject.get(`relation:${admitted}:pair`);
  assert.equal(admittedEvent?.decision, 'admitted');
  assert.equal(admittedEvent?.reasonCode, 'inserted');
  assert.ok(Number(admittedEvent?.refs.note_id) > 0);

  const duplicateEvent = bySubject.get(`relation:${duplicate}:pair`);
  assert.equal(duplicateEvent?.decision, 'deduplicated');
  assert.equal(duplicateEvent?.reasonCode, 'dedupe-key-match');
  assert.ok(Number(duplicateEvent?.refs.note_id) > 0);

  const rejectedEvent = bySubject.get(`relation:${rejectedRelation}:pair`);
  assert.equal(rejectedEvent?.decision, 'rejected');
  assert.equal(rejectedEvent?.reasonCode, 'not-verbatim');

  const parkedEvent = bySubject.get(`relation:${parkedRelation}:pair`);
  assert.equal(parkedEvent?.decision, 'parked');
  assert.equal(parkedEvent?.reasonCode, 'no-quote');
  assert.ok(Number(parkedEvent?.refs.open_end_id) > 0);

  const identity = bySubject.get(`entity:${mara}:identity`);
  assert.equal(identity?.decision, 'admitted');

  const admission = events.find(
    (event) =>
      event.event === ingest.NOTE_EVENT_ADMITTED &&
      event.refs.candidate_id === `relation:${admitted}:pair`,
  );
  assert.ok(admission);
  assert.ok(Number(admission.refs.note_id) > 0);
  assert.equal(admission.refs.relation_id, admitted);
  assert.ok(Number(admission.refs.thread_id) > 0);
  assert.equal(admission.refs.chunk_id, firstChunk);

  const accounting = accountingOf(fixture.db, counts.traceId);
  assert.equal(accounting.verified, true);
  assert.equal(
    accounting.generated,
    accounting.admitted + accounting.deduplicated + accounting.rejected + accounting.parked,
  );
  assert.equal(accounting.admitted, 3);
  assert.equal(accounting.deduplicated, 1);
  assert.equal(accounting.rejected, 1);
  assert.equal(accounting.parked, 1);
  fixture.db.close();
});

test('rerunning the same window keeps candidate ids stable and notes unchanged', () => {
  const fixture = setup(
    'note-trace-stable',
    ['Mara Voss trusted Corin Hale at the gate.'],
    [{ name: 'Mara Voss', evidence: 'Mara Voss trusted Corin Hale', firstChunk: 1 }],
  );
  const [mara] = fixture.entities as [number];
  const [chunk] = fixture.chunks as [number];
  const corin = addEntity(fixture.db, fixture.projectId, {
    name: 'Corin Hale',
    evidence: 'Mara Voss trusted Corin Hale',
    firstChunk: chunk,
  });
  addRelation(fixture.db, fixture.projectId, {
    from: mara,
    to: corin,
    kind: 'ally of',
    evidence: 'Mara Voss trusted Corin Hale at the gate.',
    description: 'Mara Voss trusted Corin Hale at the gate.',
    chunk,
  });
  buildPairThreads(fixture.db, fixture.projectId);
  syncThreads(fixture.db, fixture.projectId);
  const stats: { notesIngested?: number; noteTraceIds?: string[] } = {};
  const first = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: chunk }], stats);
  assert.ok(first.traceId);
  assert.deepEqual(stats.noteTraceIds, [first.traceId]);
  const firstIds = traceEvents(fixture.db, first.traceId!)
    .filter((event) => event.event === ingest.NOTE_EVENT_GENERATED)
    .map((event) => event.subject)
    .sort();
  const noteCount = noteRows(fixture.db, fixture.projectId);

  const second = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: chunk }]);
  const secondEvents = traceEvents(fixture.db, second.traceId!);
  const secondIds = secondEvents
    .filter((event) => event.event === ingest.NOTE_EVENT_GENERATED)
    .map((event) => event.subject)
    .sort();
  assert.deepEqual(secondIds, firstIds);
  assert.equal(second.notes, 0);
  assert.ok(second.deduplicated >= 1);
  assert.equal(noteRows(fixture.db, fixture.projectId), noteCount);
  assert.ok(dispositions(secondEvents).every((event) => event.decision === 'deduplicated'));
  fixture.db.close();
});

test('a required note.admitted failure rolls back note, ruling and trace events', () => {
  const fixture = setup(
    'note-trace-required',
    ['Mara Voss trusted Corin Hale at the gate.'],
    [{ name: 'Mara Voss', evidence: 'Mara Voss trusted Corin Hale', firstChunk: 1 }],
  );
  const [mara] = fixture.entities as [number];
  const [chunk] = fixture.chunks as [number];
  const corin = addEntity(fixture.db, fixture.projectId, {
    name: 'Corin Hale',
    evidence: 'Corin Hale kept the ledger',
    firstChunk: chunk,
  });
  addRelation(fixture.db, fixture.projectId, {
    from: mara,
    to: corin,
    kind: 'ally of',
    evidence: 'Mara Voss trusted Corin Hale at the gate.',
    description: 'Mara Voss trusted Corin Hale at the gate.',
    chunk,
  });
  buildPairThreads(fixture.db, fixture.projectId);
  syncThreads(fixture.db, fixture.projectId);
  fixture.db.exec(`CREATE TRIGGER fail_note_admitted BEFORE INSERT ON trace_event
                   WHEN NEW.event = 'note.admitted'
                   BEGIN SELECT RAISE(ABORT, 'note admission blocked'); END`);
  assert.throws(
    () => ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: chunk }]),
    /note admission blocked/,
  );
  assert.equal(noteRows(fixture.db, fixture.projectId), 0);
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_ruling WHERE project_id = ?', fixture.projectId)?.n,
    0,
  );
  const trace = fixture.db.get<{ id: string; completeness: string }>('SELECT id, completeness FROM trace ORDER BY id DESC LIMIT 1');
  assert.ok(trace);
  assert.equal(trace.completeness, 'interrupted');
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trace_event WHERE trace_id = ?', trace.id)?.n,
    0,
  );
  fixture.db.exec('DROP TRIGGER fail_note_admitted');
  fixture.db.close();
});

test('a diagnostic disposition failure does not fail note admission', () => {
  const fixture = setup(
    'note-trace-diagnostic',
    ['Mara Voss trusted Corin Hale at the gate.'],
    [{ name: 'Mara Voss', evidence: 'Mara Voss trusted Corin Hale', firstChunk: 1 }],
  );
  const [mara] = fixture.entities as [number];
  const [chunk] = fixture.chunks as [number];
  const corin = addEntity(fixture.db, fixture.projectId, {
    name: 'Corin Hale',
    evidence: 'Corin Hale kept the ledger',
    firstChunk: chunk,
  });
  addRelation(fixture.db, fixture.projectId, {
    from: mara,
    to: corin,
    kind: 'ally of',
    evidence: 'Mara Voss trusted Corin Hale at the gate.',
    description: 'Mara Voss trusted Corin Hale at the gate.',
    chunk,
  });
  buildPairThreads(fixture.db, fixture.projectId);
  syncThreads(fixture.db, fixture.projectId);
  fixture.db.exec(`CREATE TRIGGER fail_note_disposition BEFORE INSERT ON trace_event
                   WHEN NEW.event = 'note.candidate.disposition'
                   BEGIN SELECT RAISE(ABORT, 'disposition blocked'); END`);
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: chunk }]);
  assert.ok(counts.notes > 0);
  assert.ok(noteRows(fixture.db, fixture.projectId) > 0);
  const trace = fixture.db.get<{ id: string; completeness: string; dropped_events: number }>(
    'SELECT id, completeness, dropped_events FROM trace WHERE id = ?',
    counts.traceId,
  );
  assert.ok(trace);
  assert.equal(trace.completeness, 'truncated');
  assert.ok(trace.dropped_events > 0);
  const audit = auditTrace(fixture.db, counts.traceId!);
  assert.ok(audit?.noteAccounting);
  assert.equal(audit.noteAccounting.verified, false);
  assert.ok(audit.suspicious.some((item) => item.code === 'note_trace_not_exhaustive'));
  fixture.db.exec('DROP TRIGGER fail_note_disposition');
  fixture.db.close();
});

test('a dedupe hit increments deduplicated and references the existing note', () => {
  const fixture = setup(
    'note-trace-dedupe',
    ['Mara Voss trusted Corin Hale at the gate.'],
    [{ name: 'Mara Voss', evidence: 'Mara Voss trusted Corin Hale', firstChunk: 1 }],
  );
  const [mara] = fixture.entities as [number];
  const [chunk] = fixture.chunks as [number];
  const corin = addEntity(fixture.db, fixture.projectId, {
    name: 'Corin Hale',
    evidence: 'Corin Hale kept the ledger',
    firstChunk: chunk,
  });
  addRelation(fixture.db, fixture.projectId, {
    from: mara,
    to: corin,
    kind: 'ally of',
    evidence: 'Mara Voss trusted Corin Hale at the gate.',
    description: 'Mara Voss trusted Corin Hale at the gate.',
    chunk,
  });
  buildPairThreads(fixture.db, fixture.projectId);
  syncThreads(fixture.db, fixture.projectId);
  const first = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: chunk }]);
  assert.ok(first.notes > 0);
  const before = noteRows(fixture.db, fixture.projectId);
  const second = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: chunk }]);
  assert.equal(second.notes, 0);
  assert.ok(second.deduplicated >= 1);
  assert.equal(noteRows(fixture.db, fixture.projectId), before);
  const deduped = dispositions(traceEvents(fixture.db, second.traceId!)).filter(
    (event) => event.decision === 'deduplicated',
  );
  assert.ok(deduped.length >= 1);
  for (const event of deduped) {
    const noteId = Number(event.refs.note_id);
    assert.ok(noteId > 0);
    assert.ok(
      fixture.db.get<{ id: number }>(
        'SELECT id FROM canon_thread_note WHERE id = ? AND project_id = ?',
        noteId,
        fixture.projectId,
      ),
    );
  }
  fixture.db.close();
});

test('manual notes-ingest traces non-dry runs and writes no trace on a dry run', () => {
  const fixture = setup(
    'note-trace-backfill',
    ['Mara Voss trusted Corin Hale at the gate.'],
    [{ name: 'Mara Voss', evidence: 'Mara Voss trusted Corin Hale', firstChunk: 1 }],
  );
  const [mara] = fixture.entities as [number];
  const [chunk] = fixture.chunks as [number];
  const corin = addEntity(fixture.db, fixture.projectId, {
    name: 'Corin Hale',
    evidence: 'Mara Voss trusted Corin Hale',
    firstChunk: chunk,
  });
  addRelation(fixture.db, fixture.projectId, {
    from: mara,
    to: corin,
    kind: 'ally of',
    evidence: 'Mara Voss trusted Corin Hale at the gate.',
    description: 'Mara Voss trusted Corin Hale at the gate.',
    chunk,
  });
  buildPairThreads(fixture.db, fixture.projectId);
  syncThreads(fixture.db, fixture.projectId);

  const dry = ingest.backfillThreadNotes(fixture.db, fixture.projectId, { dryRun: true });
  assert.equal(dry.traceId, null);
  assert.equal(noteRows(fixture.db, fixture.projectId), 0);
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_ruling WHERE project_id = ?', fixture.projectId)?.n,
    0,
  );
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trace WHERE project_id = ?', fixture.projectId)?.n,
    0,
  );

  const real = ingest.backfillThreadNotes(fixture.db, fixture.projectId);
  assert.ok(real.traceId);
  assert.ok(real.notes > 0);
  assert.equal(accountingOf(fixture.db, real.traceId!).verified, true);
  fixture.db.close();
});

test('context cap and context-no-both-names are visible dispositions', () => {
  const names = [
    'Alpha One', 'Beta Two', 'Gamma Three', 'Delta Four', 'Epsilon Five',
    'Zeta Six', 'Eta Seven', 'Theta Eight', 'Iota Nine', 'Kappa Ten', 'Lambda Eleven',
  ];
  const sentence = `${names.join(' met ')}.`;
  const capFixture = setup(
    'note-trace-context-cap',
    [sentence],
    names.map((name) => ({ name })),
  );
  const [chunk] = capFixture.chunks as [number];
  const capped = ingest.noteFromExtraction(capFixture.db, capFixture.projectId, [{ id: chunk }]);
  const capEvents = dispositions(traceEvents(capFixture.db, capped.traceId!));
  assert.equal(capEvents.filter((event) => event.decision === 'admitted').length, 40);
  assert.equal(capEvents.filter((event) => event.reasonCode === 'context-cap').length, 15);
  const capAccounting = accountingOf(capFixture.db, capped.traceId!);
  assert.equal(capAccounting.generated, 55);
  assert.equal(capAccounting.admitted, 40);
  assert.equal(capAccounting.rejected, 15);
  assert.equal(capAccounting.verified, true);
  capFixture.db.close();

  const noBothFixture = setup(
    'note-trace-context-no-both',
    ['Mara Voss waited by the gate. Corin Hale arrived later.'],
    [{ name: 'Mara Voss' }, { name: 'Corin Hale' }],
  );
  const [noBothChunk] = noBothFixture.chunks as [number];
  const noBoth = ingest.noteFromExtraction(noBothFixture.db, noBothFixture.projectId, [{ id: noBothChunk }]);
  const noBothEvents = dispositions(traceEvents(noBothFixture.db, noBoth.traceId!));
  assert.equal(noBothEvents.length, 1);
  assert.equal(noBothEvents[0]!.decision, 'rejected');
  assert.equal(noBothEvents[0]!.reasonCode, 'context-no-both-names');
  assert.equal(accountingOf(noBothFixture.db, noBoth.traceId!).verified, true);
  noBothFixture.db.close();
});

test('unfinished, sampled and truncated note traces do not assert accounting', () => {
  const fixture = setup('note-trace-incomplete', ['No candidate names here.'], []);
  for (const mode of ['unfinished', 'sampled', 'truncated'] as const) {
    const trace = startTrace(fixture.db, { projectId: fixture.projectId });
    const subject = `context:1:${mode}`;
    recordTraceEvent(fixture.db, {
      traceId: trace.id,
      projectId: fixture.projectId,
      spanId: subject,
      stage: ingest.NOTE_TRACE_STAGE,
      event: ingest.NOTE_EVENT_GENERATED,
      eventClass: 'diagnostic',
      subject,
      decision: 'candidate',
      reasonCode: 'context-pair',
      committed: false,
    });
    recordTraceEvent(fixture.db, {
      traceId: trace.id,
      projectId: fixture.projectId,
      spanId: subject,
      stage: ingest.NOTE_TRACE_STAGE,
      event: ingest.NOTE_EVENT_DISPOSITION,
      eventClass: 'diagnostic',
      subject,
      decision: 'rejected',
      reasonCode: 'context-no-both-names',
      committed: false,
    });
    if (mode === 'sampled') finishTrace(fixture.db, trace.id, { completeness: 'sampled' });
    if (mode === 'truncated') finishTrace(fixture.db, trace.id, { completeness: 'truncated' });
    const audit = auditTrace(fixture.db, trace.id);
    assert.ok(audit?.noteAccounting);
    assert.equal(audit.noteAccounting.verified, false, mode);
    assert.ok(
      audit.suspicious.some((item) =>
        item.code === (mode === 'unfinished' ? 'note_trace_unfinished' : 'note_trace_not_exhaustive'),
      ),
      mode,
    );
    assert.equal(
      audit.violations.some((item) => item.code.startsWith('note_candidate_')),
      false,
      `${mode} must not assert candidate accounting`,
    );
  }
  fixture.db.close();
});

test('no quote or claim prose reaches the trace tables', () => {
  const quote = 'Mara Voss trusted Corin Hale SENTINEL_QUOTE_7f3a.';
  const claim = 'SENTINEL_CLAIM_9c1b trusted the gate.';
  const fixture = setup(
    'note-trace-prose',
    [quote],
    [{ name: 'Mara Voss', evidence: 'Mara Voss trusted Corin Hale', firstChunk: 1 }],
  );
  const [mara] = fixture.entities as [number];
  const [chunk] = fixture.chunks as [number];
  const corin = addEntity(fixture.db, fixture.projectId, {
    name: 'Corin Hale',
    evidence: 'Corin Hale kept the ledger',
    firstChunk: chunk,
  });
  addRelation(fixture.db, fixture.projectId, {
    from: mara,
    to: corin,
    kind: 'ally of',
    evidence: quote,
    description: claim,
    chunk,
  });
  buildPairThreads(fixture.db, fixture.projectId);
  syncThreads(fixture.db, fixture.projectId);
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: chunk }]);
  assert.ok(counts.notes > 0);
  const traceText = JSON.stringify({
    traces: fixture.db.all('SELECT * FROM trace'),
    events: fixture.db.all('SELECT * FROM trace_event'),
  });
  assert.equal(traceText.includes('SENTINEL_QUOTE_7f3a'), false);
  assert.equal(traceText.includes('SENTINEL_CLAIM_9c1b'), false);
  fixture.db.close();
});

test('the read-only CLI renders note chains and accounting', () => {
  const fixture = setup(
    'note-trace-cli',
    ['Mara Voss trusted Corin Hale at the gate.'],
    [{ name: 'Mara Voss', evidence: 'Mara Voss trusted Corin Hale', firstChunk: 1 }],
  );
  const [mara] = fixture.entities as [number];
  const [chunk] = fixture.chunks as [number];
  const corin = addEntity(fixture.db, fixture.projectId, {
    name: 'Corin Hale',
    evidence: 'Corin Hale kept the ledger',
    firstChunk: chunk,
  });
  addRelation(fixture.db, fixture.projectId, {
    from: mara,
    to: corin,
    kind: 'ally of',
    evidence: 'Mara Voss trusted Corin Hale at the gate.',
    description: 'Mara Voss trusted Corin Hale at the gate.',
    chunk,
  });
  buildPairThreads(fixture.db, fixture.projectId);
  syncThreads(fixture.db, fixture.projectId);
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: chunk }]);
  const traceId = counts.traceId!;
  fixture.db.close();

  const show = spawnSync(
    process.execPath,
    ['--no-warnings', CLI, '--db', fixture.path, 'trace', 'show', traceId, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(show.status, 0, show.stderr);
  const shown = JSON.parse(show.stdout) as { events: { event: string }[] };
  assert.ok(shown.events.some((event) => event.event === ingest.NOTE_EVENT_GENERATED));
  assert.ok(shown.events.some((event) => event.event === ingest.NOTE_EVENT_ADMITTED));

  const audit = spawnSync(
    process.execPath,
    ['--no-warnings', CLI, '--db', fixture.path, 'trace', 'audit', traceId, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(audit.status, 0, audit.stderr);
  const audited = JSON.parse(audit.stdout) as {
    noteAccounting?: { verified: boolean; generated: number };
  };
  assert.ok(audited.noteAccounting);
  assert.equal(audited.noteAccounting.verified, true);
  assert.ok((audited.noteAccounting.generated ?? 0) > 0);

  const text = spawnSync(
    process.execPath,
    ['--no-warnings', CLI, '--db', fixture.path, 'trace', 'audit', traceId],
    { encoding: 'utf8' },
  );
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /note accounting: generated \d+ =/);
});

test('empty windows write no trace; non-empty zero-candidate windows are complete without note accounting', () => {
  const emptyFixture = setup('note-trace-empty', ['No candidate names here.'], []);
  const empty = ingest.noteFromExtraction(emptyFixture.db, emptyFixture.projectId, []);
  assert.equal(empty.traceId, null);
  assert.equal(
    emptyFixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trace WHERE project_id = ?', emptyFixture.projectId)?.n,
    0,
  );
  emptyFixture.db.close();

  const zeroFixture = setup('note-trace-zero', ['No candidate names here.'], []);
  const [chunk] = zeroFixture.chunks as [number];
  const zero = ingest.noteFromExtraction(zeroFixture.db, zeroFixture.projectId, [{ id: chunk }]);
  assert.ok(zero.traceId);
  const view = showTrace(zeroFixture.db, zero.traceId!);
  assert.ok(view);
  assert.equal(view.trace.completeness, 'complete');
  assert.equal(
    view.events.filter((event) => event.event.startsWith('note.')).length,
    0,
    'a candidate-free non-empty window has no note events',
  );
  const audit = auditTrace(zeroFixture.db, zero.traceId!);
  assert.ok(audit);
  assert.equal(audit.noteAccounting, null, 'no note events means no note accounting field');
  zeroFixture.db.close();
});
