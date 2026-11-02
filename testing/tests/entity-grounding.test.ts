/**
 * Entity identity notes must select the cited chunk that actually contains
 * the evidence. The candidate set is exactly first_chunk plus source_refs;
 * no outside chunk is considered and genuine mismatches still fail the gate.
 *
 * Temp databases only. Invented names and sentences.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { buildPairThreads } from '../../fanfable/src/web/pair-threads.ts';
import { syncThreads } from '../../fanfable/src/web/threads.ts';
import * as ingest from '../../fanfable/src/web/note-ingest.ts';
import { auditTrace, showTrace } from '../../fanfable/src/trace/trace.ts';
import type { TraceEventRecord } from '../../fanfable/src/trace/trace.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

interface Ref {
  chunk: number;
  locator: string;
}

interface EntitySpec {
  name?: string;
  evidence: string;
  firstChunk: number | null;
  refs: Ref[];
}

function addSource(db: Db, projectId: number): number {
  return Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      '/entity-grounding',
      'Probe',
      'sha-entity-grounding',
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
      `loc-${seq}`,
      '',
      text,
      text.split(/\s+/).filter(Boolean).length,
    ).lastInsertRowid,
  );
}

function addEntity(db: Db, projectId: number, spec: EntitySpec): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, summary, attributes, role, status, first_chunk, evidence,
          source_refs, mentions, confidence, review_status, created_at, updated_at)
       VALUES (?, 'character', ?, '[]', '', '{}', '', '', ?, ?, ?, 1, 1, 'accepted', ?, ?)`,
      projectId,
      spec.name ?? 'Mara Voss',
      spec.firstChunk,
      spec.evidence,
      JSON.stringify(
        spec.refs.map((ref) => ({ source: 'Probe', locator: ref.locator, chunk: ref.chunk })),
      ),
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function setup(name: string, texts: string[], entity: EntitySpec) {
  const { db, path } = tempDb();
  const project = createProject(db, name);
  const source = addSource(db, project.id);
  const chunks = texts.map((text, index) => addChunk(db, project.id, source, index + 1, text));
  const entityId = addEntity(db, project.id, entity);
  return { db, path, projectId: project.id, chunks, entityId };
}

function noteRows(db: Db, projectId: number): { chunk_id: number; locator: string }[] {
  return db.all<{ chunk_id: number; locator: string }>(
    'SELECT chunk_id, locator FROM canon_thread_note WHERE project_id = ? ORDER BY id',
    projectId,
  ).map((row) => ({ chunk_id: row.chunk_id, locator: row.locator }));
}

function events(db: Db, traceId: string): TraceEventRecord[] {
  const view = showTrace(db, traceId);
  assert.ok(view, 'trace view');
  return view.events;
}

function dispositions(db: Db, traceId: string): TraceEventRecord[] {
  return events(db, traceId).filter((event) => event.event === ingest.NOTE_EVENT_DISPOSITION);
}

function accountingVerified(db: Db, traceId: string): void {
  const audit = auditTrace(db, traceId);
  assert.ok(audit?.noteAccounting);
  assert.equal(audit.noteAccounting.verified, true);
}

test('A: first_chunk A is skipped when source chunk B contains the evidence', () => {
  const fixture = setup(
    'grounding-a',
    ['Locator A has no matching quote.', 'Mara Voss trusted Corin Hale at the gate.'],
    {
      evidence: 'Mara Voss trusted Corin Hale',
      firstChunk: 1,
      refs: [1, 2].map((chunk) => ({ chunk, locator: `loc-${chunk}` })),
    },
  );
  const [A, B] = fixture.chunks as [number, number];
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(counts.notes, 1);
  assert.equal(counts.skipped['not-verbatim'], 0);
  assert.deepEqual(noteRows(fixture.db, fixture.projectId), [
    { chunk_id: B, locator: 'loc-2' },
  ]);
  const [disposition] = dispositions(fixture.db, counts.traceId!);
  assert.equal(disposition?.decision, 'admitted');
  assert.equal(disposition?.refs.chunk_id, B);
  const generated = events(fixture.db, counts.traceId!).find(
    (event) => event.event === ingest.NOTE_EVENT_GENERATED,
  );
  assert.equal(generated?.refs.chunk_id, B);
  accountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});

test('B: first_chunk A remains preferred when it contains the evidence', () => {
  const fixture = setup(
    'grounding-b',
    ['Mara Voss trusted Corin Hale at the gate.', 'Unrelated later passage.'],
    {
      evidence: 'Mara Voss trusted Corin Hale',
      firstChunk: 1,
      refs: [{ chunk: 2, locator: 'loc-2' }],
    },
  );
  const [A] = fixture.chunks as [number];
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(counts.notes, 1);
  assert.equal(counts.skipped['not-verbatim'], 0);
  assert.equal(noteRows(fixture.db, fixture.projectId)[0]?.chunk_id, A);
  accountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});

test('C: first_chunk null searches cited refs in order', () => {
  const fixture = setup(
    'grounding-c',
    ['First cited passage is unrelated.', 'The evidence lives in the second cited passage.'],
    {
      evidence: 'The evidence lives in the second cited passage',
      firstChunk: null,
      refs: [
        { chunk: 1, locator: 'loc-1' },
        { chunk: 2, locator: 'loc-2' },
      ],
    },
  );
  const [, C] = fixture.chunks as [number, number];
  const counts = ingest.backfillThreadNotes(fixture.db, fixture.projectId);
  assert.equal(counts.notes, 1);
  assert.equal(counts.skipped['not-verbatim'], 0);
  assert.deepEqual(noteRows(fixture.db, fixture.projectId), [
    { chunk_id: C, locator: 'loc-2' },
  ]);
  accountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});

test('D: evidence in no cited chunk still fails not-verbatim', () => {
  const fixture = setup(
    'grounding-d',
    ['Locator A has no matching quote.', 'Locator B has no matching quote either.'],
    {
      evidence: 'This evidence is absent from both cited chunks.',
      firstChunk: 1,
      refs: [
        { chunk: 1, locator: 'loc-1' },
        { chunk: 2, locator: 'loc-2' },
      ],
    },
  );
  const [A] = fixture.chunks as [number];
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(counts.notes, 0);
  assert.equal(counts.skipped['not-verbatim'], 1);
  assert.deepEqual(noteRows(fixture.db, fixture.projectId), []);
  const [disposition] = dispositions(fixture.db, counts.traceId!);
  assert.equal(disposition?.decision, 'rejected');
  assert.equal(disposition?.reasonCode, 'not-verbatim');
  accountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});

test('E: no source_refs but first_chunk contains the quote', () => {
  const fixture = setup(
    'grounding-e',
    ['Mara Voss trusted Corin Hale at the gate.'],
    {
      evidence: 'Mara Voss trusted Corin Hale',
      firstChunk: 1,
      refs: [],
    },
  );
  const [A] = fixture.chunks as [number];
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(counts.notes, 1);
  assert.equal(noteRows(fixture.db, fixture.projectId)[0]?.chunk_id, A);
  accountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});

test('F: no chunk at all is rejected no-chunk', () => {
  const fixture = setup(
    'grounding-f',
    ['A chunk that is not cited by this entity.'],
    {
      evidence: 'Mara Voss trusted Corin Hale',
      firstChunk: null,
      refs: [],
    },
  );
  const counts = ingest.backfillThreadNotes(fixture.db, fixture.projectId);
  assert.equal(counts.notes, 0);
  assert.equal(counts.skipped['no-chunk'], 1);
  const [disposition] = dispositions(fixture.db, counts.traceId!);
  assert.equal(disposition?.decision, 'rejected');
  assert.equal(disposition?.reasonCode, 'no-chunk');
  accountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});

test('G: duplicate refs for one chunk yield one candidate and one disposition', () => {
  const fixture = setup(
    'grounding-g',
    ['Locator A has no matching quote.', 'Mara Voss trusted Corin Hale at the gate.'],
    {
      evidence: 'Mara Voss trusted Corin Hale',
      firstChunk: 1,
      refs: [
        { chunk: 2, locator: 'loc-2' },
        { chunk: 2, locator: 'loc-2-again' },
      ],
    },
  );
  const [A, B] = fixture.chunks as [number, number];
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(counts.notes, 1);
  assert.equal(noteRows(fixture.db, fixture.projectId)[0]?.chunk_id, B);
  const traceEvents = events(fixture.db, counts.traceId!);
  assert.equal(
    traceEvents.filter((event) => event.event === ingest.NOTE_EVENT_GENERATED).length,
    1,
  );
  assert.equal(dispositions(fixture.db, counts.traceId!).length, 1);
  accountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});

test('H: extraction-window and manual backfill both use the cited-chunk fix', () => {
  for (const mode of ['extraction', 'backfill'] as const) {
    const fixture = setup(
      `grounding-h-${mode}`,
      ['Locator A has no matching quote.', 'Mara Voss trusted Corin Hale at the gate.'],
      {
        evidence: 'Mara Voss trusted Corin Hale',
        firstChunk: 1,
        refs: [
          { chunk: 1, locator: 'loc-1' },
          { chunk: 2, locator: 'loc-2' },
        ],
      },
    );
    const [A, B] = fixture.chunks as [number, number];
    const counts = mode === 'extraction'
      ? ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }])
      : ingest.backfillThreadNotes(fixture.db, fixture.projectId);
    assert.equal(counts.notes, 1, mode);
    assert.equal(counts.skipped['not-verbatim'], 0, mode);
    assert.equal(noteRows(fixture.db, fixture.projectId)[0]?.chunk_id, B, mode);
    accountingVerified(fixture.db, counts.traceId!);
    fixture.db.close();
  }
});

test('I: relation note chunk selection is unchanged', () => {
  const { db } = tempDb();
  const project = createProject(db, 'grounding-relation');
  const source = addSource(db, project.id);
  const chunk = addChunk(db, project.id, source, 1, 'Mara Voss trusted Corin Hale at the gate.');
  const mara = addEntity(db, project.id, {
    name: 'Mara Voss',
    evidence: 'Mara Voss trusted Corin Hale',
    firstChunk: chunk,
    refs: [{ chunk, locator: 'loc-1' }],
  });
  const corin = addEntity(db, project.id, {
    name: 'Corin Hale',
    evidence: 'Mara Voss trusted Corin Hale',
    firstChunk: chunk,
    refs: [{ chunk, locator: 'loc-1' }],
  });
  db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs,
        confidence, review_status, supporting_evidence, created_at)
     VALUES (?, ?, ?, 'ally of', 'Mara Voss trusted Corin Hale at the gate.',
             'Mara Voss trusted Corin Hale at the gate.', ?, 0.9, 'accepted', '[]', ?)`,
    project.id,
    mara,
    corin,
    JSON.stringify([{ source: 'Probe', locator: 'loc-1', chunk }]),
    AT,
  );
  buildPairThreads(db, project.id);
  syncThreads(db, project.id);
  const counts = ingest.noteFromExtraction(db, project.id, [{ id: chunk }]);
  assert.ok(counts.pairNotes >= 1, 'relation pair note still admitted');
  const pairNote = db.get<{ chunk_id: number }>(
    "SELECT chunk_id FROM canon_thread_note WHERE project_id = ? AND note_kind = 'observation' AND is_context = 0 ORDER BY id LIMIT 1",
    project.id,
  );
  assert.equal(pairNote?.chunk_id, chunk);
  db.close();
});
