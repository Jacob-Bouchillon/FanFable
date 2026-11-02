/**
 * Phase 2b-1: context-assembly tracing for `assembleContext -> ContextBundle`.
 *
 * Temp databases and MockProvider only. Diagnostics must not move the bundle,
 * and retrieval success must stay distinct from context inclusion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as planner from '../../fanfable/src/plan/planner.ts';
import * as trace from '../../fanfable/src/trace/trace.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

const AT = '2024-01-01T00:00:00.000Z';
const CLI = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');

const STATE_JSON = {
  summary: 'Serena took the third lantern.',
  events: [],
  characters: [{ name: 'Serena Marsh', aliases: ['Serena'] }],
  states: [],
  knowledge: [],
  relationships: [],
  threads: [],
  facts: [],
  canonChanges: [],
};

function chapterOutline(overrides: Partial<planner.ChapterOutline> = {}): planner.ChapterOutline {
  return {
    number: 1,
    title: 'The Third Lantern',
    goal: "Who is Serena Marsh's sibling?",
    synopsis: 'Serena crosses the bridge at dawn.',
    scenes: [
      {
        title: 'The ridge',
        summary: 'Serena watches the bridge.',
        pov: 'Serena Marsh',
        location: 'the ridge',
        canonEventIds: [],
        adaptations: '',
      },
    ],
    characters: ['Serena Marsh', 'Kade'],
    characterArcs: '',
    canonEventIds: [],
    notes: '',
    targetWords: 200,
    ...overrides,
  };
}

function approvedProject(db: ReturnType<typeof tempDb>['db'], name: string) {
  const project = seedProject(db, name);
  const chapter = chapterOutline();
  const outline = planner.saveOutline(db, project.id, {
    premise: 'Serena crosses the bridge before dawn.',
    divergence: 'She takes the third lantern.',
    chapters: [chapter],
    status: 'draft',
  });
  planner.approveOutline(db, project.id, outline.id);
  return { project, chapter };
}

function contextLlm() {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('Lore Researcher')) {
      return JSON.stringify({ facts: ['A canon fact [S1]'], scenes: [], cautions: [] });
    }
    if (system.includes('expand a lore question')) return '{"terms":["bridge","Ardenne"]}';
    if (system.includes('extract structured story state')) return JSON.stringify(STATE_JSON);
    if (system.includes('Continuity Checker')) return '{"issues":[]}';
    return '{}';
  });
}

function writerLlm() {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('Lore Researcher')) {
      return JSON.stringify({ facts: ['A canon fact [S1]'], scenes: [], cautions: [] });
    }
    if (system.includes('expand a lore question')) return '{"terms":["bridge","Ardenne"]}';
    if (system.includes('extract structured story state')) return JSON.stringify(STATE_JSON);
    if (system.includes('Continuity Checker')) return '{"issues":[]}';
    if (system.includes('Story Writer')) {
      return 'The bridge at Ardenne stood in the rain. Serena took the third lantern and crossed before dawn.';
    }
    return '{}';
  });
}

function events(db: ReturnType<typeof tempDb>['db'], traceId: string) {
  const view = trace.showTrace(db, traceId);
  assert.ok(view, 'trace exists');
  return view.events;
}

function addChunk(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  seq: number,
  text: string,
): number {
  const source = db.get<{ id: number }>(
    'SELECT id FROM canon_source WHERE project_id = ? LIMIT 1',
    projectId,
  );
  assert.ok(source);
  return Number(
    db.run(
      `INSERT INTO canon_chunk
         (source_id, project_id, seq, locator, heading, text, words, lore_mined)
       VALUES (?, ?, ?, ?, '', ?, ?, 1)`,
      source!.id,
      projectId,
      seq,
      `custom-${seq}`,
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
}

function addEvent(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  chunkId: number,
  seq: number,
): number {
  const chunk = db.get<{ source_id: number; locator: string }>(
    'SELECT source_id, locator FROM canon_chunk WHERE id = ? AND project_id = ?',
    chunkId,
    projectId,
  );
  assert.ok(chunk);
  return Number(
    db.run(
      `INSERT INTO canon_event
         (project_id, source_id, chunk_id, locator, title, summary, participants, created_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      projectId,
      chunk!.source_id,
      chunkId,
      chunk!.locator,
      `Canon event ${seq}`,
      'A preloaded canon event.',
      AT,
      seq,
    ).lastInsertRowid,
  );
}

function insertEntity(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  name: string,
  uid: string,
  refs: string,
  firstChunk: number | null,
): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, claim_uid, kind, name, aliases, summary, attributes, role, status,
          first_chunk, evidence, source_refs, mentions, review_status, created_at, updated_at)
       VALUES (?, ?, 'character', ?, '[]', '', '{}', '', '', ?, 'evidence', ?, 1, 'accepted', ?, ?)`,
      projectId,
      uid,
      name,
      firstChunk,
      refs,
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function insertRelation(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  from: number,
  to: number,
  kind: string,
  refs: string,
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, claim_uid, from_entity, to_entity, kind, description, evidence,
          source_refs, confidence, modality, review_status, kind_source, anchor_evidence,
          supporting_evidence, relation_status, confirmed_by_user, created_at)
       VALUES (?, ?, ?, ?, ?, '', 'evidence', ?, 1, '', 'accepted', '', '', '[]', 'current', 0, ?)`,
      projectId,
      `rel-${from}-${to}-${kind.replace(/\W+/g, '-')}`,
      from,
      to,
      kind,
      refs,
      AT,
    ).lastInsertRowid,
  );
}

function manualTrace(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  entries: Array<{
    event: string;
    subject: string;
    decision?: string;
    reasonCode?: string;
    refs?: trace.TraceRefs;
  }>,
  finish: { completeness?: trace.TraceCompleteness; interrupted?: boolean } = {},
): string {
  const started = trace.startTrace(db, { projectId });
  for (const entry of entries) {
    trace.recordTraceEvent(db, {
      traceId: started.id,
      projectId,
      stage: 'context',
      event: entry.event,
      eventClass: 'diagnostic',
      subject: entry.subject,
      decision: entry.decision,
      reasonCode: entry.reasonCode,
      refs: entry.refs,
      spanId: 'sp-context',
    });
  }
  trace.finishTrace(db, started.id, finish);
  return started.id;
}

test('tracing on/off keeps the complete ContextBundle identical', async () => {
  const { db } = tempDb();
  const { project, chapter } = approvedProject(db, 'context-parity');
  const llm = contextLlm();

  const plain = await controller.assembleContext(db, llm, project.id, {
    chapter,
    chapterNumber: 1,
    trace: false,
  });
  let traceId: string | undefined;
  const traced = await controller.assembleContext(db, llm, project.id, {
    chapter,
    chapterNumber: 1,
    onTraceId: (id) => {
      traceId = id;
    },
  });

  assert.ok(traceId, 'an actual assembly produces a trace id');
  assert.deepEqual(traced, plain, 'trace metadata never changes the bundle');
  assert.equal(traced.requests.length, 0);
  db.close();
});

test('one root, distinct children and distinct ids for repeated assemblies', async () => {
  const { db } = tempDb();
  const { project, chapter } = approvedProject(db, 'context-repeated');
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    await controller.assembleContext(db, contextLlm(), project.id, {
      chapter,
      chapterNumber: 1,
      onTraceId: (id) => ids.push(id),
    });
  }
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], 'repeated assemblies get fresh trace ids');

  const list = events(db, ids[0]!);
  assert.ok(list.some((event) => event.spanId === 'sp-context' && event.event === 'context.requested'));
  for (const child of ['memory', 'canon-preload', 'retrieve', 'canon-brief', 'lore-brief', 'merge', 'final']) {
    assert.ok(
      list.some((event) => event.event === 'context.child.started' && event.subject === `child:${child}`),
      `${child} child started`,
    );
    assert.ok(
      list.some((event) => event.event === 'context.child.completed' && event.subject === `child:${child}`),
      `${child} child completed`,
    );
  }
  db.close();
});

test('write and approve expose the assembly trace id, but a reused bundle does not', async () => {
  const { db } = tempDb();
  const { project, chapter } = approvedProject(db, 'context-write-id');
  const llm = writerLlm();

  const bundle = await controller.assembleContext(db, llm, project.id, {
    chapter,
    chapterNumber: 1,
    trace: false,
  });
  const reused = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    bundle,
    skipContinuity: true,
  });
  assert.equal(reused.contextTraceId, undefined, 'a reused bundle starts no assembly trace');

  const written = await controller.writeChapter(db, llm, project.id, {
    chapterNumber: 1,
    skipContinuity: true,
  });
  assert.ok(written.contextTraceId, 'writing that assembles returns the trace id');
  assert.ok(trace.showTrace(db, written.contextTraceId!), 'the returned trace exists');

  const approved = await controller.approveChapter(db, llm, project.id, 1);
  assert.ok(approved.contextTraceId, 'approval re-assembly exposes a trace id');
  assert.ok(trace.showTrace(db, approved.contextTraceId!), 'the approval trace exists');
  const audit = trace.auditTrace(db, approved.contextTraceId!);
  assert.deepEqual(audit?.violations, []);
  db.close();
});

test('the check command prints the trace id for its actual assembly', async () => {
  const { db, path } = tempDb();
  const { project } = approvedProject(db, 'context-check-cli');
  await controller.writeChapter(db, writerLlm(), project.id, {
    chapterNumber: 1,
    skipContinuity: true,
  });
  controller.updateProjectSettings(db, project.id, { provider: 'mock', model: 'mock' });
  db.close();
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', CLI, '--db', path, '--project', project.name, 'check', '1'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /trace tr-/);
});

test('nested span wrappers retain inner ownership and parentage', () => {
  const buffer = trace.createRetrievalTraceBuffer();
  const outer = trace.withRetrievalTraceSpan(buffer, 'sp-outer');
  const inner = trace.withRetrievalTraceSpan(outer, 'sp-inner', 'sp-outer');
  inner.emit({ event: 'inner.event', subject: 'inner' });
  outer.emit({ event: 'outer.event', subject: 'outer' });
  assert.equal(buffer.events[0]?.spanId, 'sp-inner');
  assert.equal(buffer.events[0]?.parentSpanId, 'sp-outer');
  assert.equal(buffer.events[1]?.spanId, 'sp-outer');
  assert.equal(buffer.events[1]?.parentSpanId, null);
});

test('a retrieval-selected passage excluded from the canon brief is not a retrieval failure', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'context-excluded');
  const preloadChunks: number[] = [];
  const retrievalChunks: number[] = [];
  for (let i = 0; i < 4; i++) {
    preloadChunks.push(addChunk(db, project.id, 100 + i, `Preload marker ${i}. Quiet stone and rain.`));
  }
  for (let i = 0; i < 6; i++) {
    retrievalChunks.push(addChunk(db, project.id, 200 + i, `Bridge beacon ${i}. Serena crosses the bridge at Ardenne before dawn.`));
  }
  const eventIds = preloadChunks.map((chunkId, i) => addEvent(db, project.id, chunkId, i + 1));
  const chapter = chapterOutline({
    goal: 'bridge beacon',
    synopsis: '',
    characters: [],
    scenes: [],
    canonEventIds: eventIds,
  });

  let traceId: string | undefined;
  const bundle = await controller.assembleContext(db, contextLlm(), project.id, {
    chapter,
    chapterNumber: 1,
    canonWords: 900,
    onTraceId: (id) => {
      traceId = id;
    },
  });
  assert.ok(traceId);
  assert.ok(bundle.retrieval);
  assert.equal(bundle.retrieval.passages.length, 6);
  const selectedChunk = bundle.retrieval.passages.at(-1)!.chunkId;
  assert.ok(!preloadChunks.includes(selectedChunk));
  const list = events(db, traceId!);
  assert.ok(
    list.some(
      (event) =>
        event.event === 'retrieval.candidate.disposition' &&
        event.decision === 'selected' &&
        event.subject === `chunk:${selectedChunk}`,
    ),
    'retrieval selected the passage',
  );
  const disposition = list.find(
    (event) =>
      event.event === 'context.item.disposition' &&
      event.subject === `chunk:${selectedChunk}`,
  );
  assert.equal(disposition?.decision, 'excluded');
  assert.equal(disposition?.reasonCode, 'brief-input-cap');
  assert.ok(
    list.some(
      (event) =>
        event.event === 'context.item.disposition' &&
        event.subject.startsWith('event:canon:') &&
        event.decision === 'included',
    ),
    'preloaded canon events are context items too',
  );
  const audit = trace.auditTrace(db, traceId!);
  assert.deepEqual(audit?.violations, []);
  db.close();
});

test('multi-origin passages merge to one terminal context disposition', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'context-multi-origin');
  const preload = addChunk(db, project.id, 300, 'Bridge beacon preload. Serena crosses the bridge at Ardenne before dawn.');
  for (let i = 0; i < 5; i++) {
    addChunk(db, project.id, 310 + i, `Bridge beacon ${i}. Serena crosses the bridge at Ardenne before dawn.`);
  }
  const eventId = addEvent(db, project.id, preload, 1);
  const chapter = chapterOutline({
    goal: 'bridge beacon',
    synopsis: '',
    characters: [],
    scenes: [],
    canonEventIds: [eventId],
  });

  let traceId: string | undefined;
  await controller.assembleContext(db, contextLlm(), project.id, {
    chapter,
    chapterNumber: 1,
    canonWords: 900,
    onTraceId: (id) => {
      traceId = id;
    },
  });
  const list = events(db, traceId!);
  const generated = list.filter(
    (event) => event.event === 'context.item.generated' && event.subject === `chunk:${preload}`,
  );
  const dispositions = list.filter(
    (event) => event.event === 'context.item.disposition' && event.subject === `chunk:${preload}`,
  );
  assert.ok(generated.length >= 2, 'preload and retrieval both contribute');
  assert.equal(dispositions.length, 1);
  assert.equal(dispositions[0]?.decision, 'included');
  db.close();
});

test('second hop supersedes hop 1 and contributes only hop 2', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'context-second-hop');
  db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE project_id = ?', project.id);
  const chunks = db.all<{ id: number; locator: string }>(
    'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    project.id,
  );
  assert.ok(chunks.length >= 3);
  const refs = JSON.stringify([
    { source: 'Probe', locator: chunks[0]!.locator, chunk: chunks[0]!.id },
    { source: 'Probe', locator: chunks[2]!.locator, chunk: chunks[2]!.id },
  ]);
  const serena = insertEntity(db, project.id, 'Serena Marsh', 'ctx-serena', refs, chunks[0]!.id);
  const kade = insertEntity(db, project.id, 'Kade', 'ctx-kade', refs, chunks[0]!.id);
  insertRelation(db, project.id, serena, kade, 'sibling of', refs);

  // Add enough graph-referenced passages that the final package cannot keep
  // every candidate selected by hop 1.
  const extra: number[] = [];
  for (let i = 0; i < 2; i++) {
    const chunkId = addChunk(
      db,
      project.id,
      500 + i,
      `Extra passage ${i}. Rain on the ridge; the bridge waits.`,
    );
    extra.push(chunkId);
    const extraRefs = JSON.stringify([{ source: 'Probe', locator: `extra-${i}`, chunk: chunkId }]);
    const entity = insertEntity(db, project.id, `Extra ${i}`, `ctx-extra-${i}`, extraRefs, chunkId);
    insertRelation(
      db,
      project.id,
      i === 0 ? kade : Number(db.get<{ id: number }>(
        "SELECT id FROM canon_entity WHERE project_id = ? AND name = ?",
        project.id,
        `Extra ${i - 1}`,
      )!.id),
      entity,
      i === 0 ? 'knows' : 'near',
      extraRefs,
    );
  }

  const chapter = chapterOutline({
    goal: "Who is Serena Marsh's sibling?",
    synopsis: '',
    characters: ['Serena Marsh', 'Kade', 'Ilsa Missing'],
    scenes: [],
  });

  let traceId: string | undefined;
  const bundle = await controller.assembleContext(db, contextLlm(), project.id, {
    chapter,
    chapterNumber: 1,
    hops: 1,
    canonWords: 120,
    onTraceId: (id) => {
      traceId = id;
    },
  });
  assert.ok(bundle.retrieval);
  const finalPackageChunks = new Set(bundle.retrieval.passages.map((passage) => passage.chunkId));
  const list = events(db, traceId!);
  assert.ok(
    list.some(
      (event) =>
        event.event === 'context.child.completed' &&
        event.subject === 'child:retrieve-hop-1' &&
        event.reasonCode === 'superseded',
    ),
    'hop 1 is superseded',
  );
  assert.ok(
    list.some(
      (event) =>
        event.event === 'context.child.completed' &&
        event.subject === 'child:retrieve-hop-2' &&
        event.reasonCode === 'complete',
    ),
    'hop 2 contributes',
  );

  const superseded = list.filter(
    (event) =>
      event.event === 'context.item.disposition' &&
      event.decision === 'superseded' &&
      event.subject.startsWith('hop1:chunk:'),
  );
  assert.ok(superseded.length > 0, 'a superseded hop-1 candidate is recorded');
  for (const disposition of superseded) {
    const key = disposition.subject;
    const sourceChunk = Number(key.slice('hop1:chunk:'.length));
    assert.ok(
      !finalPackageChunks.has(sourceChunk),
      `${key} is absent from the hop-2 final package`,
    );
    const origins = list.filter(
      (event) => event.event === 'context.item.generated' && event.subject === key,
    );
    assert.ok(
      origins.some((event) => event.spanId === 'sp-context-retrieve-hop-1'),
      `${key} keeps its hop-1 origin`,
    );
    assert.equal(
      list.filter((event) => event.event === 'context.item.disposition' && event.subject === key).length,
      1,
      `${key} has one terminal disposition`,
    );
    assert.equal(disposition.decision, 'superseded');
  }
  const hopSummary = list.find(
    (event) => event.event === 'context.summary' && event.subject === 'context:retrieve-hop-1',
  );
  assert.ok(hopSummary);
  assert.equal(hopSummary!.refs.selected_count, 0, 'hop-1 candidates are not finally selected');
  assert.ok(Number(hopSummary!.refs.excluded_count) >= superseded.length);
  const final = list.find(
    (event) => event.event === 'context.summary' && event.subject === 'context:final',
  );
  assert.ok(final);
  assert.ok(Number(final!.refs.raw_count) >= Number(final!.refs.dedup_count));
  assert.ok(Number(final!.refs.selected_count) <= Number(final!.refs.dedup_count));
  assert.ok(
    !list.some(
      (event) =>
        event.event === 'context.item.disposition' &&
        event.subject.startsWith('hop1:chunk:') &&
        event.decision === 'included',
    ),
    'no hop-1 candidate is counted as finally selected',
  );
  const view = trace.showTrace(db, traceId!);
  assert.equal(view?.trace.completeness, 'complete');
  assert.equal(view?.trace.droppedEvents, 0);
  const audit = trace.auditTrace(db, traceId!);
  assert.equal(audit?.exhaustive, true);
  assert.deepEqual(audit?.violations, []);
  db.close();
});

test('required child failure prevents an exhaustive parent audit', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'context-required-failure');
  const traceId = manualTrace(db, project.id, [
    { event: 'context.child.started', subject: 'child:required', reasonCode: 'required', refs: { stage: 'required' } },
    { event: 'context.child.completed', subject: 'child:required', reasonCode: 'failed', refs: { stage: 'required', selected_count: 0 } },
    { event: 'context.coverage', subject: 'context:coverage', decision: 'completed', reasonCode: 'complete', refs: { required_count: 1, incomplete_count: 0, stage: 'coverage' } },
    { event: 'context.summary', subject: 'context:final', decision: 'completed', reasonCode: 'empty', refs: { raw_count: 0, dedup_count: 0, ranked_count: 0, selected_count: 0, budgeted_count: 0, excluded_count: 0, truncated_count: 0, stage: 'context-assembly' } },
    { event: 'context.completed', subject: 'context:bundle', decision: 'completed', reasonCode: 'empty', refs: { count: 0, stage: 'context' } },
  ]);
  const audit = trace.auditTrace(db, traceId);
  assert.equal(audit?.exhaustive, false);
  assert.ok(audit?.violations.some((item) => item.code === 'context_required_child_incomplete'));
  assert.ok(audit?.violations.some((item) => item.code === 'context_parent_overclaims_completeness'));
  db.close();
});

test('optional child failure is a limitation, but a contributing optional child blocks exhaustiveness', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'context-optional-failure');
  const optional = manualTrace(db, project.id, [
    { event: 'context.child.started', subject: 'child:optional', reasonCode: 'best-effort', refs: { stage: 'best-effort' } },
    { event: 'context.child.completed', subject: 'child:optional', reasonCode: 'failed', refs: { stage: 'best-effort', selected_count: 0 } },
    { event: 'context.coverage', subject: 'context:coverage', decision: 'completed', reasonCode: 'complete', refs: { required_count: 0, contributing_count: 0, optional_count: 1, incomplete_count: 0, stage: 'coverage' } },
    { event: 'context.summary', subject: 'context:final', decision: 'completed', reasonCode: 'empty', refs: { raw_count: 0, dedup_count: 0, ranked_count: 0, selected_count: 0, budgeted_count: 0, excluded_count: 0, truncated_count: 0, stage: 'context-assembly' } },
    { event: 'context.completed', subject: 'context:bundle', decision: 'completed', reasonCode: 'empty', refs: { count: 0, stage: 'context' } },
  ]);
  const optionalAudit = trace.auditTrace(db, optional);
  assert.equal(optionalAudit?.exhaustive, true);
  assert.deepEqual(optionalAudit?.violations, []);
  assert.ok(optionalAudit?.limitations.some((item) => item.includes('optional context child')));

  const contributing = manualTrace(db, project.id, [
    { event: 'context.child.started', subject: 'child:optional', reasonCode: 'best-effort', refs: { stage: 'best-effort' } },
    { event: 'context.child.completed', subject: 'child:optional', reasonCode: 'sampled', refs: { stage: 'best-effort', selected_count: 1 } },
    { event: 'context.coverage', subject: 'context:coverage', decision: 'completed', reasonCode: 'complete', refs: { required_count: 0, contributing_count: 1, optional_count: 1, incomplete_count: 1, stage: 'coverage' } },
    { event: 'context.summary', subject: 'context:final', decision: 'completed', reasonCode: 'empty', refs: { raw_count: 0, dedup_count: 0, ranked_count: 0, selected_count: 0, budgeted_count: 0, excluded_count: 0, truncated_count: 0, stage: 'context-assembly' } },
    { event: 'context.completed', subject: 'context:bundle', decision: 'completed', reasonCode: 'empty', refs: { count: 0, stage: 'context' } },
  ]);
  const contributingAudit = trace.auditTrace(db, contributing);
  assert.equal(contributingAudit?.exhaustive, false);
  assert.ok(contributingAudit?.violations.some((item) => item.code === 'context_contributing_child_incomplete'));
  db.close();
});

test('sampled candidate detail keeps summaries and final items but cannot pass an exhaustive audit', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'context-sampled');
  const preloadChunks: number[] = [];
  for (let i = 0; i < 4; i++) {
    preloadChunks.push(addChunk(db, project.id, 400 + i, `Preload marker ${i}. Quiet stone and rain.`));
  }
  for (let i = 0; i < 6; i++) {
    addChunk(db, project.id, 410 + i, `Bridge beacon ${i}. Serena crosses the bridge at Ardenne before dawn.`);
  }
  const eventIds = preloadChunks.map((chunkId, i) => addEvent(db, project.id, chunkId, i + 1));
  const chapter = chapterOutline({
    goal: 'bridge beacon',
    synopsis: '',
    characters: [],
    scenes: [],
    canonEventIds: eventIds,
  });
  let traceId: string | undefined;
  await controller.assembleContext(db, contextLlm(), project.id, {
    chapter,
    chapterNumber: 1,
    canonWords: 900,
    traceCandidateDetailLimit: 1,
    onTraceId: (id) => {
      traceId = id;
    },
  });
  const view = trace.showTrace(db, traceId!);
  assert.equal(view?.trace.completeness, 'sampled');
  assert.equal(view?.trace.droppedEvents, 0);
  const list = view!.events;
  assert.ok(list.some((event) => event.event === 'context.summary' && event.subject === 'context:final'));
  assert.ok(list.some((event) => event.event === 'context.item.disposition' && event.decision === 'included'));
  const audit = trace.auditTrace(db, traceId!);
  assert.equal(audit?.exhaustive, false);
  db.close();
});

test('diagnostic write failure leaves assembly output unchanged', async () => {
  const { db } = tempDb();
  const { project, chapter } = approvedProject(db, 'context-write-failure');
  const plain = await controller.assembleContext(db, contextLlm(), project.id, {
    chapter,
    chapterNumber: 1,
    trace: false,
  });
  db.run(
    `CREATE TRIGGER fail_context_completed
       BEFORE INSERT ON trace_event
       WHEN NEW.event = 'context.completed'
     BEGIN
       SELECT RAISE(ABORT, 'forced context trace failure');
     END`,
  );
  let traceId: string | undefined;
  const traced = await controller.assembleContext(db, contextLlm(), project.id, {
    chapter,
    chapterNumber: 1,
    onTraceId: (id) => {
      traceId = id;
    },
  });
  assert.deepEqual(traced, plain);
  assert.ok(traceId, 'the failing trace still exists');
  const view = trace.showTrace(db, traceId!);
  assert.ok(view);
  assert.ok(
    view!.trace.completeness === 'truncated' || view!.trace.completeness === 'interrupted',
    `observable write loss is incomplete (${view!.trace.completeness})`,
  );
  assert.ok(view!.trace.droppedEvents > 0, 'dropped diagnostic writes are visible');
  const audit = trace.auditTrace(db, traceId!);
  assert.equal(audit?.exhaustive, false);
  assert.ok(audit?.suspicious.some((item) => item.code === 'trace_not_exhaustive'));
  db.close();
});

test('uncited lore is explicit and brief slots carry chunk provenance', async () => {
  const { db } = tempDb();
  const { project, chapter } = approvedProject(db, 'context-uncited');
  const entityId = Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, claim_uid, kind, name, aliases, summary, attributes, role, status,
          first_chunk, evidence, source_refs, mentions, review_status, created_at, updated_at)
       VALUES (?, 'ctx-uncited', 'character', 'Serena Marsh', '[]', '', '{}', '', '',
               NULL, '', '[]', 1, 'accepted', ?, ?)`,
      project.id,
      AT,
      AT,
    ).lastInsertRowid,
  );
  let traceId: string | undefined;
  await controller.assembleContext(db, contextLlm(), project.id, {
    chapter,
    chapterNumber: 1,
    onTraceId: (id) => {
      traceId = id;
    },
  });
  const list = events(db, traceId!);
  assert.ok(
    list.some(
      (event) =>
        event.event === 'context.item.disposition' &&
        event.subject === `brief:lore:entity:${entityId}` &&
        event.reasonCode === 'uncited-lore',
    ),
  );
  assert.ok(
    list.some(
      (event) =>
        event.event === 'context.item.generated' &&
        event.subject === 'brief:canon:S1' &&
        typeof event.refs.chunk_id === 'number',
    ),
  );
  const audit = trace.auditTrace(db, traceId!);
  assert.ok(audit?.limitations.some((item) => item.includes('sentence-level entailment')));
  db.close();
});

test('trace rows contain no raw query or passage prose', async () => {
  const { db } = tempDb();
  const { project, chapter } = approvedProject(db, 'context-prose');
  let traceId: string | undefined;
  await controller.assembleContext(db, contextLlm(), project.id, {
    chapter,
    chapterNumber: 1,
    onTraceId: (id) => {
      traceId = id;
    },
  });
  const view = trace.showTrace(db, traceId!);
  const text = JSON.stringify(view);
  assert.ok(!text.includes(chapter.goal), 'no raw goal');
  assert.ok(!text.includes(chapter.synopsis), 'no raw synopsis');
  assert.ok(!text.includes('The bridge at Ardenne stood'), 'no passage prose');
  assert.ok(!text.includes('Serena took the third lantern'), 'no prompt prose');
  db.close();
});

test('truncated and interrupted context traces are inconclusive', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'context-inconclusive');
  for (const finish of [{ completeness: 'truncated' as const }, { interrupted: true }]) {
    const traceId = manualTrace(
      db,
      project.id,
      [
        {
          event: 'context.item.generated',
          subject: 'chunk:1',
          reasonCode: 'retrieval-package',
          refs: { chunk_id: 1, candidate_id: 'chunk:1', stage: 'retrieve-package' },
        },
        {
          event: 'context.item.disposition',
          subject: 'chunk:1',
          decision: 'included',
          reasonCode: 'included',
          refs: { chunk_id: 1, candidate_id: 'chunk:1', stage: 'context-final' },
        },
      ],
      finish,
    );
    assert.equal(trace.auditTrace(db, traceId)?.exhaustive, false);
  }
  db.close();
});

test('trace show and audit are valid and read-only through the CLI', async () => {
  const { db, path } = tempDb();
  const { project, chapter } = approvedProject(db, 'context-cli');
  let traceId: string | undefined;
  await controller.assembleContext(db, contextLlm(), project.id, {
    chapter,
    chapterNumber: 1,
    onTraceId: (id) => {
      traceId = id;
    },
  });
  db.close();
  const before = createHash('sha256').update(readFileSync(path)).digest('hex');

  const show = spawnSync(process.execPath, ['--no-warnings', CLI, '--db', path, 'trace', 'show', traceId!, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(show.status, 0, show.stderr);
  const view = JSON.parse(show.stdout) as { trace: { id: string }; events: unknown[] };
  assert.equal(view.trace.id, traceId);
  assert.ok(view.events.length > 0);

  const human = spawnSync(process.execPath, ['--no-warnings', CLI, '--db', path, 'trace', 'show', traceId!], {
    encoding: 'utf8',
  });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Context assembly tree/);
  assert.match(human.stdout, /Context handoff/);
  assert.match(human.stdout, /coverage:/);

  const audit = spawnSync(process.execPath, ['--no-warnings', CLI, '--db', path, 'trace', 'audit', traceId!, '--json'], {
    encoding: 'utf8',
  });
  assert.equal(audit.status, 0, audit.stderr);
  const result = JSON.parse(audit.stdout) as { traceId: string; exhaustive: boolean };
  assert.equal(result.traceId, traceId);
  assert.equal(result.exhaustive, true);
  const after = createHash('sha256').update(readFileSync(path)).digest('hex');
  assert.equal(after, before, 'show/audit do not write the database');
});
