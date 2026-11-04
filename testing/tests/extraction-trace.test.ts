/**
 * Relationship-extraction trace integration.
 *
 * Synthetic names and passages only; temp databases; no model or network calls.
 * The trace is diagnostic: these tests prove it observes the existing pipeline
 * without changing its rows, and that it never stores synthetic prose or names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { MockProvider } from '../../fanfable/src/core/llm.ts';
import { extractJson, extractJsonWithRoute } from '../../fanfable/src/core/json.ts';
import { ExtractionTrace } from '../../fanfable/src/trace/extraction-trace.ts';
import {
  EXTRACTION_EVENT_CANDIDATE,
  EXTRACTION_EVENT_CITATION,
  EXTRACTION_EVENT_CLAIM,
  EXTRACTION_EVENT_DIRECTION,
  EXTRACTION_EVENT_DISPOSITION,
  EXTRACTION_EVENT_ENDPOINT,
  EXTRACTION_EVENT_RETRY,
  EXTRACTION_EVENT_RUN_FINALIZED,
  EXTRACTION_EVENT_SECTION,
  EXTRACTION_EVENT_WINDOW_FINISHED,
  EXTRACTION_EVENT_WINDOW_STARTED,
  EXTRACTION_TRACE_STAGE,
  auditTrace,
  finishTrace,
  recordTraceEvent,
  showTrace,
  startTrace,
  type TraceEventRecord,
} from '../../fanfable/src/trace/trace.ts';
import { mockProvider, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

interface WindowFixture {
  sentinel: string;
  firstChunk: string;
  extraChunks?: string[];
  entities: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  relationsAnswer?: string;
  retryReply?: string;
  relationsError?: string;
  malformedRelations?: boolean;
}

const ENTITY = (name: string, evidence: string, aliases: string[] = []) => ({
  kind: 'character',
  name,
  aliases,
  summary: '',
  attributes: {},
  role: '',
  status: '',
  chunk_index: 0,
  evidence,
});

const RELATION = (
  from: string,
  to: string,
  kind: string,
  evidence: string,
  extra: Record<string, unknown> = {},
) => ({
  from,
  to,
  kind,
  description: '',
  chunk_index: 0,
  evidence,
  ...extra,
});

function setup(windows: WindowFixture[]) {
  const { db } = tempDb();
  const project = createProject(db, `extraction-trace-${Math.random().toString(36).slice(2, 7)}`);
  const source = Number(
    db.run(
      `INSERT INTO canon_source (project_id, path, title, sha256, imported_at)
       VALUES (?, ?, ?, ?, ?)`,
      project.id,
      '/synthetic-extraction-trace',
      'Synthetic Trace Probe',
      'sha-synthetic-extraction-trace',
      AT,
    ).lastInsertRowid,
  );
  let seq = 0;
  for (const window of windows) {
    const provided = [window.firstChunk, ...(window.extraChunks ?? [])];
    for (let index = 0; index < 8; index++) {
      seq++;
      const text = provided[index] ?? `Filler passage ${seq} for ${window.sentinel}.`;
      db.run(
        `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words)
         VALUES (?, ?, ?, ?, '', ?, ?)`,
        source,
        project.id,
        seq,
        `p. ${seq}`,
        text,
        text.split(/\s+/).filter(Boolean).length,
      );
    }
  }
  return { db, projectId: project.id, path: db.path };
}

function mockFor(windows: WindowFixture[]) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    const content = req.messages[0]?.content ?? '';
    const window = windows.find((item) => content.includes(item.sentinel));
    if (!window) return JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] });
    if (system.includes('You repair one relationship quote')) {
      return window.retryReply ?? JSON.stringify({ quote: 'NONE' });
    }
    if (system.includes('KNOWN ENTITIES')) {
      if (window.relationsError) throw new Error(window.relationsError);
      if (window.malformedRelations) return 'not json';
      return window.relationsAnswer ?? JSON.stringify({ relations: window.relations });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: window.entities, facts: [] });
  });
}

async function extract(
  name: string,
  windows: WindowFixture[],
  opts: { trace?: { enabled?: boolean; maxEvents?: number }; strict?: boolean; singlePrompt?: boolean } = {},
) {
  const fixture = setup(windows);
  const before = process.env.FANFABLE_REL_STRICT;
  if (opts.strict) process.env.FANFABLE_REL_STRICT = '1';
  try {
    const stats = await lorebook.extractLore(fixture.db, mockFor(windows), fixture.projectId, {
      windowSize: 8,
      concurrency: 1,
      maxWindows: windows.length,
      singlePrompt: opts.singlePrompt,
      trace: opts.trace,
    });
    return { ...fixture, stats };
  } finally {
    if (before === undefined) delete process.env.FANFABLE_REL_STRICT;
    else process.env.FANFABLE_REL_STRICT = before;
  }
}

async function extractLegacyAnswer(answer: string, name: string) {
  const windows: WindowFixture[] = [{
    sentinel: 'WINDOW_LEGACY_STATE',
    firstChunk:
      'WINDOW_LEGACY_STATE Asha nodded. Bram nodded. ' +
      'Asha and Bram were friends at the gate.',
    entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
    relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.')],
  }];
  const fixture = setup(windows);
  const llm = mockProvider((req) => {
    if ((req.system ?? '').includes('record what the book establishes')) return answer;
    return JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] });
  });
  const stats = await lorebook.extractLore(fixture.db, llm, fixture.projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    singlePrompt: true,
    trace: { enabled: true },
  });
  return { ...fixture, stats };
}

function outcomeRows(db: ReturnType<typeof tempDb>['db']) {
  return {
    entities: db.all(
      'SELECT id, kind, name, aliases, review_status, evidence, source_refs, mentions FROM canon_entity ORDER BY id',
    ),
    relations: db.all(
      `SELECT id, from_entity, to_entity, kind, review_status, evidence, source_refs
         FROM canon_relation ORDER BY id`,
    ),
    hints: db.all(
      'SELECT id, from_name, to_name, kind, evidence, source_refs, status FROM canon_tie_hint ORDER BY id',
    ),
    notes: db.all(
      `SELECT id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status
         FROM canon_tie_note ORDER BY id`,
    ),
  };
}

function eventsOf(db: ReturnType<typeof tempDb>['db'], traceId: string): TraceEventRecord[] {
  const view = showTrace(db, traceId);
  assert.ok(view, 'trace view');
  return view.events;
}

function eventOf(
  db: ReturnType<typeof tempDb>['db'],
  traceId: string,
  eventName: string,
  predicate: (event: TraceEventRecord) => boolean = () => true,
): TraceEventRecord {
  const event = eventsOf(db, traceId).find(
    (candidate) => candidate.event === eventName && predicate(candidate),
  );
  assert.ok(event, `missing event ${eventName}`);
  return event;
}

function comprehensiveWindows(): WindowFixture[] {
  return [
    {
      sentinel: 'WINDOW_INSERT',
      firstChunk: 'WINDOW_INSERT Asha nodded. Bram nodded. Asha and Bram were friends at the gate.',
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.')],
    },
    {
      sentinel: 'WINDOW_MERGE',
      firstChunk:
        'WINDOW_MERGE Asha nodded. Bram nodded. Cora nodded. Dora nodded. ' +
        'Asha and Bram were old friends from the village. ' +
        'Cora and Dora were friends for many years. Cora and Dora were close friends.',
      entities: [
        ENTITY('Asha', 'Asha nodded.'),
        ENTITY('Bram', 'Bram nodded.'),
        ENTITY('Cora', 'Cora nodded.'),
        ENTITY('Dora', 'Dora nodded.'),
      ],
      relations: [
        RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were old friends from the village.'),
        RELATION('Cora', 'Dora', 'friend of', 'Cora and Dora were friends for many years.'),
        RELATION('Cora', 'Dora', 'friend of', 'Cora and Dora were close friends.'),
      ],
    },
    {
      sentinel: 'WINDOW_AMBIGUOUS',
      firstChunk:
        'WINDOW_AMBIGUOUS Mira Var nodded. Mira Bel nodded. Bram nodded. Mira and Bram were friends.',
      entities: [
        ENTITY('Mira Var', 'Mira Var nodded.'),
        ENTITY('Mira Bel', 'Mira Bel nodded.'),
        ENTITY('Bram', 'Bram nodded.'),
      ],
      relations: [RELATION('Mira', 'Bram', 'friend of', 'Mira and Bram were friends.')],
    },
    {
      sentinel: 'WINDOW_UNRESOLVED',
      firstChunk: 'WINDOW_UNRESOLVED Bram nodded. Nyx and Bram were friends.',
      entities: [ENTITY('Bram', 'Bram nodded.')],
      relations: [RELATION('Nyx', 'Bram', 'friend of', 'Nyx and Bram were friends.')],
    },
    {
      sentinel: 'WINDOW_SAME',
      firstChunk: 'WINDOW_SAME Asha nodded. Asha and Asha were friends.',
      entities: [ENTITY('Asha', 'Asha nodded.')],
      relations: [RELATION('Asha', 'Asha', 'friend of', 'Asha and Asha were friends.')],
    },
    {
      sentinel: 'WINDOW_INVALID',
      firstChunk: 'WINDOW_INVALID Asha nodded. Bram nodded. Asha and Bram were friends at the gate.',
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were enemies.')],
    },
    {
      sentinel: 'WINDOW_REPOINT',
      firstChunk: 'WINDOW_REPOINT Elia nodded. Fenn nodded.',
      extraChunks: ['Elia and Fenn were friends at the harbour.'],
      entities: [ENTITY('Elia', 'Elia nodded.'), ENTITY('Fenn', 'Fenn nodded.')],
      relations: [RELATION('Elia', 'Fenn', 'friend of', 'Elia and Fenn were friends at the harbour.')],
    },
    {
      sentinel: 'WINDOW_RETRY',
      firstChunk: 'WINDOW_RETRY Asha nodded. Bram nodded. Asha waited. Asha is Bram’s sister.',
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      relations: [RELATION('Asha', 'Bram', 'sister of', 'Asha waited.')],
      retryReply: JSON.stringify({ quote: 'Asha is Bram’s sister.' }),
    },
    {
      sentinel: 'WINDOW_DIRECTION',
      firstChunk: 'WINDOW_DIRECTION Asha nodded. Bram nodded. Asha is Bram’s daughter.',
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      relations: [
        RELATION('Asha', 'Bram', 'father of', 'Asha is Bram’s daughter.', { kind_source: 'daughter' }),
      ],
    },
    {
      sentinel: 'WINDOW_UNSUPPORTED_KIND',
      firstChunk: 'WINDOW_UNSUPPORTED_KIND Asha nodded. Bram nodded. Asha and Bram were friends.',
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      relations: [RELATION('Asha', 'Bram', 'was', 'Asha and Bram were friends.')],
    },
  ];
}

test('traced extraction records candidate, endpoint, citation, retry, direction, claim and terminal lineage', async () => {
  const fixture = await extract('extraction-trace-full', comprehensiveWindows(), {
    trace: { enabled: true },
    strict: true,
  });
  const traceId = fixture.stats.traceId;
  assert.ok(traceId, 'trace id is returned');
  assert.equal(showTrace(fixture.db, traceId)?.trace.metadata.lineage, 'at-decision');
  assert.equal(showTrace(fixture.db, traceId)?.trace.metadata.hash_mode, 'sha256-unsalted');
  assert.equal(showTrace(fixture.db, traceId)?.trace.metadata.privacy_scope, 'trace-events-only');
  const events = eventsOf(fixture.db, traceId);

  const parsedCount = events
    .filter((event) => event.event === EXTRACTION_EVENT_SECTION && event.refs.request_kind === 'relations')
    .reduce((sum, event) => sum + (event.decision === 'parsed' ? Number(event.refs.count ?? 0) : 0), 0);
  const windowStarted = eventOf(fixture.db, traceId, EXTRACTION_EVENT_WINDOW_STARTED);
  assert.ok(Number(windowStarted.refs.run_id) > 0);
  assert.equal(windowStarted.refs.window_index, 0);
  assert.equal(windowStarted.refs.chunk_ids?.length, 8);
  const candidates = events.filter((event) => event.event === EXTRACTION_EVENT_CANDIDATE);
  const dispositions = events.filter((event) => event.event === EXTRACTION_EVENT_DISPOSITION);
  assert.equal(parsedCount, 12, 'twelve parsed relation candidates');
  assert.equal(candidates.length, 12);
  assert.equal(dispositions.length, 12);

  const ambiguous = eventOf(
    fixture.db,
    traceId,
    EXTRACTION_EVENT_ENDPOINT,
    (event) => event.decision === 'ambiguous' && event.subject.endsWith(':from'),
  );
  assert.equal(ambiguous.reasonCode, 'short-collision');
  assert.ok((ambiguous.refs.entity_ids?.length ?? 0) > 1, 'ambiguous endpoint exposes colliding ids');

  const unresolved = eventOf(
    fixture.db,
    traceId,
    EXTRACTION_EVENT_ENDPOINT,
    (event) => event.decision === 'unresolved',
  );
  assert.equal(unresolved.reasonCode, 'none');
  assert.equal(unresolved.refs.entity_id, undefined);

  const repointed = eventOf(fixture.db, traceId, EXTRACTION_EVENT_CITATION, (event) => event.decision === 'repointed');
  assert.equal(repointed.reasonCode, 'quote-repointed');
  assert.ok(Number(repointed.refs.chunk_id) > 0);

  const invalid = eventOf(fixture.db, traceId, EXTRACTION_EVENT_CITATION, (event) => event.decision === 'dropped');
  assert.equal(invalid.reasonCode, 'quote-not-found');

  const retry = eventOf(fixture.db, traceId, EXTRACTION_EVENT_RETRY, (event) => event.decision === 'fixed');
  assert.equal(retry.reasonCode, 'verbatim-both-names');
  assert.equal(retry.refs.attempt, 1);
  const retryCandidate = eventOf(
    fixture.db,
    traceId,
    EXTRACTION_EVENT_CANDIDATE,
    (event) => event.subject === retry.subject,
  );
  assert.ok(retryCandidate.id < retry.id, 'candidate is registered before the retry event');

  const direction = eventOf(fixture.db, traceId, EXTRACTION_EVENT_DIRECTION);
  assert.equal(direction.decision, 'flipped');
  assert.equal(direction.reasonCode, 'sentence-reverse');

  const sameEntity = eventOf(
    fixture.db,
    traceId,
    EXTRACTION_EVENT_DISPOSITION,
    (event) => event.reasonCode === 'same-entity',
  );
  assert.equal(sameEntity.decision, 'dropped');
  const ambiguousDisposition = eventOf(
    fixture.db,
    traceId,
    EXTRACTION_EVENT_DISPOSITION,
    (event) => event.reasonCode === 'ambiguous-endpoint',
  );
  assert.equal(ambiguousDisposition.decision, 'hinted');
  const absentDisposition = eventOf(
    fixture.db,
    traceId,
    EXTRACTION_EVENT_DISPOSITION,
    (event) => event.reasonCode === 'unresolved-endpoint',
  );
  assert.equal(absentDisposition.decision, 'hinted');

  const hintedClaims = events.filter(
    (event) => event.event === EXTRACTION_EVENT_CLAIM && event.decision === 'hinted',
  );
  assert.equal(hintedClaims.length, 2);
  for (const event of hintedClaims) {
    assert.ok(Number(event.refs.hint_id) > 0);
    assert.ok(
      fixture.db.get('SELECT id FROM canon_tie_hint WHERE id = ?', event.refs.hint_id),
      'hint id resolves',
    );
  }

  const insertedClaims = events.filter(
    (event) => event.event === EXTRACTION_EVENT_CLAIM && event.decision === 'inserted',
  );
  assert.equal(insertedClaims.length, 5);
  assert.ok(insertedClaims.every((event) => event.refs.lineage === 'at-decision'));
  for (const event of insertedClaims) {
    assert.ok(Number(event.refs.relation_id) > 0);
    assert.ok(
      fixture.db.get('SELECT id FROM canon_relation WHERE id = ?', event.refs.relation_id),
      'relation id resolves',
    );
  }

  const mergedClaims = events.filter(
    (event) => event.event === EXTRACTION_EVENT_CLAIM && event.decision === 'merged',
  );
  assert.equal(mergedClaims.length, 2);
  assert.deepEqual(
    mergedClaims.map((event) => event.refs.status).sort(),
    ['primary', 'supporting'],
    'merge records whether the incoming bundle became primary or supporting',
  );

  const notedClaims = events.filter(
    (event) => event.event === EXTRACTION_EVENT_CLAIM && event.decision === 'noted',
  );
  assert.equal(notedClaims.length, 2);
  for (const event of notedClaims) {
    assert.ok(Number(event.refs.note_id) > 0);
    assert.ok(
      fixture.db.get('SELECT id FROM canon_tie_note WHERE id = ?', event.refs.note_id),
      'note id resolves',
    );
  }

  const audit = auditTrace(fixture.db, traceId);
  assert.ok(audit);
  assert.equal(audit.exhaustive, false, 'full pipeline lineage is explicitly non-exhaustive');
  assert.deepEqual(audit.violations, []);
  assert.ok(audit.extractionAccounting);
  assert.equal(audit.extractionAccounting.verified, true);
  assert.equal(audit.extractionAccounting.parsedCandidates, 12);
  assert.equal(audit.extractionAccounting.terminalDispositions, 12);
  assert.equal(audit.extractionAccounting.candidateOutcomes.inserted, 5);
  assert.equal(audit.extractionAccounting.candidateOutcomes.merged, 2);
  assert.equal(audit.extractionAccounting.candidateOutcomes.hinted, 2);
  assert.equal(audit.extractionAccounting.candidateOutcomes.noted, 2);
  assert.equal(audit.extractionAccounting.candidateOutcomes.dropped, 1);
  assert.equal(audit.extractionAccounting.candidateOutcomes.errors, 0);
  assert.equal(audit.extractionAccounting.uniqueHints, 2);
  assert.equal(audit.extractionAccounting.pipelineScope, 'window-candidates-only');
  assert.equal(audit.extractionAccounting.pipelineLineage, 'non-exhaustive');
  assert.equal(audit.extractionAccounting.candidateAccountingVerified, true);
  assert.ok(audit.extractionAccounting.claimEvents);
  assert.equal(audit.extractionAccounting.claimEvents.inserted, 5);
  assert.equal(audit.extractionAccounting.claimEvents.merged, 2);
  assert.equal(audit.extractionAccounting.claimEvents.hinted, 2);
  assert.equal(audit.extractionAccounting.claimEvents.noted, 2);
  assert.equal(audit.extractionAccounting.claimEvents.dropped, 1);
  assert.equal(audit.extractionAccounting.runStatus, 'completed');
  assert.equal(audit.extractionAccounting.windows, 10);
  assert.ok(audit.limitations.some((line) => line.includes('claims the model omitted')));
  assert.ok(audit.limitations.some((line) => line.includes('at decision time')));
  assert.ok(audit.limitations.some((line) => line.includes('unsalted SHA-256')));
  assert.ok(audit.limitations.some((line) => line.includes('trace events only')));
  assert.ok(audit.limitations.some((line) => line.includes('project ownership')));
  assert.ok(audit.limitations.some((line) => line.includes('lower bound')));
  assert.ok(audit.limitations.some((line) => line.includes('close-the-loop enrichment')));

  const serialised = JSON.stringify({ trace: showTrace(fixture.db, traceId)?.trace, events });
  for (const privateText of [
    'Asha', 'Bram', 'Cora', 'Dora', 'Elia', 'Fenn', 'Nyx', 'Mira',
    'friends at the gate', 'close friends', 'daughter', 'sister',
    'relations exploded', 'SECRET_RAW',
  ]) {
    assert.equal(serialised.includes(privateText), false, `trace leaked ${privateText}`);
  }
  fixture.db.close();
});

test('trace disabled and enabled produce the same extraction rows and decisions', async () => {
  const windows: WindowFixture[] = [
    {
      sentinel: 'WINDOW_EQUIVALENT',
      firstChunk:
        'WINDOW_EQUIVALENT Asha nodded. Bram nodded. Nyx and Bram were friends. ' +
        'Asha and Bram were friends at the gate. Asha and Bram were enemies.',
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      relations: [
        RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.'),
        RELATION('Nyx', 'Bram', 'friend of', 'Nyx and Bram were friends.'),
        RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were enemies.'),
      ],
    },
  ];
  const plain = await extract('extraction-trace-off', windows);
  const traced = await extract('extraction-trace-on', windows, { trace: { enabled: true } });
  assert.equal(plain.stats.traceId, undefined);
  assert.ok(traced.stats.traceId);

  for (const key of ['entities', 'relations', 'facts', 'timeline', 'windows', 'verification', 'provisional'] as const) {
    assert.deepEqual(traced.stats[key], plain.stats[key], `stats.${key}`);
  }

  const rows = (db: typeof traced.db) => ({
    entities: db.all(
      'SELECT id, kind, name, aliases, review_status, evidence, source_refs, mentions FROM canon_entity ORDER BY id',
    ),
    relations: db.all(
      `SELECT id, from_entity, to_entity, kind, review_status, evidence, source_refs
         FROM canon_relation ORDER BY id`,
    ),
    hints: db.all(
      'SELECT id, from_name, to_name, kind, evidence, source_refs, status FROM canon_tie_hint ORDER BY id',
    ),
    notes: db.all(
      `SELECT id, from_entity, to_entity, attempted_kind, reason, evidence, source_refs, status
         FROM canon_tie_note ORDER BY id`,
    ),
    extractionTraceCount: db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM trace WHERE metadata LIKE '%fanfable-extraction%'",
    )?.n,
  });
  const tracedRows = rows(traced.db);
  const plainRows = rows(plain.db);
  assert.equal(tracedRows.extractionTraceCount, 1);
  assert.equal(plainRows.extractionTraceCount, 0);
  const { extractionTraceCount: _tracedTraceCount, ...tracedOutcome } = tracedRows;
  const { extractionTraceCount: _plainTraceCount, ...plainOutcome } = plainRows;
  assert.deepEqual(tracedOutcome, plainOutcome);
  plain.db.close();
  traced.db.close();
});

test('failed and unparsed relation sections are recorded without claiming complete accounting', async () => {
  const failed = await extract(
    'extraction-trace-failed-section',
    [{
      sentinel: 'WINDOW_PARTIAL',
      firstChunk: 'WINDOW_PARTIAL Asha nodded. Bram nodded.',
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      relations: [],
      relationsError: 'relations exploded SECRET_RAW_NAME',
    }],
    { trace: { enabled: true } },
  );
  assert.ok(failed.stats.traceId);
  const failedEvents = eventsOf(failed.db, failed.stats.traceId!);
  const failedSection = eventOf(
    failed.db,
    failed.stats.traceId!,
    EXTRACTION_EVENT_SECTION,
    (event) => event.refs.request_kind === 'relations',
  );
  assert.equal(failedSection.decision, 'failed');
  assert.equal(failedSection.reasonCode, 'call-error');
  assert.equal(
    failedEvents.filter((event) => event.event === EXTRACTION_EVENT_DISPOSITION).length,
    0,
  );
  const failedAudit = auditTrace(failed.db, failed.stats.traceId!);
  assert.ok(failedAudit?.extractionAccounting);
  assert.equal(failedAudit.extractionAccounting.verified, false);
  assert.equal(failedAudit.extractionAccounting.failedSections, 1);
  assert.equal(failedAudit.exhaustive, false);
  const failedJson = JSON.stringify(showTrace(failed.db, failed.stats.traceId!)?.events);
  assert.equal(failedJson.includes('SECRET_RAW_NAME'), false);
  assert.equal(failedJson.includes('relations exploded'), false);
  failed.db.close();

  const unparsed = await extract(
    'extraction-trace-unparsed-section',
    [{
      sentinel: 'WINDOW_UNPARSED',
      firstChunk: 'WINDOW_UNPARSED Asha nodded. Bram nodded.',
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      relations: [],
      malformedRelations: true,
    }],
    { trace: { enabled: true } },
  );
  assert.ok(unparsed.stats.traceId);
  const unparsedSection = eventOf(
    unparsed.db,
    unparsed.stats.traceId!,
    EXTRACTION_EVENT_SECTION,
    (event) => event.refs.request_kind === 'relations',
  );
  assert.equal(unparsedSection.decision, 'unparsed');
  const unparsedAudit = auditTrace(unparsed.db, unparsed.stats.traceId!);
  assert.ok(unparsedAudit?.extractionAccounting);
  assert.equal(unparsedAudit.extractionAccounting.verified, false);
  assert.equal(unparsedAudit.extractionAccounting.unparsedSections, 1);
  assert.equal(unparsedAudit.exhaustive, false);
  assert.ok(unparsedAudit.limitations.some((line) => line.includes('truncation and malformed JSON')));
  unparsed.db.close();
});

test('a capped trace records the drop and audit refuses exhaustive accounting', async () => {
  const fixture = await extract(
    'extraction-trace-capped',
    [{
      sentinel: 'WINDOW_CAPPED',
      firstChunk: 'WINDOW_CAPPED Asha nodded. Bram nodded. Asha and Bram were friends at the gate.',
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.')],
    }],
    { trace: { enabled: true, maxEvents: 5 } },
  );
  assert.ok(fixture.stats.traceId);
  const view = showTrace(fixture.db, fixture.stats.traceId!);
  assert.ok(view);
  assert.notEqual(view.trace.completeness, 'complete');
  assert.ok(view.trace.droppedEvents > 0);
  assert.ok(view.events.length <= 5, 'the cap bounds stored events');
  const audit = auditTrace(fixture.db, fixture.stats.traceId!);
  assert.ok(audit);
  assert.equal(audit.exhaustive, false);
  assert.ok(audit.extractionAccounting);
  assert.equal(audit.extractionAccounting.verified, false);
  assert.equal(audit.extractionAccounting.claimEvents, null);
  assert.ok(audit.suspicious.some((item) => item.code === 'extraction_accounting_unavailable'));
  fixture.db.close();
});

test('extraction trace events are diagnostic and carry no committed canon claim', async () => {
  const fixture = await extract(
    'extraction-trace-diagnostic',
    [{
      sentinel: 'WINDOW_DIAGNOSTIC',
      firstChunk: 'WINDOW_DIAGNOSTIC Asha nodded. Bram nodded. Asha and Bram were friends at the gate.',
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.')],
    }],
    { trace: { enabled: true } },
  );
  const events = eventsOf(fixture.db, fixture.stats.traceId!);
  assert.ok(events.length > 0);
  assert.ok(events.every((event) => event.stage === EXTRACTION_TRACE_STAGE));
  assert.ok(events.every((event) => event.eventClass === 'diagnostic'));
  assert.ok(events.every((event) => event.committed === false));
  fixture.db.close();
});


test('audit flags a parsed candidate with no terminal disposition', () => {
  const { db } = tempDb();
  const project = createProject(db, 'extraction-trace-missing-terminal');
  const trace = startTrace(db, { projectId: project.id });
  const common = {
    traceId: trace.id,
    projectId: project.id,
    stage: EXTRACTION_TRACE_STAGE,
    eventClass: 'diagnostic' as const,
  };
  recordTraceEvent(db, {
    ...common,
    event: EXTRACTION_EVENT_SECTION,
    subject: 'section:0:relations',
    decision: 'parsed',
    reasonCode: 'parsed-array',
    refs: { request_kind: 'relations', count: 1, window_index: 0 },
  });
  recordTraceEvent(db, {
    ...common,
    event: EXTRACTION_EVENT_CANDIDATE,
    subject: 'candidate:w0:relations:0',
    decision: 'parsed',
    reasonCode: 'section-relations',
    refs: { window_index: 0 },
  });
  recordTraceEvent(db, {
    ...common,
    event: 'extraction.run.finalized',
    subject: 'run:1',
    decision: 'completed',
    reasonCode: 'run-finalized',
    refs: { completed_count: 1 },
  });
  finishTrace(db, trace.id);
  const audit = auditTrace(db, trace.id);
  assert.ok(audit);
  assert.equal(audit.exhaustive, false);
  assert.ok(audit.violations.some((item) => item.code === 'extraction_candidate_missing_disposition'));
  assert.ok(audit.extractionAccounting);
  assert.equal(audit.extractionAccounting.parsedCandidates, 1);
  assert.equal(audit.extractionAccounting.terminalDispositions, 0);
  assert.equal(audit.extractionAccounting.verified, false);
  db.close();
});

test('an unavailable trace ledger never fails extraction', async () => {
  const windows: WindowFixture[] = [{
    sentinel: 'WINDOW_NO_TRACE',
    firstChunk: 'WINDOW_NO_TRACE Asha nodded. Bram nodded. Asha and Bram were friends at the gate.',
    entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
    relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.')],
  }];
  const fixture = setup(windows);
  fixture.db.exec('DROP TABLE trace_event; DROP TABLE trace;');
  const stats = await lorebook.extractLore(fixture.db, mockFor(windows), fixture.projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    trace: { enabled: true },
  });
  assert.equal(stats.traceId, undefined);
  assert.equal(stats.relations, 1);
  assert.equal(
    fixture.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', fixture.projectId)?.n,
    1,
  );
  fixture.db.close();
});


test('the legacy single-prompt path also records parsed candidates and terminal accounting', async () => {
  const windows: WindowFixture[] = [{
    sentinel: 'WINDOW_LEGACY_TRACE',
    firstChunk: 'WINDOW_LEGACY_TRACE Asha nodded. Bram nodded. Asha and Bram were friends at the gate.',
    entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
    relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.')],
  }];
  const fixture = setup(windows);
  const llm = mockProvider((req) => {
    const content = req.messages[0]?.content ?? '';
    const window = windows.find((item) => content.includes(item.sentinel));
    if (!window) return JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] });
    const system = req.system ?? '';
    if (system.includes('record what the book establishes')) {
      return JSON.stringify({
        entities: window.entities,
        facts: [],
        relations: window.relations,
        timeline: [],
      });
    }
    return JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] });
  });
  const stats = await lorebook.extractLore(fixture.db, llm, fixture.projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    singlePrompt: true,
    trace: { enabled: true },
  });
  assert.ok(stats.traceId);
  const section = eventOf(
    fixture.db,
    stats.traceId!,
    EXTRACTION_EVENT_SECTION,
    (event) => event.refs.request_kind === 'relations',
  );
  assert.equal(section.decision, 'parsed');
  assert.equal(section.refs.count, 1);
  const dispositions = eventsOf(fixture.db, stats.traceId!).filter(
    (event) => event.event === EXTRACTION_EVENT_DISPOSITION,
  );
  assert.equal(dispositions.length, 1);
  assert.equal(dispositions[0]!.decision, 'inserted');
  const audit = auditTrace(fixture.db, stats.traceId!);
  assert.equal(audit?.extractionAccounting?.verified, true);
  assert.equal(audit?.extractionAccounting?.parsedCandidates, 1);
  fixture.db.close();
});

test('legacy section state distinguishes empty from missing, partial and unparsed', async () => {
  const missing = await extractLegacyAnswer(
    JSON.stringify({
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      facts: [],
    }),
    'extraction-trace-legacy-missing',
  );
  const missingSection = eventOf(
    missing.db,
    missing.stats.traceId!,
    EXTRACTION_EVENT_SECTION,
    (event) => event.refs.request_kind === 'relations',
  );
  assert.equal(missingSection.decision, 'missing');
  assert.equal(missingSection.reasonCode, 'section-missing');
  assert.equal(missingSection.refs.parse_route, 'missing-section');
  assert.ok((auditTrace(missing.db, missing.stats.traceId!)?.extractionAccounting?.missingSections ?? 0) >= 1);
  assert.equal(auditTrace(missing.db, missing.stats.traceId!)?.extractionAccounting?.verified, false);
  missing.db.close();

  const empty = await extractLegacyAnswer(
    JSON.stringify({
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      facts: [],
      relations: [],
      timeline: [],
    }),
    'extraction-trace-legacy-empty',
  );
  const emptySection = eventOf(
    empty.db,
    empty.stats.traceId!,
    EXTRACTION_EVENT_SECTION,
    (event) => event.refs.request_kind === 'relations',
  );
  assert.equal(emptySection.decision, 'empty');
  assert.equal(emptySection.reasonCode, 'empty-array');
  assert.equal(emptySection.refs.parse_route, 'empty-array');
  assert.equal(auditTrace(empty.db, empty.stats.traceId!)?.extractionAccounting?.verified, true);
  empty.db.close();

  const bare = await extractLegacyAnswer('[]', 'extraction-trace-legacy-bare-array');
  const bareSections = eventsOf(bare.db, bare.stats.traceId!).filter(
    (event) => event.event === EXTRACTION_EVENT_SECTION,
  );
  assert.equal(bareSections.length, 4);
  for (const section of bareSections) {
    assert.equal(section.decision, 'unparsed');
    assert.equal(section.reasonCode, 'schema-mismatch');
    assert.equal(section.refs.parse_route, 'wrong-shape');
  }
  const bareRelations = bareSections.find((event) => event.refs.request_kind === 'relations');
  assert.ok(bareRelations);
  assert.equal(bareRelations.decision, 'unparsed');
  assert.equal(auditTrace(bare.db, bare.stats.traceId!)?.extractionAccounting?.verified, false);
  bare.db.close();

  const truncated = await extractLegacyAnswer(
    '{"entities":' +
      JSON.stringify([ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')]) +
      ',"relations":[{"from":"Asha"',
    'extraction-trace-legacy-truncated',
  );
  const truncatedSection = eventOf(
    truncated.db,
    truncated.stats.traceId!,
    EXTRACTION_EVENT_SECTION,
    (event) => event.refs.request_kind === 'relations',
  );
  assert.equal(truncatedSection.decision, 'unparsed');
  assert.equal(truncatedSection.reasonCode, 'unparsed-answer');
  assert.equal(truncatedSection.refs.parse_route, 'unparsed');
  assert.ok((auditTrace(truncated.db, truncated.stats.traceId!)?.extractionAccounting?.unparsedSections ?? 0) >= 1);
  assert.equal(auditTrace(truncated.db, truncated.stats.traceId!)?.extractionAccounting?.verified, false);
  truncated.db.close();

  const embeddedEmpty = await extractLegacyAnswer(
    '{"entities":[],"facts":[],"relations":[{"from":"Asha"',
    'extraction-trace-legacy-embedded-empty',
  );
  const embeddedSections = eventsOf(embeddedEmpty.db, embeddedEmpty.stats.traceId!).filter(
    (event) => event.event === EXTRACTION_EVENT_SECTION,
  );
  assert.equal(embeddedSections.length, 4);
  assert.ok(embeddedSections.every((event) => event.decision === 'unparsed'));
  assert.ok(embeddedSections.every((event) => event.refs.parse_route === 'unparsed'));
  assert.ok(embeddedSections.every((event) => event.refs.raw_entries === undefined));
  assert.ok(embeddedSections.every((event) => event.refs.filtered_entries === undefined));
  const embeddedAudit = auditTrace(embeddedEmpty.db, embeddedEmpty.stats.traceId!);
  assert.ok(embeddedAudit?.extractionAccounting);
  assert.equal(embeddedAudit.extractionAccounting.verified, false);
  assert.equal(embeddedAudit.extractionAccounting.unparsedSections, 4);
  embeddedEmpty.db.close();

  const distinctEmbedded = await extractLegacyAnswer(
    '{"entities":[],"facts":[],"relations":[{"from":"Asha","to":"Bram","kind":"friend of",' +
      '"evidence":"Asha and Bram were friends at the gate."}],"timeline":[]',
    'extraction-trace-legacy-distinct-embedded-arrays',
  );
  const distinctRelations = eventOf(
    distinctEmbedded.db,
    distinctEmbedded.stats.traceId!,
    EXTRACTION_EVENT_SECTION,
    (event) => event.refs.request_kind === 'relations',
  );
  assert.equal(distinctRelations.decision, 'partial');
  assert.equal(distinctRelations.refs.parse_route, 'salvaged-array');
  assert.equal(distinctRelations.refs.raw_entries, undefined, 'unrelated embedded array count is not asserted');
  assert.equal(distinctRelations.refs.filtered_entries, undefined);
  assert.equal(distinctRelations.refs.accepted_entries, 1);
  assert.equal(distinctRelations.refs.salvaged_entries, 1);
  const distinctAudit = auditTrace(distinctEmbedded.db, distinctEmbedded.stats.traceId!);
  assert.ok(distinctAudit?.extractionAccounting);
  assert.equal(distinctAudit.extractionAccounting.verified, false);
  distinctEmbedded.db.close();

  const partial = await extractLegacyAnswer(
    '{"entities":' +
      JSON.stringify([ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')]) +
      ',"relations":[{"from":"Asha","to":"Bram","kind":"friend of","kind_source":"friends",' +
      '"description":"","chunk_index":0,"evidence":"Asha and Bram were friends at the gate."}',
    'extraction-trace-legacy-partial',
  );
  const partialSection = eventOf(
    partial.db,
    partial.stats.traceId!,
    EXTRACTION_EVENT_SECTION,
    (event) => event.refs.request_kind === 'relations',
  );
  assert.equal(partialSection.decision, 'partial');
  assert.equal(partialSection.reasonCode, 'partial-array');
  assert.equal(partialSection.refs.parse_route, 'salvaged-array');
  assert.ok((auditTrace(partial.db, partial.stats.traceId!)?.extractionAccounting?.partialSections ?? 0) >= 1);
  assert.equal(auditTrace(partial.db, partial.stats.traceId!)?.extractionAccounting?.verified, false);
  partial.db.close();

  const emptyResponse = await extractLegacyAnswer('', 'extraction-trace-legacy-empty-response');
  const emptyResponseSection = eventOf(
    emptyResponse.db,
    emptyResponse.stats.traceId!,
    EXTRACTION_EVENT_SECTION,
    (event) => event.refs.request_kind === 'relations',
  );
  assert.equal(emptyResponseSection.decision, 'unparsed');
  assert.equal(emptyResponseSection.reasonCode, 'empty-response');
  assert.equal(emptyResponseSection.refs.parse_route, 'empty-response');
  assert.equal(auditTrace(emptyResponse.db, emptyResponse.stats.traceId!)?.extractionAccounting?.verified, false);
  emptyResponse.db.close();

  const mixed = await extractLegacyAnswer(
    JSON.stringify({
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      facts: [],
      relations: [
        RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.'),
        null,
      ],
      timeline: [],
    }),
    'extraction-trace-legacy-mixed',
  );
  const mixedSection = eventOf(
    mixed.db,
    mixed.stats.traceId!,
    EXTRACTION_EVENT_SECTION,
    (event) => event.refs.request_kind === 'relations',
  );
  assert.equal(mixedSection.decision, 'partial');
  assert.equal(mixedSection.reasonCode, 'mixed-entries');
  assert.equal(mixedSection.refs.parse_route, 'whole-section-array');
  assert.equal(mixedSection.refs.filtered_entries, 1);
  assert.equal(auditTrace(mixed.db, mixed.stats.traceId!)?.extractionAccounting?.verified, false);
  mixed.db.close();

  const objectInsteadOfArray = await extractLegacyAnswer(
    JSON.stringify({
      entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
      facts: [],
      relations: RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.'),
      timeline: [],
    }),
    'extraction-trace-legacy-object-shape',
  );
  const objectSection = eventOf(
    objectInsteadOfArray.db,
    objectInsteadOfArray.stats.traceId!,
    EXTRACTION_EVENT_SECTION,
    (event) => event.refs.request_kind === 'relations',
  );
  assert.equal(objectSection.decision, 'unparsed');
  assert.equal(objectSection.reasonCode, 'schema-mismatch');
  assert.equal(objectSection.refs.parse_route, 'wrong-shape');
  assert.equal(
    auditTrace(objectInsteadOfArray.db, objectInsteadOfArray.stats.traceId!)?.extractionAccounting?.verified,
    false,
  );
  objectInsteadOfArray.db.close();
});

test('parsed candidates survive an early relation insert failure and aborted candidates get terminal errors', async () => {
  const windows: WindowFixture[] = [{
    sentinel: 'WINDOW_EARLY_ERROR',
    firstChunk: 'WINDOW_EARLY_ERROR Asha nodded. Bram nodded. Asha and Bram were friends.',
    entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
    relations: [
      RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends.'),
      RELATION('Asha', 'Bram', 'sister of', 'Asha and Bram were friends.'),
    ],
  }];
  const fixture = setup(windows);
  fixture.db.exec(
    "CREATE TRIGGER fail_relation_insert BEFORE INSERT ON canon_relation " +
      "BEGIN SELECT RAISE(ABORT, 'injected relation insert'); END;",
  );
  const stats = await lorebook.extractLore(fixture.db, mockFor(windows), fixture.projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    trace: { enabled: true },
  });
  assert.ok(stats.traceId);
  assert.equal(stats.relations, 0);
  const events = eventsOf(fixture.db, stats.traceId!);
  assert.equal(events.filter((event) => event.event === EXTRACTION_EVENT_CANDIDATE).length, 2);
  const dispositions = events.filter((event) => event.event === EXTRACTION_EVENT_DISPOSITION);
  assert.equal(dispositions.length, 2);
  assert.deepEqual(
    dispositions.map((event) => event.reasonCode).sort(),
    ['candidate-aborted', 'candidate-exception'],
  );
  const audit = auditTrace(fixture.db, stats.traceId!);
  assert.ok(audit?.extractionAccounting);
  assert.equal(audit.extractionAccounting.parsedCandidates, 2);
  assert.equal(audit.extractionAccounting.terminalDispositions, 2);
  assert.equal(audit.extractionAccounting.candidateOutcomes.errors, 2);
  assert.equal(audit.extractionAccounting.abortedCandidates, 1);
  assert.equal(audit.extractionAccounting.runStatus, 'failed');
  assert.equal(audit.extractionAccounting.verified, false);
  fixture.db.close();
});

test('audit verifies claim references and one relation-section report per window', () => {
  const { db } = tempDb();
  const project = createProject(db, 'extraction-trace-structural-audit');

  const makeTrace = (opts: {
    section: boolean;
    sectionCount: number;
    claim: 'ok' | 'missing' | 'no-id';
  }): string => {
    const trace = startTrace(db, { projectId: project.id });
    const common = {
      traceId: trace.id,
      projectId: project.id,
      stage: EXTRACTION_TRACE_STAGE,
      eventClass: 'diagnostic' as const,
    };
    if (opts.section) {
      recordTraceEvent(db, {
        ...common,
        event: EXTRACTION_EVENT_SECTION,
        subject: 'section:0:relations',
        decision: 'parsed',
        reasonCode: 'parsed-array',
        refs: { window_index: 0, request_kind: 'relations', count: opts.sectionCount },
      });
    }
    recordTraceEvent(db, {
      ...common,
      event: EXTRACTION_EVENT_CANDIDATE,
      subject: 'candidate:w0:relations:0',
      decision: 'parsed',
      reasonCode: 'section-relations',
      refs: { window_index: 0, kind_hash: 'a'.repeat(64) },
    });
    if (opts.claim !== 'missing') {
      recordTraceEvent(db, {
        ...common,
        event: EXTRACTION_EVENT_CLAIM,
        subject: 'candidate:w0:relations:0',
        decision: 'inserted',
        reasonCode: 'banked',
        refs: opts.claim === 'ok'
          ? { relation_id: 1, lineage: 'at-decision' }
          : {},
      });
    }
    recordTraceEvent(db, {
      ...common,
      event: EXTRACTION_EVENT_DISPOSITION,
      subject: 'candidate:w0:relations:0',
      decision: 'inserted',
      reasonCode: 'candidate-inserted',
      refs: { inserted_count: 1, claim_count: 1 },
    });
    recordTraceEvent(db, {
      ...common,
      event: EXTRACTION_EVENT_WINDOW_FINISHED,
      subject: 'window:0',
      decision: 'completed',
      reasonCode: 'window-completed',
      refs: { window_index: 0 },
    });
    recordTraceEvent(db, {
      ...common,
      event: EXTRACTION_EVENT_RUN_FINALIZED,
      subject: 'run:1',
      decision: 'completed',
      reasonCode: 'run-finalized',
      refs: { completed_count: 1 },
    });
    finishTrace(db, trace.id);
    return trace.id;
  };

  const missingSection = auditTrace(db, makeTrace({ section: false, sectionCount: 1, claim: 'ok' }));
  assert.ok(missingSection);
  assert.ok(missingSection.violations.some((item) => item.code === 'extraction_window_section_missing'));

  const missingClaim = auditTrace(db, makeTrace({ section: true, sectionCount: 1, claim: 'missing' }));
  assert.ok(missingClaim);
  assert.ok(missingClaim.violations.some((item) => item.code === 'extraction_claim_missing_for_disposition'));
  assert.ok(missingClaim.violations.some((item) => item.code === 'extraction_claim_count_mismatch'));

  const noIdClaim = auditTrace(db, makeTrace({ section: true, sectionCount: 1, claim: 'no-id' }));
  assert.ok(noIdClaim);
  assert.ok(noIdClaim.violations.some((item) => item.code === 'extraction_claim_missing_reference'));

  const mismatchedCount = auditTrace(db, makeTrace({ section: true, sectionCount: 2, claim: 'ok' }));
  assert.ok(mismatchedCount);
  assert.ok(mismatchedCount.violations.some((item) => item.code === 'extraction_window_candidate_mismatch'));
  assert.ok(mismatchedCount.violations.some((item) => item.code === 'extraction_candidate_accounting_mismatch'));
  db.close();
});

test('a trace event write failure does not change extraction and marks the trace truncated', async () => {
  const windows: WindowFixture[] = [{
    sentinel: 'WINDOW_TRACE_WRITE_FAULT',
    firstChunk: 'WINDOW_TRACE_WRITE_FAULT Asha nodded. Bram nodded. Asha and Bram were friends at the gate.',
    entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
    relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.')],
  }];
  const plain = await extract('extraction-trace-write-fault-plain', windows);
  const traced = await extract('extraction-trace-write-fault-traced', windows, { trace: { enabled: true } });
  // Re-run the traced case with an injected write failure on claim events.
  const faulty = setup(windows);
  faulty.db.exec(
    "CREATE TRIGGER fail_trace_claim BEFORE INSERT ON trace_event " +
      "WHEN NEW.event = 'extraction.relation.claim' " +
      "BEGIN SELECT RAISE(ABORT, 'injected trace write failure'); END;",
  );
  const faultyStats = await lorebook.extractLore(faulty.db, mockFor(windows), faulty.projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    trace: { enabled: true },
  });
  assert.ok(faultyStats.traceId);
  assert.equal(faultyStats.relations, plain.stats.relations);
  assert.deepEqual(outcomeRows(faulty.db), outcomeRows(plain.db));
  assert.deepEqual(traced.stats.verification, plain.stats.verification);
  const view = showTrace(faulty.db, faultyStats.traceId!);
  assert.ok(view);
  assert.notEqual(view.trace.completeness, 'complete');
  const audit = auditTrace(faulty.db, faultyStats.traceId!);
  assert.ok(audit?.extractionAccounting);
  assert.equal(audit.extractionAccounting.verified, false);
  plain.db.close();
  traced.db.close();
  faulty.db.close();
});

test('trace-only note-id and run-finalization read failures are isolated from extraction', async () => {
  const noteWindows: WindowFixture[] = [{
    sentinel: 'WINDOW_NOTE_LOOKUP_FAULT',
    firstChunk: 'WINDOW_NOTE_LOOKUP_FAULT Asha nodded. Bram nodded. Asha and Bram were friends at the gate.',
    entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
    relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were enemies.')],
  }];
  const plainNote = await extract('extraction-trace-note-fault-plain', noteWindows);
  const noteFault = setup(noteWindows);
  const originalNoteGet = noteFault.db.get.bind(noteFault.db);
  (noteFault.db as unknown as { get: typeof noteFault.db.get }).get = ((sql: string, ...params: unknown[]) => {
    if (sql.includes('SELECT id FROM canon_tie_note')) throw new Error('injected note lookup failure');
    return originalNoteGet(sql, ...params);
  }) as typeof noteFault.db.get;
  const noteFaultStats = await lorebook.extractLore(
    noteFault.db,
    mockFor(noteWindows),
    noteFault.projectId,
    { windowSize: 8, concurrency: 1, maxWindows: 1, trace: { enabled: true } },
  );
  (noteFault.db as unknown as { get: typeof noteFault.db.get }).get = originalNoteGet;
  assert.ok(noteFaultStats.traceId);
  assert.equal(noteFaultStats.verification.unsupported, plainNote.stats.verification.unsupported);
  assert.deepEqual(outcomeRows(noteFault.db), outcomeRows(plainNote.db));
  const noteFaultView = showTrace(noteFault.db, noteFaultStats.traceId!);
  assert.ok(noteFaultView);
  assert.notEqual(noteFaultView.trace.completeness, 'complete');
  assert.equal(auditTrace(noteFault.db, noteFaultStats.traceId!)?.extractionAccounting?.verified, false);
  plainNote.db.close();
  noteFault.db.close();

  const finalizeWindows: WindowFixture[] = [{
    sentinel: 'WINDOW_FINALIZE_FAULT',
    firstChunk: 'WINDOW_FINALIZE_FAULT Asha nodded. Bram nodded. Asha and Bram were friends at the gate.',
    entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
    relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.')],
  }];
  const plainFinalize = await extract('extraction-trace-finalize-fault-plain', finalizeWindows);
  const finalizeFault = setup(finalizeWindows);
  const originalRunGet = finalizeFault.db.get.bind(finalizeFault.db);
  (finalizeFault.db as unknown as { get: typeof finalizeFault.db.get }).get = ((sql: string, ...params: unknown[]) => {
    if (sql.includes('FROM extraction_run WHERE id = ?')) throw new Error('injected run read failure');
    return originalRunGet(sql, ...params);
  }) as typeof finalizeFault.db.get;
  const finalizeFaultStats = await lorebook.extractLore(
    finalizeFault.db,
    mockFor(finalizeWindows),
    finalizeFault.projectId,
    { windowSize: 8, concurrency: 1, maxWindows: 1, trace: { enabled: true } },
  );
  (finalizeFault.db as unknown as { get: typeof finalizeFault.db.get }).get = originalRunGet;
  assert.ok(finalizeFaultStats.traceId);
  assert.equal(finalizeFaultStats.relations, plainFinalize.stats.relations);
  assert.deepEqual(outcomeRows(finalizeFault.db), outcomeRows(plainFinalize.db));
  const finalizeView = showTrace(finalizeFault.db, finalizeFaultStats.traceId!);
  assert.ok(finalizeView);
  assert.notEqual(finalizeView.trace.completeness, 'complete');
  const finalizeAudit = auditTrace(finalizeFault.db, finalizeFaultStats.traceId!);
  assert.ok(finalizeAudit?.extractionAccounting);
  assert.equal(finalizeAudit.extractionAccounting.runStatus, 'unknown');
  assert.equal(finalizeAudit.extractionAccounting.verified, false);
  plainFinalize.db.close();
  finalizeFault.db.close();
});

test('trace preparation failures and arbitrary public reasons are contained and not stored', () => {
  const { db } = tempDb();
  const project = createProject(db, 'extraction-trace-adapter-faults');
  const trace = ExtractionTrace.start(db, project.id, {
    runId: 1,
    windowSize: 8,
    plannedWindows: 1,
    singlePrompt: false,
  });
  assert.ok(trace);
  const ids = trace.registerRelationCandidates(0, [{ kind: {} as unknown as string, kindCount: 1 }]);
  assert.equal(ids.length, 1);
  trace.finish();
  const view = showTrace(db, trace.traceId);
  assert.ok(view);
  assert.notEqual(view.trace.completeness, 'complete');

  const unsafe = ExtractionTrace.start(db, project.id, {
    runId: 2,
    windowSize: 8,
    plannedWindows: 1,
    singlePrompt: false,
  });
  assert.ok(unsafe);
  const unsafeIds = unsafe.registerRelationCandidates(0, [{ kind: 'friend of', kindCount: 1 }]);
  unsafe.claim(unsafeIds[0]!, 'friend of', 'inserted', 'SECRET_REASON' as never, { relation_id: 1 });
  unsafe.claim(unsafeIds[0]!, 'friend of', 'inserted', 'banked', {
    relation_id: 1,
    status: 'SECRET_STATUS' as never,
  });
  unsafe.claim('SECRET_CANDIDATE', 'friend of', 'inserted', 'banked', { relation_id: 1 });
  unsafe.disposition(unsafeIds[0]!, 'dropped', 'candidate-dropped', {
    inserted: 0,
    merged: 0,
    hinted: 0,
    noted: 0,
    dropped: 1,
  });
  unsafe.runFinalized('completed', { completed: 1, partial: 0, failed: 0, skipped: 0 });
  unsafe.finish();
  const unsafeView = showTrace(db, unsafe.traceId);
  assert.ok(unsafeView);
  assert.equal(JSON.stringify(unsafeView).includes('SECRET_REASON'), false);
  assert.equal(JSON.stringify(unsafeView).includes('SECRET_STATUS'), false);
  assert.equal(JSON.stringify(unsafeView).includes('SECRET_CANDIDATE'), false);
  assert.ok(unsafeView.events.some((event) => event.event === EXTRACTION_EVENT_DISPOSITION));
  assert.ok(unsafeView.events.some((event) => event.event === EXTRACTION_EVENT_RUN_FINALIZED));
  assert.notEqual(unsafeView.trace.completeness, 'complete');
  db.close();
});

test('extraction trace omits provider and model settings and adversarial sentinels', async () => {
  const windows: WindowFixture[] = [{
    sentinel: 'WINDOW_SETTINGS_PRIVACY',
    firstChunk: 'WINDOW_SETTINGS_PRIVACY Asha nodded. Bram nodded. Asha and Bram were friends at the gate.',
    entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
    relations: [RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.')],
  }];
  const fixture = setup(windows);
  const base = mockFor(windows);
  const llm = new MockProvider({ model: 'model-SENTINEL-SECRET' });
  (llm.settings as unknown as { provider: string }).provider = 'provider-SENTINEL-SECRET';
  llm.handler = base.handler;
  const stats = await lorebook.extractLore(fixture.db, llm, fixture.projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    // Trace is a legacy/provenance feature. Staging-only runs intentionally do
    // not create an extraction_run or trace rows.
    recovery: { enabled: false },
    trace: { enabled: true },
  });
  assert.ok(stats.traceId);
  const serialised = JSON.stringify(showTrace(fixture.db, stats.traceId!));
  assert.equal(serialised.includes('provider-SENTINEL-SECRET'), false);
  assert.equal(serialised.includes('model-SENTINEL-SECRET'), false);
  const run = fixture.db.get<{ provider: string; model: string }>(
    'SELECT provider, model FROM extraction_run WHERE project_id = ? ORDER BY id DESC LIMIT 1',
    fixture.projectId,
  );
  assert.equal(run?.provider, 'provider-SENTINEL-SECRET');
  assert.equal(run?.model, 'model-SENTINEL-SECRET');
  fixture.db.close();
});


test('candidate kind hash stays raw before strict mapping while claim hash uses the mapped kind', async () => {
  const windows: WindowFixture[] = [{
    sentinel: 'WINDOW_RAW_KIND_HASH',
    firstChunk: 'WINDOW_RAW_KIND_HASH Asha nodded. Bram nodded. Asha and Bram were friends at the gate.',
    entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
    relations: [
      RELATION('Asha', 'Bram', 'bodyguard of; ally of', 'Asha and Bram were friends at the gate.'),
    ],
  }];
  const fixture = await extract('extraction-trace-raw-kind-hash', windows, {
    strict: true,
    trace: { enabled: true },
  });
  const candidate = eventOf(fixture.db, fixture.stats.traceId!, EXTRACTION_EVENT_CANDIDATE);
  const claim = eventOf(fixture.db, fixture.stats.traceId!, EXTRACTION_EVENT_CLAIM);
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  assert.equal(candidate.refs.kind_count, 2);
  assert.equal(candidate.refs.kind_hash, digest('bodyguard of; ally of'));
  assert.equal(claim.refs.kind_hash, digest('ally of'));
  fixture.db.close();
});

test('a skipped relation section is not presented as verified extraction coverage', async () => {
  const fixture = await extract(
    'extraction-trace-skipped-relations',
    [{
      sentinel: 'WINDOW_SKIPPED_RELATIONS',
      firstChunk: 'WINDOW_SKIPPED_RELATIONS A quiet empty passage.',
      entities: [],
      relations: [],
    }],
    { trace: { enabled: true } },
  );
  assert.ok(fixture.stats.traceId);
  const section = eventOf(
    fixture.db,
    fixture.stats.traceId!,
    EXTRACTION_EVENT_SECTION,
    (event) => event.refs.request_kind === 'relations',
  );
  assert.equal(section.decision, 'skipped');
  assert.equal(section.reasonCode, 'no-roster-names');
  const audit = auditTrace(fixture.db, fixture.stats.traceId!);
  assert.ok(audit?.extractionAccounting);
  assert.equal(audit.extractionAccounting.skippedSections, 1);
  assert.equal(audit.extractionAccounting.verified, false);
  fixture.db.close();
});


test('split section observation detects empty response, mixed entries and object-instead-of-array', async () => {
  const relation = RELATION('Asha', 'Bram', 'friend of', 'Asha and Bram were friends at the gate.');
  const base = {
    sentinel: 'WINDOW_SPLIT_SHAPES',
    firstChunk: 'WINDOW_SPLIT_SHAPES Asha nodded. Bram nodded. Asha and Bram were friends at the gate.',
    entities: [ENTITY('Asha', 'Asha nodded.'), ENTITY('Bram', 'Bram nodded.')],
    relations: [] as Record<string, unknown>[],
  };
  const cases: Array<{ name: string; answer: string; decision: string; reason: string; route: string; verified: boolean }> = [
    {
      name: 'split-shape-empty-response',
      answer: '',
      decision: 'unparsed',
      reason: 'empty-response',
      route: 'empty-response',
      verified: false,
    },
    {
      name: 'split-shape-mixed',
      answer: JSON.stringify({ relations: [relation, null] }),
      decision: 'partial',
      reason: 'mixed-entries',
      route: 'whole-section-array',
      verified: false,
    },
    {
      name: 'split-shape-object',
      answer: JSON.stringify({ relations: relation }),
      decision: 'unparsed',
      reason: 'schema-mismatch',
      route: 'wrong-shape',
      verified: false,
    },
    {
      name: 'split-shape-empty-array',
      answer: JSON.stringify({ relations: [] }),
      decision: 'empty',
      reason: 'empty-array',
      route: 'empty-array',
      verified: true,
    },
    {
      name: 'split-shape-bare-empty-array',
      answer: '[]',
      decision: 'empty',
      reason: 'empty-array',
      route: 'empty-array',
      verified: true,
    },
    {
      name: 'split-shape-fenced',
      answer: '```json\n' + JSON.stringify({ relations: [relation] }) + '\n```',
      decision: 'parsed',
      reason: 'parsed-array',
      route: 'fenced-section-array',
      verified: true,
    },
    {
      name: 'split-shape-embedded',
      answer: 'prefix\n' + JSON.stringify({ relations: [relation] }) + '\nsuffix',
      decision: 'parsed',
      reason: 'parsed-array',
      route: 'embedded-section-array',
      verified: true,
    },
    {
      name: 'split-shape-embedded-empty-from-truncated-object',
      answer: '{"entities":[],"relations":[{"from":"Asha"',
      decision: 'unparsed',
      reason: 'unparsed-answer',
      route: 'unparsed',
      verified: false,
    },
    {
      name: 'split-shape-fenced-truncated-unrelated-empty',
      answer: '```json\n{"entities":[],"relations":[{"from":"Asha"\n```',
      decision: 'unparsed',
      reason: 'unparsed-answer',
      route: 'unparsed',
      verified: false,
    },
    {
      name: 'split-shape-fenced-standalone-empty',
      answer: '```json\n[]\n```',
      decision: 'empty',
      reason: 'empty-array',
      route: 'empty-array',
      verified: true,
    },
    {
      name: 'split-shape-fenced-target-empty',
      answer: '```json\n{"relations":[]}\n```',
      decision: 'empty',
      reason: 'empty-array',
      route: 'empty-array',
      verified: true,
    },
    {
      name: 'split-shape-falsy-fence',
      answer: '```json\nfalse\n```',
      decision: 'unparsed',
      reason: 'unparsed-answer',
      route: 'unparsed',
      verified: false,
    },
    {
      name: 'split-shape-falsy-fence-with-later-json',
      answer: '```json\nfalse\n```\n' + JSON.stringify({ relations: [relation] }),
      decision: 'partial',
      reason: 'partial-array',
      route: 'salvaged-array',
      verified: false,
    },
  ];
  for (const item of cases) {
    const fixture = await extract(item.name, [{ ...base, relationsAnswer: item.answer }], {
      trace: { enabled: true },
    });
    const section = eventOf(
      fixture.db,
      fixture.stats.traceId!,
      EXTRACTION_EVENT_SECTION,
      (event) => event.refs.request_kind === 'relations',
    );
    assert.equal(section.decision, item.decision, item.name);
    assert.equal(section.reasonCode, item.reason, item.name);
    assert.equal(section.refs.parse_route, item.route, item.name);
    assert.equal(
      auditTrace(fixture.db, fixture.stats.traceId!)?.extractionAccounting?.verified,
      item.verified,
      item.name,
    );
    fixture.db.close();
  }
});

test('hint id lookup is trace-only, isolated, and does not alter extraction', async () => {
  const windows: WindowFixture[] = [{
    sentinel: 'WINDOW_HINT_LOOKUP_FAULT',
    firstChunk: 'WINDOW_HINT_LOOKUP_FAULT Bram nodded. Nyx and Bram were friends.',
    entities: [ENTITY('Bram', 'Bram nodded.')],
    relations: [
      RELATION('Nyx', 'Bram', 'friend of', 'Nyx and Bram were friends.'),
      RELATION('Nyx', 'Bram', 'friend of', 'Nyx and Bram were friends.'),
    ],
  }];
  const plain = await extract('extraction-trace-hint-fault-plain', windows);

  const disabled = setup(windows);
  const originalDisabledGet = disabled.db.get.bind(disabled.db);
  let disabledLookups = 0;
  (disabled.db as unknown as { get: typeof disabled.db.get }).get = ((sql: string, ...params: unknown[]) => {
    if (sql.includes('SELECT id FROM canon_tie_hint')) {
      disabledLookups++;
      throw new Error('injected hint lookup failure');
    }
    return originalDisabledGet(sql, ...params);
  }) as typeof disabled.db.get;
  const disabledStats = await lorebook.extractLore(disabled.db, mockFor(windows), disabled.projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
  });
  (disabled.db as unknown as { get: typeof disabled.db.get }).get = originalDisabledGet;
  assert.equal(disabledLookups, 0, 'untraced hint capture performs no id lookup');
  assert.equal(disabledStats.verification.hinted, plain.stats.verification.hinted);

  const traced = setup(windows);
  const originalTracedGet = traced.db.get.bind(traced.db);
  let tracedLookups = 0;
  (traced.db as unknown as { get: typeof traced.db.get }).get = ((sql: string, ...params: unknown[]) => {
    if (sql.includes('SELECT id FROM canon_tie_hint')) {
      tracedLookups++;
      throw new Error('injected hint lookup failure');
    }
    return originalTracedGet(sql, ...params);
  }) as typeof traced.db.get;
  const tracedStats = await lorebook.extractLore(traced.db, mockFor(windows), traced.projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    trace: { enabled: true },
  });
  (traced.db as unknown as { get: typeof traced.db.get }).get = originalTracedGet;
  assert.ok(tracedLookups > 0, 'duplicate hint asks the trace for its id');
  assert.equal(tracedStats.verification.hinted, plain.stats.verification.hinted);
  assert.deepEqual(outcomeRows(traced.db), outcomeRows(plain.db));
  const view = showTrace(traced.db, tracedStats.traceId!);
  assert.ok(view);
  assert.notEqual(view.trace.completeness, 'complete');
  assert.equal(auditTrace(traced.db, tracedStats.traceId!)?.extractionAccounting?.verified, false);
  plain.db.close();
  disabled.db.close();
  traced.db.close();
});


test('fenced recursion preserves embedded route provenance and extractJson values', () => {
  const truncated = '```json\n{"entities":[],"relations":[{"from":"Asha"\n```';
  const truncatedRoute = extractJsonWithRoute<unknown>(truncated);
  assert.deepEqual(truncatedRoute.value, []);
  assert.equal(truncatedRoute.route, 'embedded');
  assert.deepEqual(extractJson<unknown>(truncated), []);

  const standalone = '```json\n[]\n```';
  const standaloneRoute = extractJsonWithRoute<unknown>(standalone);
  assert.deepEqual(standaloneRoute.value, []);
  assert.equal(standaloneRoute.route, 'fenced');
  assert.deepEqual(extractJson<unknown>(standalone), []);

  const target = '```json\n{"relations":[]}\n```';
  const targetRoute = extractJsonWithRoute<unknown>(target);
  assert.deepEqual(targetRoute.value, { relations: [] });
  assert.equal(targetRoute.route, 'fenced');
  assert.deepEqual(extractJson<unknown>(target), { relations: [] });
});
