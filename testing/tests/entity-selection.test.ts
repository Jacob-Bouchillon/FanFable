/**
 * Entity selection by first_chunk OR a cited source_refs chunk.
 *
 * The selection query still prefers first_chunk when present, but an entity
 * whose evidence arrives later must become a candidate in the evidence window.
 * Temp databases only. Invented names and sentences.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as ingest from '../../fanfable/src/web/note-ingest.ts';
import { auditTrace, showTrace } from '../../fanfable/src/trace/trace.ts';
import type { TraceEventRecord } from '../../fanfable/src/trace/trace.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

interface Ref {
  chunk: number | string;
  locator: string;
}

interface EntitySpec {
  name?: string;
  evidence: string;
  firstChunk: number | null;
  refs?: Ref[];
  rawSourceRefs?: string;
}

function addSource(db: Db, projectId: number): number {
  return Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      '/entity-selection',
      'Probe',
      'sha-entity-selection',
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
  const sourceRefs = spec.rawSourceRefs ?? JSON.stringify(
    (spec.refs ?? []).map((ref) => ({
      source: 'Probe',
      locator: ref.locator,
      chunk: ref.chunk,
    })),
  );
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
      sourceRefs,
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

function traceEvents(db: Db, traceId: string): TraceEventRecord[] {
  const view = showTrace(db, traceId);
  assert.ok(view, 'trace view');
  return view.events;
}

function generatedSubjects(events: TraceEventRecord[]): string[] {
  return events
    .filter((event) => event.event === ingest.NOTE_EVENT_GENERATED)
    .map((event) => event.subject)
    .sort();
}

function dispositions(events: TraceEventRecord[]): TraceEventRecord[] {
  return events.filter((event) => event.event === ingest.NOTE_EVENT_DISPOSITION);
}

function assertAccountingVerified(db: Db, traceId: string): void {
  const audit = auditTrace(db, traceId);
  assert.ok(audit, 'audit');
  assert.ok(audit.noteAccounting, 'note accounting');
  assert.equal(audit.noteAccounting.verified, true);
}

test('null first_chunk selects a cited chunk in the window, including string refs', () => {
  const fixture = setup(
    'select-null-first',
    ['First passage is unrelated.', 'Mara Voss trusted Corin Hale at the gate.'],
    {
      evidence: 'Mara Voss trusted Corin Hale',
      firstChunk: null,
      refs: [{ chunk: '2', locator: 'loc-2' }],
    },
  );
  const [, B] = fixture.chunks as [number, number];
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: B }]);
  assert.equal(counts.notes, 1);
  assert.deepEqual(noteRows(fixture.db, fixture.projectId), [{ chunk_id: B, locator: 'loc-2' }]);
  assert.ok(generatedSubjects(traceEvents(fixture.db, counts.traceId!)).includes(`entity:${fixture.entityId}:identity`));
  assertAccountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});

test('earlier first_chunk does not hide a cited evidence chunk in the current window', () => {
  const fixture = setup(
    'select-earlier-first',
    ['First window has no matching evidence.', 'Mara Voss trusted Corin Hale at the gate.'],
    {
      evidence: 'Mara Voss trusted Corin Hale',
      firstChunk: 1,
      refs: [{ chunk: 2, locator: 'loc-2' }],
    },
  );
  const [, B] = fixture.chunks as [number, number];
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: B }]);
  assert.equal(counts.notes, 1);
  assert.equal(counts.skipped['not-verbatim'], 0);
  assert.deepEqual(noteRows(fixture.db, fixture.projectId), [{ chunk_id: B, locator: 'loc-2' }]);
  assertAccountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});

test('later first_chunk selects the earlier evidence window, then dedupes in its own window', () => {
  const fixture = setup(
    'select-later-first',
    ['Mara Voss trusted Corin Hale at the gate.', 'Later first-chunk window.'],
    {
      evidence: 'Mara Voss trusted Corin Hale',
      firstChunk: 2,
      refs: [{ chunk: 1, locator: 'loc-1' }],
    },
  );
  const [A, B] = fixture.chunks as [number, number];
  const first = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(first.notes, 1);
  assert.deepEqual(noteRows(fixture.db, fixture.projectId), [{ chunk_id: A, locator: 'loc-1' }]);
  const before = noteRows(fixture.db, fixture.projectId).length;
  const later = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: B }]);
  assert.equal(later.notes, 0);
  assert.ok(later.deduplicated >= 1);
  assert.equal(noteRows(fixture.db, fixture.projectId).length, before);
  assert.ok(
    dispositions(traceEvents(fixture.db, later.traceId!)).every(
      (event) => event.decision === 'deduplicated',
    ),
  );
  assertAccountingVerified(fixture.db, later.traceId!);
  fixture.db.close();
});

test('a first_chunk and cited chunk in the same window produce one candidate', () => {
  const fixture = setup(
    'select-same-window',
    ['Mara Voss trusted Corin Hale at the gate.'],
    {
      evidence: 'Mara Voss trusted Corin Hale',
      firstChunk: 1,
      refs: [{ chunk: 1, locator: 'loc-1' }],
    },
  );
  const [A] = fixture.chunks as [number];
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(counts.notes, 1);
  const events = traceEvents(fixture.db, counts.traceId!);
  assert.equal(generatedSubjects(events).length, 1);
  assert.equal(dispositions(events).length, 1);
  assertAccountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});

test('duplicate refs for one cited chunk produce one candidate and one note', () => {
  const fixture = setup(
    'select-duplicate-refs',
    ['Mara Voss trusted Corin Hale at the gate.'],
    {
      evidence: 'Mara Voss trusted Corin Hale',
      firstChunk: null,
      refs: [
        { chunk: 1, locator: 'loc-1' },
        { chunk: 1, locator: 'loc-1-again' },
      ],
    },
  );
  const [A] = fixture.chunks as [number];
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(counts.notes, 1);
  const events = traceEvents(fixture.db, counts.traceId!);
  assert.equal(generatedSubjects(events).length, 1);
  assert.equal(dispositions(events).length, 1);
  assertAccountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});

test('evidence absent from every cited chunk still rejects not-verbatim', () => {
  const fixture = setup(
    'select-not-verbatim',
    ['Mara Voss trusted Corin Hale at the gate.'],
    {
      evidence: 'This evidence is absent from the cited chunk.',
      firstChunk: null,
      refs: [{ chunk: 1, locator: 'loc-1' }],
    },
  );
  const [A] = fixture.chunks as [number];
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(counts.notes, 0);
  assert.equal(counts.skipped['not-verbatim'], 1);
  assert.deepEqual(noteRows(fixture.db, fixture.projectId), []);
  const [disposition] = dispositions(traceEvents(fixture.db, counts.traceId!));
  assert.equal(disposition?.decision, 'rejected');
  assert.equal(disposition?.reasonCode, 'not-verbatim');
  assertAccountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});

test('repeated processing of the same window dedupes and does not duplicate notes', () => {
  const fixture = setup(
    'select-repeat',
    ['Mara Voss trusted Corin Hale at the gate.'],
    {
      evidence: 'Mara Voss trusted Corin Hale',
      firstChunk: null,
      refs: [{ chunk: 1, locator: 'loc-1' }],
    },
  );
  const [A] = fixture.chunks as [number];
  const first = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(first.notes, 1);
  const before = noteRows(fixture.db, fixture.projectId).length;
  const second = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(second.notes, 0);
  assert.ok(second.deduplicated >= 1);
  assert.equal(noteRows(fixture.db, fixture.projectId).length, before);
  assert.ok(
    dispositions(traceEvents(fixture.db, second.traceId!)).every(
      (event) => event.decision === 'deduplicated',
    ),
  );
  assertAccountingVerified(fixture.db, second.traceId!);
  fixture.db.close();
});

test('temporal regression: window A misses the entity, later window B recovers it', () => {
  const fixture = setup(
    'select-temporal',
    ['First window has no evidence yet.', 'Mara Voss trusted Corin Hale at the gate.'],
    {
      name: 'Mara Voss',
      evidence: '',
      firstChunk: 1,
      refs: [{ chunk: 1, locator: 'loc-1' }],
    },
  );
  const [A, B] = fixture.chunks as [number, number];

  const earlier = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(earlier.notes, 0);
  assert.equal(noteRows(fixture.db, fixture.projectId).length, 0);
  const earlierView = showTrace(fixture.db, earlier.traceId!);
  assert.ok(earlierView);
  assert.equal(earlierView.trace.completeness, 'complete');
  assert.equal(
    earlierView.events.filter((event) => event.event.startsWith('note.')).length,
    0,
    'empty evidence is not a candidate',
  );

  // Later extraction update: evidence now arrives in window B, while
  // first_chunk remains in the already-processed window A.
  fixture.db.run(
    'UPDATE canon_entity SET evidence = ?, source_refs = ? WHERE id = ?',
    'Mara Voss trusted Corin Hale',
    JSON.stringify([
      { source: 'Probe', locator: 'loc-1', chunk: A },
      { source: 'Probe', locator: 'loc-2', chunk: B },
    ]),
    fixture.entityId,
  );

  const later = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: B }]);
  assert.equal(later.notes, 1);
  assert.deepEqual(noteRows(fixture.db, fixture.projectId), [{ chunk_id: B, locator: 'loc-2' }]);
  const laterEvents = traceEvents(fixture.db, later.traceId!);
  assert.ok(
    generatedSubjects(laterEvents).includes(`entity:${fixture.entityId}:identity`),
    'later evidence window generates the entity candidate',
  );
  assertAccountingVerified(fixture.db, later.traceId!);
  fixture.db.close();
});

test('invalid source_refs JSON does not break first_chunk selection', () => {
  const fixture = setup(
    'select-invalid-refs',
    ['Mara Voss trusted Corin Hale at the gate.'],
    {
      evidence: 'Mara Voss trusted Corin Hale',
      firstChunk: 1,
      rawSourceRefs: 'not-json',
    },
  );
  const [A] = fixture.chunks as [number];
  const counts = ingest.noteFromExtraction(fixture.db, fixture.projectId, [{ id: A }]);
  assert.equal(counts.notes, 1);
  assertAccountingVerified(fixture.db, counts.traceId!);
  fixture.db.close();
});
