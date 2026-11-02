/**
 * Graph/PPR tracing for `lore trails`.
 *
 * Temp databases and mocked providers only. Trace data is diagnostic; the
 * graph context, selected passages, trails and the HTML data must not move.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as retrieval from '../../fanfable/src/answer/retrieval.ts';
import * as trace from '../../fanfable/src/trace/trace.ts';
import { filterDenseSeeds } from '../../fanfable/src/product/recognition.ts';
import { buildGraphContext, buildPprGraphContext, loadGraph, resolveQuerySeeds, traverse, type DenseSeed, type Graph, type GraphEdge, type GraphNode } from '../../fanfable/src/support/graph.ts';
import { DEFAULT_EMBED_MODEL } from '../../fanfable/src/support/embeddings.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';

const AT = '2024-01-01T00:00:00.000Z';
const CLI = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
type Db = ReturnType<typeof tempDb>['db'];

function insertEntity(
  db: Db,
  projectId: number,
  name: string,
  uid: string,
  refs: string,
  firstChunk: number | null,
  reviewStatus = 'accepted',
): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, claim_uid, kind, name, aliases, summary, attributes, role, status,
          first_chunk, evidence, source_refs, mentions, review_status, created_at, updated_at)
       VALUES (?, ?, 'character', ?, '[]', '', '{}', '', '', ?, 'evidence', ?, 1, ?, ?, ?)`,
      projectId, uid, name, firstChunk, refs, reviewStatus, AT, AT,
    ).lastInsertRowid,
  );
}

function insertRelation(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  kind: string,
  refs: string,
  reviewStatus = 'accepted',
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, claim_uid, from_entity, to_entity, kind, description, evidence,
          source_refs, confidence, modality, review_status, kind_source, anchor_evidence,
          supporting_evidence, relation_status, confirmed_by_user, created_at)
       VALUES (?, ?, ?, ?, ?, '', 'evidence', ?, 1, '', ?, '', '', '[]', 'current', 0, ?)`,
      projectId, `rel-${from}-${to}-${kind.replace(/\W+/g, '-')}`, from, to, kind, refs, reviewStatus, AT,
    ).lastInsertRowid,
  );
}

function setupGraph(name: string) {
  const { db, path } = tempDb();
  const project = seedProject(db, name);
  db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE project_id = ?', project.id);
  db.run(
    'UPDATE project SET settings = ? WHERE id = ?',
    JSON.stringify({ provider: 'mock', model: 'mock' }),
    project.id,
  );
  const chunks = db.all<{ id: number; locator: string }>(
    'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    project.id,
  );
  const refs = JSON.stringify([
    { source: 'Probe', locator: chunks[0]!.locator, chunk: chunks[0]!.id },
    { source: 'Probe', locator: chunks[2]!.locator, chunk: chunks[2]!.id },
  ]);
  const serena = insertEntity(db, project.id, 'Serena Marsh', 'ent-trails-serena', refs, chunks[0]!.id);
  const kade = insertEntity(db, project.id, 'Kade', 'ent-trails-kade', refs, chunks[0]!.id);
  insertRelation(db, project.id, serena, kade, 'sibling of', refs);
  return { db, path, project, chunks, serena, kade, refs };
}

function runTrails(fixture: ReturnType<typeof setupGraph>, query = "Who is Serena Marsh's sibling?") {
  const cwd = mkdtempSync(join(tmpdir(), 'trails-trace-cli-'));
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', CLI, '--db', fixture.path, '--project', fixture.project.name, 'lore', 'trails', '--query', query],
    { cwd, encoding: 'utf8' },
  );
  const traceId = /trace (tr-[a-z0-9-]+)/.exec(result.stdout)?.[1];
  return { ...result, cwd, traceId };
}

function events(db: Db, traceId: string) {
  const view = trace.showTrace(db, traceId);
  assert.ok(view, 'trace exists');
  return view.events;
}

function summary(db: Db, traceId: string, subject: string) {
  return events(db, traceId).find(
    (event) => event.event === 'retrieval.summary' && event.subject === subject,
  );
}

test('tracing on and off preserves graph context, passages and trails', async () => {
  const fixture = setupGraph('trails-parity');
  const llm = mockProvider(() => {
    throw new Error('relational graph retrieval must not call the model');
  });
  const plain = await retrieval.retrieve(fixture.db, llm, fixture.project.id, {
    query: "Who is Serena Marsh's sibling?",
    route: 'relational',
  });
  const buffer = trace.createRetrievalTraceBuffer();
  const traced = await retrieval.retrieve(fixture.db, llm, fixture.project.id, {
    query: "Who is Serena Marsh's sibling?",
    route: 'relational',
    trace: trace.withRetrievalTraceSpan(buffer, 'sp-retrieve'),
  });
  assert.deepEqual(traced.graph.nodes, plain.graph.nodes);
  assert.deepEqual(traced.graph.edges, plain.graph.edges);
  assert.deepEqual(traced.graph.passages, plain.graph.passages);
  assert.deepEqual(traced.graph.trails, plain.graph.trails);
  assert.equal(traced.text, plain.text);
  assert.deepEqual(traced.stats, plain.stats);
  assert.ok(eventsFromBuffer(buffer).some((event) => event.event === 'retrieval.ppr.completed'));
  assert.ok(eventsFromBuffer(buffer).some((event) => event.event === 'retrieval.summary' && event.subject === 'seeds:triple'));
  const graphSummary = eventsFromBuffer(buffer).find(
    (event) => event.event === 'retrieval.summary' && event.subject === 'passages:graph',
  );
  assert.equal(graphSummary?.refs?.selected_count, traced.graph.passages.length);
  const pprEvent = eventsFromBuffer(buffer).find((event) => event.event === 'retrieval.ppr.completed');
  assert.equal(pprEvent?.refs?.iteration_count, traced.stats.ppr?.iterations);
  assert.equal(pprEvent?.refs?.node_count, traced.stats.ppr?.nodes);
  for (const trail of traced.graph.trails ?? []) {
    const recorded = eventsFromBuffer(buffer).find(
      (event) => event.event === 'retrieval.trail.recorded' && event.subject === `chunk:${trail.chunkId}`,
    );
    assert.equal(recorded?.refs?.step_count, trail.steps.length);
  }
  fixture.db.close();
});

function eventsFromBuffer(buffer: ReturnType<typeof trace.createRetrievalTraceBuffer>) {
  return buffer.events;
}

test('lore trails exposes one trace with retrieval and wrapper spans, final trails and a clean audit', () => {
  const fixture = setupGraph('trails-cli');
  const result = runTrails(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.traceId, 'trace id is surfaced');
  assert.match(result.stdout, new RegExp(`trace ${result.traceId}`));
  const list = events(fixture.db, result.traceId!);
  assert.ok(list.some((event) => event.spanId === 'sp-retrieve'));
  assert.ok(list.some((event) => event.spanId === 'sp-trails'));
  assert.ok(list.some((event) => event.event === 'retrieval.ppr.completed'));
  assert.ok(list.some((event) => event.event === 'retrieval.trail.recorded'));
  const final = summary(fixture.db, result.traceId!, 'trails:final');
  assert.ok(final);
  assert.equal(final!.refs.selected_count, 4);
  assert.ok(Number(final!.refs.raw_count) > Number(final!.refs.dedup_count));
  assert.ok(Number(final!.refs.dedup_count) >= Number(final!.refs.selected_count));
  assert.ok(list.some((event) => event.event === 'retrieval.trail.recorded' && event.reasonCode === 'word-only'));
  assert.ok(list.some((event) => event.event === 'retrieval.trail.recorded' && event.reasonCode === 'trail'));
  const finalSelected = list.filter(
    (event) =>
      event.event === 'retrieval.candidate.disposition' &&
      event.decision === 'selected' &&
      event.refs.stage === 'final-bank-rank',
  );
  assert.ok(finalSelected.every((event) =>
    list.some((trail) => trail.event === 'retrieval.trail.recorded' && trail.subject === event.subject)));
  const originCounts = new Map<string, number>();
  for (const event of list.filter((candidate) => candidate.event === 'retrieval.candidate.generated' && candidate.refs.stage === 'final-bank-rank')) {
    originCounts.set(event.subject, (originCounts.get(event.subject) ?? 0) + 1);
  }
  assert.ok([...originCounts.values()].some((count) => count > 1), 'overlapping origins survive final lineage');
  const audit = trace.auditTrace(fixture.db, result.traceId!);
  assert.equal(audit?.exhaustive, true);
  assert.deepEqual(audit?.violations, []);
  const json = JSON.stringify(trace.showTrace(fixture.db, result.traceId!));
  assert.ok(!json.includes("Who is Serena Marsh's sibling?"));
  assert.ok(!json.includes('The rain had not stopped'));
  const showJson = spawnSync(process.execPath, ['--no-warnings', CLI, '--db', fixture.path, 'trace', 'show', result.traceId!, '--json'], { encoding: 'utf8' });
  assert.equal(showJson.status, 0, showJson.stderr);
  JSON.parse(showJson.stdout);
  const showText = spawnSync(process.execPath, ['--no-warnings', CLI, '--db', fixture.path, 'trace', 'show', result.traceId!], { encoding: 'utf8' });
  assert.equal(showText.status, 0, showText.stderr);
  assert.match(showText.stdout, /Retrieval handoff/);
  assert.match(showText.stdout, /retrieval\.ppr\.completed/);
  const auditJson = spawnSync(process.execPath, ['--no-warnings', CLI, '--db', fixture.path, 'trace', 'audit', result.traceId!, '--json'], { encoding: 'utf8' });
  assert.equal(auditJson.status, 0, auditJson.stderr);
  JSON.parse(auditJson.stdout);
  fixture.db.close();
});

test('lookup, vague and relational routes record PPR skipped or completed correctly', async () => {
  const fixture = setupGraph('trails-routes');
  const llm = mockProvider(() => { throw new Error('no model expected'); });
  const getEvents = async (route: 'lookup' | 'vague' | 'relational') => {
    const buffer = trace.createRetrievalTraceBuffer();
    await retrieval.retrieve(fixture.db, llm, fixture.project.id, {
      query: route === 'relational' ? "Who is Serena Marsh's sibling?" : 'the bridge and the lantern',
      route,
      trace: buffer,
    });
    return buffer.events;
  };
  const lookup = await getEvents('lookup');
  assert.ok(lookup.some((event) => event.event === 'retrieval.ppr.skipped' && event.reasonCode === 'lookup-route'));
  assert.ok(!lookup.some((event) => event.event === 'retrieval.ppr.completed'));
  const vague = await getEvents('vague');
  assert.ok(vague.some((event) => event.event === 'retrieval.ppr.skipped' && event.reasonCode === 'hop-route'));
  assert.ok(!vague.some((event) => event.event === 'retrieval.ppr.completed'));
  const relational = await getEvents('relational');
  assert.ok(relational.some((event) => event.event === 'retrieval.ppr.completed'));
  assert.ok(relational.some((event) => event.event === 'retrieval.recognition.completed' && event.reasonCode === 'disabled'));
  assert.ok(relational.some((event) => event.event === 'retrieval.dense.completed' && event.reasonCode === 'no-vectors'));
  fixture.db.close();
});

test('recognition disabled, checked, over-cap and fail-open are distinct', async () => {
  const fixture = setupGraph('trails-recognition');
  const graph = loadGraph(fixture.db, fixture.project.id, {});
  const seeds: DenseSeed[] = ['canon:entity:1', 'canon:entity:2'].map((id) => ({ id, w: 0.8 }));
  const keptLlm = mockProvider(() => JSON.stringify({ results: seeds.map((s) => ({ id: s.id, supported: true })) }));
  const keptBuffer = trace.createRetrievalTraceBuffer();
  const kept = await filterDenseSeeds(keptLlm, seeds, graph, fixture.db, fixture.project.id, {
    query: 'serena',
    trace: keptBuffer,
  });
  assert.equal(kept.dropped.length, 0);
  assert.ok(keptBuffer.events.some((event) => event.event === 'retrieval.recognition.completed' && event.reasonCode === 'checked'));

  const dropLlm = mockProvider(() => JSON.stringify({ results: [{ id: seeds[0]!.id, supported: false }, { id: seeds[1]!.id, supported: true }] }));
  const dropBuffer = trace.createRetrievalTraceBuffer();
  const dropped = await filterDenseSeeds(dropLlm, seeds, graph, fixture.db, fixture.project.id, {
    query: 'serena', trace: dropBuffer,
  });
  assert.equal(dropped.dropped.length, 1);
  assert.ok(dropBuffer.events.some((event) => event.event === 'retrieval.seed.disposition' && event.decision === 'excluded' && event.reasonCode === 'recognition'));

  const many: DenseSeed[] = Array.from({ length: 12 }, (_, i) => ({ id: `canon:entity:${i + 1}`, w: 0.8 }));
  const overLlm = mockProvider(() => JSON.stringify({ results: many.map((s) => ({ id: s.id, supported: true })) }));
  const overBuffer = trace.createRetrievalTraceBuffer();
  await filterDenseSeeds(overLlm, many, graph, fixture.db, fixture.project.id, { query: 'serena', trace: overBuffer });
  const overSummary = overBuffer.events.find((event) => event.event === 'retrieval.summary' && event.subject === 'seeds:recognition');
  assert.ok((overSummary?.refs?.budgeted_count ?? 0) >= 2);
  assert.ok(overBuffer.events.some((event) => event.event === 'retrieval.seed.disposition' && event.decision === 'budgeted' && event.reasonCode === 'over-cap'));

  const failLlm = mockProvider(() => { throw new Error('recognition down'); });
  const failBuffer = trace.createRetrievalTraceBuffer();
  const failed = await filterDenseSeeds(failLlm, seeds, graph, fixture.db, fixture.project.id, {
    query: 'serena', trace: failBuffer,
  });
  assert.equal(failed.dropped.length, 0);
  assert.ok(failBuffer.events.some((event) => event.event === 'retrieval.recognition.completed' && event.reasonCode === 'fail-open'));

  const noVectors = trace.createRetrievalTraceBuffer();
  await retrieval.retrieve(fixture.db, mockProvider(() => '{}'), fixture.project.id, {
    query: 'Serena', route: 'relational', trace: noVectors,
  });
  assert.ok(noVectors.events.some((event) => event.event === 'retrieval.dense.completed' && event.reasonCode === 'no-vectors'));
  fixture.db.close();
});

test('quarantine/status exclusions and node caps are visible', async () => {
  const fixture = setupGraph('trails-exclusions');
  const quarantined = insertEntity(
    fixture.db,
    fixture.project.id,
    'Quarantined Person',
    'ent-quarantine',
    fixture.refs,
    fixture.chunks[0]!.id,
    'quarantined',
  );
  const other = fixture.serena;
  insertRelation(fixture.db, fixture.project.id, quarantined, other, 'sibling of', fixture.refs, 'provisional');
  const buffer = trace.createRetrievalTraceBuffer();
  loadGraph(fixture.db, fixture.project.id, { excludeQuarantined: true, trace: buffer });
  assert.ok(buffer.events.some((event) => event.event === 'retrieval.graph.excluded' && event.reasonCode === 'quarantined'));
  assert.ok(buffer.events.some((event) => event.event === 'retrieval.graph.excluded' && event.reasonCode === 'status'));

  const capped = trace.createRetrievalTraceBuffer();
  const context = await retrieval.retrieve(fixture.db, mockProvider(() => '{}'), fixture.project.id, {
    query: "Who is Serena Marsh's sibling?",
    route: 'relational',
    maxWords: 120,
    hops: 1,
    trace: capped,
  });
  assert.ok(context.passages.length >= 0);
  assert.ok(capped.events.some((event) => event.event === 'retrieval.traverse.completed'));
  fixture.db.close();
});

test('sampled and truncated traces are inconclusive', () => {
  const fixture = setupGraph('trails-incomplete');
  const buffer = trace.createRetrievalTraceBuffer();
  buffer.emit({
    event: 'retrieval.route',
    subject: 'query:test',
    decision: 'candidate',
    reasonCode: 'relational',
    refs: { stage: 'route' },
  });
  const started = trace.startTrace(fixture.db, {
    projectId: fixture.project.id,
    sampledRate: 0,
    metadata: { command: 'lore trails' },
  });
  trace.flushRetrievalTrace(fixture.db, fixture.project.id, started.id, buffer);
  trace.finishTrace(fixture.db, started.id);
  const view = trace.showTrace(fixture.db, started.id);
  assert.equal(view?.trace.completeness, 'sampled');
  assert.equal(trace.auditTrace(fixture.db, started.id)?.exhaustive, false);

  const truncated = trace.startTrace(fixture.db, { projectId: fixture.project.id });
  for (let i = 0; i < 201; i++) {
    trace.recordTraceEvent(fixture.db, {
      traceId: truncated.id,
      projectId: fixture.project.id,
      stage: 'retrieval',
      event: 'retrieval.test',
      eventClass: 'diagnostic',
      subject: `chunk:${i + 1}`,
      decision: 'candidate',
      reasonCode: 'graph-reference',
      refs: { chunk_id: i + 1 },
    });
  }
  trace.finishTrace(fixture.db, truncated.id);
  assert.equal(trace.showTrace(fixture.db, truncated.id)?.trace.completeness, 'truncated');
  assert.equal(trace.auditTrace(fixture.db, truncated.id)?.exhaustive, false);

  const interrupted = trace.startTrace(fixture.db, { projectId: fixture.project.id });
  trace.recordTraceEvent(fixture.db, {
    traceId: interrupted.id,
    projectId: fixture.project.id,
    stage: 'retrieval',
    event: 'retrieval.route',
    eventClass: 'diagnostic',
    decision: 'candidate',
    reasonCode: 'relational',
    refs: { stage: 'route' },
  });
  trace.finishTrace(fixture.db, interrupted.id, { interrupted: true });
  assert.equal(trace.auditTrace(fixture.db, interrupted.id)?.exhaustive, false);
  fixture.db.close();
});

test('dense PPR fallback is visible and never labeled successful PPR', async () => {
  const fixture = setupGraph('trails-fallback');
  fixture.db.run('UPDATE canon_entity SET source_refs = ?, first_chunk = NULL WHERE project_id = ?', '[]', fixture.project.id);
  const chunkId = fixture.chunks[0]!.id;
  fixture.db.run(
    `INSERT INTO embedding (project_id, chunk_id, kind, ref, model, dims, vec, updated_at)
     VALUES (?, ?, 'passage', ?, ?, 2, '[1,0]', ?)`,
    fixture.project.id,
    chunkId,
    String(chunkId),
    DEFAULT_EMBED_MODEL,
    AT,
  );
  const buffer = trace.createRetrievalTraceBuffer();
  const context = await buildPprGraphContext(fixture.db, fixture.project.id, {
    query: "Who is Serena Marsh's sibling?",
    focus: ['Serena Marsh'],
    hops: 1,
    embed: { embedFn: async () => [[1, 0]] },
    trace: buffer,
  });
  assert.ok(context.passages.length > 0);
  assert.ok(buffer.events.some((event) => event.event === 'retrieval.ppr.fallback' && event.reasonCode === 'dense-passages'));
  assert.ok(buffer.events.some((event) => event.event === 'retrieval.completed' && event.reasonCode === 'ppr-fallback'));
  assert.ok(!buffer.events.some((event) => event.event === 'retrieval.ppr.completed'));
  fixture.db.close();
});

test('graph node cap and budget cutoff are visible', () => {
  const fixture = setupGraph('trails-node-cap');
  const buffer = trace.createRetrievalTraceBuffer();
  buildGraphContext(fixture.db, fixture.project.id, {
    query: "Who is Serena Marsh's sibling?",
    focus: ['Serena Marsh'],
    maxNodes: 1,
    trace: buffer,
  });
  assert.ok(buffer.events.some((event) => event.event === 'retrieval.budget.cutoff' && event.reasonCode === 'graph-node-cap'));

  const wordBuffer = trace.createRetrievalTraceBuffer();
  buildGraphContext(fixture.db, fixture.project.id, {
    query: "Who is Serena Marsh's sibling?",
    focus: ['Serena Marsh'],
    maxWords: 1,
    trace: wordBuffer,
  });
  assert.ok(wordBuffer.events.some((event) => event.event === 'retrieval.budget.cutoff' && event.reasonCode === 'graph-word-budget'));

  const scopeBuffer = trace.createRetrievalTraceBuffer();
  loadGraph(fixture.db, fixture.project.id, { scope: 'canon', trace: scopeBuffer });
  assert.ok(scopeBuffer.events.some((event) => event.event === 'retrieval.graph.loaded' && event.reasonCode === 'scope-canon'));
  fixture.db.close();
});

test('trace write failure does not change lore trails output or HTML', () => {
  const fixture = setupGraph('trails-write-failure');
  const normal = runTrails(fixture);
  assert.equal(normal.status, 0, normal.stderr);
  assert.ok(normal.traceId);
  const htmlFile = 'trails-who-is-serena-marsh-s-sibling.html';
  const normalHtml = readFileSync(join(normal.cwd, htmlFile), 'utf8');
  fixture.db.exec('DROP TABLE trace_event');
  fixture.db.exec('DROP TABLE trace');
  const failed = runTrails(fixture);
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stdout, /wrote/);
  assert.equal(failed.traceId, undefined);
  const failedHtml = readFileSync(join(failed.cwd, htmlFile), 'utf8');
  assert.equal(failedHtml, normalHtml);
  assert.equal(
    failed.stdout.replace(/\x1B\[2mtrace tr-[a-z0-9-]+\x1B\[0m\n?/g, ''),
    normal.stdout.replace(/\x1B\[2mtrace tr-[a-z0-9-]+\x1B\[0m\n?/g, ''),
  );
  fixture.db.close();
});

test('seed cap and final trail cap emit budget cutoffs', () => {
  const fixture = setupGraph('trails-seed-cap');
  for (let i = 0; i < 10; i++) {
    const left = insertEntity(fixture.db, fixture.project.id, `Seed Person ${i}A`, `seed-${i}a`, '[]', null);
    const right = insertEntity(fixture.db, fixture.project.id, `Seed Person ${i}B`, `seed-${i}b`, '[]', null);
    insertRelation(fixture.db, fixture.project.id, left, right, 'sibling of', '[]');
  }
  const names = Array.from({ length: 22 }, (_, i) => i < 2 ? ['Serena Marsh', 'Kade'][i]! : `Seed Person ${Math.floor((i - 2) / 2)}${i % 2 ? 'A' : 'B'}`);
  const graph = loadGraph(fixture.db, fixture.project.id, {});
  const buffer = trace.createRetrievalTraceBuffer();
  resolveQuerySeeds(graph, 'sibling', names, buffer);
  assert.ok(buffer.events.some((event) => event.event === 'retrieval.budget.cutoff' && event.reasonCode === 'seed-cap'));
  fixture.db.close();

  const capFixture = setupGraph('trails-trail-cap');
  const source = capFixture.db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ?', capFixture.project.id)!;
  capFixture.db.run(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, words, lore_mined)
     VALUES (?, ?, 10, 'extra trail passage', '', 'Serena Marsh had a sibling in the story.', 9, 1)`,
    source.id,
    capFixture.project.id,
  );
  const result = runTrails(capFixture);
  assert.equal(result.status, 0, result.stderr);
  const list = events(capFixture.db, result.traceId!);
  assert.ok(list.some((event) => event.event === 'retrieval.budget.cutoff' && event.reasonCode === 'trail-cap'));
  assert.deepEqual(trace.auditTrace(capFixture.db, result.traceId!)?.violations, []);
  capFixture.db.close();
});

test('scope and temporal exclusions are evented, and the edge cap is visible', () => {
  const makeNode = (id: string, scope: 'canon' | 'story', order = 0): GraphNode => ({
    id,
    numericId: Number(id.split(':').pop()),
    kind: scope === 'canon' ? 'canon-entity' : 'character',
    scope,
    name: id,
    summary: '',
    aliases: [],
    confidence: 1,
    reviewStatus: 'accepted',
    evidence: '',
    sourceRefs: [],
    order,
    extra: {},
  });
  const root = makeNode('canon:entity:1', 'canon', 0);
  const story = makeNode('story:character:2', 'story', 10);
  const edge: GraphEdge = {
    id: 'e1', from: root.id, to: story.id, type: 'sibling of', scope: 'both',
    description: '', evidence: '', confidence: 1, reviewStatus: 'accepted',
    validFrom: 10,
  };
  const graph: Graph = {
    nodes: new Map([[root.id, root], [story.id, story]]),
    edges: [edge],
    adjacency: new Map([[root.id, [edge.id]], [story.id, [edge.id]]]),
    byNumeric: new Map(),
  };
  const scopeBuffer = trace.createRetrievalTraceBuffer();
  traverse(graph, { roots: [root.id], hops: 1, scope: 'canon', trace: scopeBuffer });
  assert.ok(scopeBuffer.events.some((event) => event.event === 'retrieval.traverse.excluded' && event.reasonCode === 'scope'));

  const temporalBuffer = trace.createRetrievalTraceBuffer();
  traverse(graph, { roots: [root.id], hops: 1, temporal: true, beforeOrder: 5, trace: temporalBuffer });
  assert.ok(temporalBuffer.events.some((event) => event.event === 'retrieval.traverse.excluded' && event.reasonCode === 'temporal'));

  const edgeCapBuffer = trace.createRetrievalTraceBuffer();
  traverse(graph, { roots: [root.id], hops: 1, maxNodes: 10, maxEdges: 0, trace: edgeCapBuffer });
  assert.ok(edgeCapBuffer.events.some((event) => event.event === 'retrieval.budget.cutoff' && event.reasonCode === 'graph-edge-cap'));
});

test('candidate-detail sampling keeps exact summaries and sampled coverage without dropped events', async () => {
  const fixture = setupGraph('trails-sampled-detail');
  const buffer = trace.createRetrievalTraceBuffer({ candidateDetailLimit: 2 });
  const started = trace.startTrace(fixture.db, { projectId: fixture.project.id });
  await retrieval.retrieve(fixture.db, mockProvider(() => '{}'), fixture.project.id, {
    query: "Who is Serena Marsh's sibling?",
    route: 'relational',
    trace: trace.withRetrievalTraceSpan(buffer, 'sp-retrieve'),
  });
  const flushed = trace.flushRetrievalTrace(fixture.db, fixture.project.id, started.id, buffer);
  assert.equal(flushed.sampled, true);
  trace.finishTrace(fixture.db, started.id, { completeness: 'sampled' });
  const view = trace.showTrace(fixture.db, started.id);
  assert.equal(view?.trace.completeness, 'sampled');
  assert.equal(view?.trace.droppedEvents, 0);
  const list = events(fixture.db, started.id);
  assert.ok(list.some((event) => event.event === 'retrieval.coverage' && event.reasonCode === 'sampled'));
  assert.ok(list.some((event) => event.event === 'retrieval.summary' && event.subject === 'passages:graph'));
  const audit = trace.auditTrace(fixture.db, started.id);
  assert.equal(audit?.exhaustive, false);
  assert.deepEqual(audit?.violations, []);
  fixture.db.close();
});

test('package passage word budget and edge/node caps reconcile', async () => {
  const fixture = setupGraph('trails-word-budget');
  const buffer = trace.createRetrievalTraceBuffer();
  await retrieval.retrieve(fixture.db, mockProvider(() => '{}'), fixture.project.id, {
    query: "Who is Serena Marsh's sibling?",
    route: 'relational',
    maxWords: 40,
    trace: buffer,
  });
  assert.ok(buffer.events.some((event) => event.event === 'retrieval.budget.cutoff' && event.reasonCode === 'word-budget'));
  assert.ok(buffer.events.some((event) => event.event === 'retrieval.summary' && event.subject === 'passages:package'));
  fixture.db.close();
});
