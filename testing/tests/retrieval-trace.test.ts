/**
 * Retrieval tracing for the actual lore ask path.
 *
 * Temp databases and MockProvider only. The trace is diagnostic: tracing on
 * and off must produce the same passages and the same answer-model input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import * as lore from '../../fanfable/src/answer/lore.ts';
import { answerLoreQuestion, formatPassages } from '../../fanfable/src/answer/lore-ask.ts';
import * as trace from '../../fanfable/src/trace/trace.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

const AT = '2024-01-01T00:00:00.000Z';
const CLI = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
type Db = ReturnType<typeof tempDb>['db'];

function answerMock(answer: string, expanded: string[] = ['Ardenne', 'bridge'], prompts: string[] = []) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('expand a lore question')) return JSON.stringify({ terms: expanded });
    if (system.includes('Lore Researcher')) {
      prompts.push(req.messages[0]?.content ?? '');
      return answer;
    }
    return '{}';
  });
}

function events(db: Db, traceId: string) {
  const view = trace.showTrace(db, traceId);
  assert.ok(view, 'trace exists');
  return view.events;
}

function selectedChunks(db: Db, traceId: string): number[] {
  return events(db, traceId)
    .filter(
      (event) =>
        event.stage === 'retrieval' &&
        event.event === 'retrieval.candidate.disposition' &&
        event.decision === 'selected' &&
        event.subject.startsWith('chunk:'),
    )
    .map((event) => Number(event.refs.chunk_id));
}

function insertEntity(
  db: Db,
  projectId: number,
  name: string,
  uid: string,
  reviewStatus = 'accepted',
): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, claim_uid, kind, name, aliases, summary, attributes, role, status,
          first_chunk, evidence, source_refs, mentions, review_status, created_at, updated_at)
       VALUES (?, ?, 'character', ?, '[]', '', '{}', '', '', NULL, '', '[]', 1, ?, ?, ?)`,
      projectId,
      uid,
      name,
      reviewStatus,
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function insertRelation(
  db: Db,
  projectId: number,
  from: number,
  to: number,
  kind: string,
  reviewStatus: string,
  confirmedByUser: number,
  sourceRefs: string,
): number {
  return Number(
    db.run(
      `INSERT INTO canon_relation
         (project_id, claim_uid, from_entity, to_entity, kind, description, evidence,
          source_refs, confidence, modality, review_status, kind_source, anchor_evidence,
          supporting_evidence, relation_status, confirmed_by_user, created_at)
       VALUES (?, ?, ?, ?, ?, '', 'evidence', ?, 1, '', ?, '', '', '[]', 'current', ?, ?)`,
      projectId,
      `rel-${from}-${to}-${kind.replace(/\\W+/g, '-')}`,
      from,
      to,
      kind,
      sourceRefs,
      reviewStatus,
      confirmedByUser,
      AT,
    ).lastInsertRowid,
  );
}

function runCli(path: string, args: string[]) {
  return spawnSync(process.execPath, ['--no-warnings', CLI, '--db', path, ...args], {
    encoding: 'utf8',
  });
}

test('tracing on and off leaves passages, scores, citations and answer input identical', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'trace-equivalence');
  const prompts: string[] = [];
  const llm = answerMock('Bridge answer [S1].', ['Ardenne', 'bridge'], prompts);

  const plain = await answerLoreQuestion(db, llm, project.id, 'Where is the bridge?', { limit: 2 });
  const traced = await answerLoreQuestion(db, llm, project.id, 'Where is the bridge?', {
    limit: 2,
    trace: { enabled: true },
  });

  assert.deepEqual(traced.passages, plain.passages);
  assert.equal(traced.answer, plain.answer);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0], prompts[1], 'tracing does not change the answer-model input');
  assert.equal(formatPassages(traced.passages), formatPassages(plain.passages));
  assert.ok(traced.traceId);
  assert.equal(plain.traceId, undefined);
  assert.deepEqual(selectedChunks(db, traced.traceId!), traced.passages.map((p) => p.chunkId));
  db.close();
});

test('FTS tracing records search, selected evidence, budget and a verifying audit', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'trace-fts');
  const llm = answerMock('Bridge answer [S1].');
  const res = await answerLoreQuestion(db, llm, project.id, 'bridge', {
    limit: 1,
    trace: { enabled: true },
  });
  assert.equal(res.passages.length, 1);
  assert.ok(res.traceId);
  const list = events(db, res.traceId!);
  const search = list.find((event) => event.event === 'retrieval.search.completed' && event.subject === 'search:fts');
  assert.ok(search);
  assert.ok(Number(search!.refs.count) > 0);
  const selected = list.filter(
    (event) =>
      event.event === 'retrieval.candidate.disposition' &&
      event.decision === 'selected' &&
      event.subject.startsWith('chunk:'),
  );
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.refs.rank, 1);
  assert.equal(typeof selected[0]!.refs.score, 'number');
  assert.equal(selected[0]!.refs.stage, 'bank-rank');
  const cutoff = list.find((event) => event.event === 'retrieval.budget.cutoff');
  assert.ok(cutoff);
  assert.ok(Number(cutoff!.refs.count) > 0);
  assert.equal(cutoff!.reasonCode, 'passage-limit');
  const summary = list.find((event) => event.event === 'retrieval.summary' && event.subject === 'search:fts');
  assert.deepEqual(
    [
      summary?.refs.raw_count,
      summary?.refs.dedup_count,
      summary?.refs.ranked_count,
      summary?.refs.selected_count,
      summary?.refs.budgeted_count,
      summary?.refs.excluded_count,
    ],
    [4, 4, 4, 1, 3, 0],
  );
  assert.equal(cutoff?.refs.count, summary?.refs.budgeted_count);
  const completed = list.find((event) => event.event === 'retrieval.completed');
  assert.equal(completed?.reasonCode, 'ok');
  const audit = trace.auditTrace(db, res.traceId!);
  assert.equal(audit?.completeness, 'complete');
  assert.equal(audit?.exhaustive, true);
  assert.deepEqual(audit?.violations, []);
  db.close();
});

test('bank-linked candidates merge without duplicate dispositions', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'trace-bank');
  const serena = insertEntity(db, project.id, 'Serena Marsh', 'ent-trace-serena');
  const kade = insertEntity(db, project.id, 'Kade', 'ent-trace-kade');
  const chunks = db.all<{ id: number; locator: string }>(
    'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    project.id,
  );
  const refs = JSON.stringify([
    { source: 'Probe', locator: chunks[0]!.locator, chunk: chunks[0]!.id },
    { source: 'Probe', locator: chunks[2]!.locator, chunk: chunks[2]!.id },
  ]);
  insertRelation(db, project.id, serena, kade, 'accompanied by', 'accepted', 0, refs);
  const llm = answerMock('Serena answer [S1].', ['Serena Marsh']);
  const res = await answerLoreQuestion(db, llm, project.id, 'Serena Marsh', {
    limit: 8,
    trace: { enabled: true },
  });
  assert.ok(res.traceId);
  const list = events(db, res.traceId!);
  const selectedBank = list.filter(
    (event) =>
      event.event === 'retrieval.candidate.disposition' &&
      event.decision === 'selected' &&
      event.subject === `chunk:${chunks[2]!.id}`,
  );
  assert.equal(selectedBank.length, 1, 'deduplicated terminal disposition');
  assert.ok(
    list.some(
      (event) =>
        event.event === 'retrieval.candidate.generated' &&
        event.subject === `chunk:${chunks[2]!.id}` &&
        event.reasonCode === 'bank-linked',
    ),
  );
  const chunk1Reasons = new Set(
    list
      .filter(
        (event) =>
          event.event === 'retrieval.candidate.generated' &&
          event.subject === `chunk:${chunks[0]!.id}`,
      )
      .map((event) => event.reasonCode),
  );
  assert.ok(chunk1Reasons.has('fts'));
  assert.ok(chunk1Reasons.has('bank-linked'));
  const summary = list.find((event) => event.event === 'retrieval.summary' && event.subject === 'search:fts');
  assert.deepEqual(
    [
      summary?.refs.raw_count,
      summary?.refs.dedup_count,
      summary?.refs.ranked_count,
      summary?.refs.selected_count,
      summary?.refs.budgeted_count,
      summary?.refs.excluded_count,
    ],
    [5, 4, 4, 4, 0, 0],
  );
  const audit = trace.auditTrace(db, res.traceId!);
  assert.deepEqual(audit?.violations, []);
  db.close();
});

test('empty results and index-only results complete with the right mode and no fabricated passages', async () => {
  const emptyFixture = tempDb();
  const emptyProject = seedProject(emptyFixture.db, 'trace-empty');
  const empty = await answerLoreQuestion(
    emptyFixture.db,
    answerMock('unused', ['unicorn']),
    emptyProject.id,
    'Who is the unicorn keeper?',
    { trace: { enabled: true } },
  );
  assert.deepEqual(empty.passages, []);
  assert.ok(empty.traceId);
  const emptyView = trace.showTrace(emptyFixture.db, empty.traceId!);
  assert.equal(emptyView?.trace.metadata.mode, 'fts');
  assert.ok(events(emptyFixture.db, empty.traceId!).some((event) => event.event === 'retrieval.completed' && event.reasonCode === 'empty'));
  const emptySummary = events(emptyFixture.db, empty.traceId!).find(
    (event) => event.event === 'retrieval.summary' && event.subject === 'search:fts',
  );
  assert.deepEqual(
    [
      emptySummary?.refs.raw_count,
      emptySummary?.refs.dedup_count,
      emptySummary?.refs.ranked_count,
      emptySummary?.refs.selected_count,
      emptySummary?.refs.budgeted_count,
      emptySummary?.refs.excluded_count,
    ],
    [0, 0, 0, 0, 0, 0],
  );
  assert.equal(trace.auditTrace(emptyFixture.db, empty.traceId!)?.exhaustive, true);
  emptyFixture.db.close();

  const indexFixture = tempDb();
  const indexProject = seedProject(indexFixture.db, 'trace-index');
  insertEntity(indexFixture.db, indexProject.id, 'Unique Index Person', 'ent-trace-index');
  const index = await answerLoreQuestion(
    indexFixture.db,
    answerMock('Index answer.', []),
    indexProject.id,
    'Unique Index Person',
    { trace: { enabled: true } },
  );
  assert.deepEqual(index.passages, []);
  assert.equal(index.grounded, true);
  assert.ok(index.traceId);
  const indexView = trace.showTrace(indexFixture.db, index.traceId!);
  assert.equal(indexView?.trace.metadata.mode, 'index-only');
  assert.ok(events(indexFixture.db, index.traceId!).some((event) => event.event === 'retrieval.search.completed' && event.subject === 'search:index'));
  assert.ok(events(indexFixture.db, index.traceId!).some((event) => event.event === 'retrieval.completed' && event.reasonCode === 'index-only'));
  const indexSummary = events(indexFixture.db, index.traceId!).find(
    (event) => event.event === 'retrieval.summary' && event.subject === 'search:index:entity',
  );
  assert.deepEqual(
    [
      indexSummary?.refs.raw_count,
      indexSummary?.refs.dedup_count,
      indexSummary?.refs.ranked_count,
      indexSummary?.refs.selected_count,
      indexSummary?.refs.budgeted_count,
      indexSummary?.refs.excluded_count,
    ],
    [1, 1, 1, 1, 0, 0],
  );
  assert.equal(trace.auditTrace(indexFixture.db, index.traceId!)?.exhaustive, true);
  indexFixture.db.close();
});

test('pair shortcuts trace without a retrieval or answer call', async () => {
  const userFixture = tempDb();
  const userProject = seedProject(userFixture.db, 'trace-user-pair');
  const userSerena = insertEntity(userFixture.db, userProject.id, 'Serena Marsh', 'ent-user-serena');
  const userKade = insertEntity(userFixture.db, userProject.id, 'Kade', 'ent-user-kade');
  insertRelation(userFixture.db, userProject.id, userSerena, userKade, 'sibling of', 'user_confirmed', 1, '[]');
  const noLlm = mockProvider(() => {
    throw new Error('shortcut must not call the model');
  });
  const user = await answerLoreQuestion(userFixture.db, noLlm, userProject.id, 'status of Serena Marsh to Kade', {
    trace: { enabled: true },
  });
  assert.ok(user.traceId);
  assert.equal(trace.showTrace(userFixture.db, user.traceId!)?.trace.metadata.mode, 'pair-user-confirmed');
  assert.ok(events(userFixture.db, user.traceId!).some((event) => event.event === 'retrieval.shortcut' && event.reasonCode === 'user-confirmed'));
  assert.equal(trace.auditTrace(userFixture.db, user.traceId!)?.exhaustive, true);
  userFixture.db.close();

  const attestedFixture = tempDb();
  const attestedProject = seedProject(attestedFixture.db, 'trace-attested-pair');
  const attestedSerena = insertEntity(attestedFixture.db, attestedProject.id, 'Serena Marsh', 'ent-att-serena');
  const attestedKade = insertEntity(attestedFixture.db, attestedProject.id, 'Kade', 'ent-att-kade');
  const chunk = attestedFixture.db.get<{ id: number; locator: string }>(
    'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1',
    attestedProject.id,
  )!;
  insertRelation(
    attestedFixture.db,
    attestedProject.id,
    attestedSerena,
    attestedKade,
    'accompanied by',
    'attested',
    0,
    JSON.stringify([{ source: 'Probe', locator: chunk.locator, chunk: chunk.id }]),
  );
  const attested = await answerLoreQuestion(attestedFixture.db, noLlm, attestedProject.id, 'status of Serena Marsh to Kade', {
    trace: { enabled: true },
  });
  assert.ok(attested.traceId);
  assert.equal(trace.showTrace(attestedFixture.db, attested.traceId!)?.trace.metadata.mode, 'pair-attested');
  assert.ok(events(attestedFixture.db, attested.traceId!).some((event) => event.event === 'retrieval.shortcut' && event.reasonCode === 'attested'));
  assert.equal(trace.auditTrace(attestedFixture.db, attested.traceId!)?.exhaustive, true);
  attestedFixture.db.close();
});

test('query expansion success and fallback are distinguished', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'trace-expansion');
  const success = await answerLoreQuestion(
    db,
    answerMock('Answer [S1].', ['Ardenne']),
    project.id,
    'bridge',
    { trace: { enabled: true } },
  );
  const successEvents = events(db, success.traceId!);
  const expanded = successEvents.find((event) => event.event === 'retrieval.query.expanded');
  assert.equal(expanded?.reasonCode, 'model');
  assert.equal(expanded?.refs.count, 1);
  assert.equal(expanded?.refs.stage, 'expand');

  const fallback = await answerLoreQuestion(
    db,
    answerMock('Answer [S1].', []),
    project.id,
    'bridge',
    { trace: { enabled: true } },
  );
  const fallbackEvents = events(db, fallback.traceId!);
  assert.equal(
    fallbackEvents.find((event) => event.event === 'retrieval.query.expanded')?.reasonCode,
    'fallback-empty',
  );
  db.close();
});

test('sampled traces are inconclusive, not audited as exhaustive', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'trace-sampled');
  const res = await answerLoreQuestion(db, answerMock('Answer [S1].'), project.id, 'bridge', {
    trace: { enabled: true, sampledRate: 0 },
  });
  assert.ok(res.traceId);
  const view = trace.showTrace(db, res.traceId!);
  assert.equal(view?.trace.completeness, 'sampled');
  assert.ok((view?.trace.droppedEvents ?? 0) > 0);
  const audit = trace.auditTrace(db, res.traceId!);
  assert.equal(audit?.exhaustive, false);
  assert.deepEqual(audit?.violations, []);
  db.close();
});

test('trace write failure does not fail the ask result', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'trace-write-failure');
  db.exec('DROP TABLE trace_event');
  db.exec('DROP TABLE trace');
  const res = await answerLoreQuestion(db, answerMock('Answer [S1].'), project.id, 'bridge', {
    trace: { enabled: true },
  });
  assert.ok(res.passages.length > 0);
  assert.equal(res.traceId, undefined);
  db.close();
});

test('trace JSON has no raw query or passage prose and CLI show/audit remain valid', async () => {
  const { db, path } = tempDb();
  const project = seedProject(db, 'trace-json');
  const question = 'Where is the bridge at Ardenne?';
  const res = await answerLoreQuestion(db, answerMock('Answer [S1].'), project.id, question, {
    trace: { enabled: true },
  });
  assert.ok(res.traceId);
  const view = trace.showTrace(db, res.traceId!);
  assert.ok(view);
  const json = JSON.stringify(view);
  assert.ok(!json.includes(question), 'raw query is absent');
  assert.ok(!json.includes('The rain had not stopped'), 'passage prose is absent');
  JSON.parse(JSON.stringify(trace.auditTrace(db, res.traceId!)));
  db.close();

  const show = runCli(path, ['trace', 'show', res.traceId!, '--json']);
  assert.equal(show.status, 0, show.stderr);
  const shown = JSON.parse(show.stdout) as { events: unknown[] };
  assert.ok(shown.events.length > 0);
  const textShow = runCli(path, ['trace', 'show', res.traceId!]);
  assert.equal(textShow.status, 0, textShow.stderr);
  assert.match(textShow.stdout, /Retrieval handoff/);
  assert.match(textShow.stdout, /selected evidence: chunk:/);
  assert.match(textShow.stdout, /raw=\d+ dedup=\d+ ranked=\d+ selected=\d+ budgeted=\d+ excluded=\d+/);
  const audit = runCli(path, ['trace', 'audit', res.traceId!, '--json']);
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).exhaustive, true);
});

test('selected passages without a usable citation are a retrieval audit violation', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'trace-no-citation');
  db.run(
    "UPDATE canon_source SET title = '', path = '' WHERE project_id = ?",
    project.id,
  );
  db.run("UPDATE canon_chunk SET locator = '' WHERE project_id = ?", project.id);
  const res = await answerLoreQuestion(db, answerMock('Answer [S1].'), project.id, 'bridge', {
    trace: { enabled: true },
  });
  assert.ok(res.traceId);
  const audit = trace.auditTrace(db, res.traceId!);
  assert.equal(audit?.exhaustive, true);
  assert.ok(
    audit?.violations.some((item) => item.code === 'retrieval_selected_without_citation'),
    'the ask trace records the missing citation',
  );
  db.close();
});

test('a truncated trace is inconclusive and is not audited as exhaustive', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'trace-truncated');
  const started = trace.startTrace(db, { projectId: project.id });
  for (let i = 0; i < trace.DIAGNOSTIC_MAX_EVENTS_PER_TRACE + 1; i++) {
    trace.recordTraceEvent(db, {
      traceId: started.id,
      projectId: project.id,
      stage: 'retrieval',
      event: 'retrieval.test',
      eventClass: 'diagnostic',
      subject: `chunk:${i + 1}`,
      decision: 'candidate',
      reasonCode: 'fts',
      refs: { chunk_id: i + 1, rank: i + 1 },
    });
  }
  trace.finishTrace(db, started.id);
  const view = trace.showTrace(db, started.id);
  assert.equal(view?.trace.completeness, 'truncated');
  const audit = trace.auditTrace(db, started.id);
  assert.equal(audit?.exhaustive, false);
  assert.deepEqual(audit?.violations, []);
  db.close();
});

test('supplied search reports raw/dedup/ranked/selected counts', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'trace-supplied');
  const supplied = lore.searchCanon(db, project.id, 'bridge', { limit: 2 });
  assert.equal(supplied.length, 2);
  const res = await answerLoreQuestion(
    db,
    answerMock('Answer [S1].', []),
    project.id,
    'bridge',
    { search: supplied, trace: { enabled: true } },
  );
  assert.ok(res.traceId);
  const view = trace.showTrace(db, res.traceId!);
  assert.equal(view?.trace.metadata.mode, 'supplied-search');
  const summary = events(db, res.traceId!).find(
    (event) => event.event === 'retrieval.summary' && event.subject === 'search:supplied',
  );
  assert.deepEqual(
    [
      summary?.refs.raw_count,
      summary?.refs.dedup_count,
      summary?.refs.ranked_count,
      summary?.refs.selected_count,
      summary?.refs.budgeted_count,
      summary?.refs.excluded_count,
    ],
    [2, 2, 2, 2, 0, 0],
  );
  assert.equal(trace.auditTrace(db, res.traceId!)?.exhaustive, true);
  db.close();
});

test('zero-limit retrieval budgets every ranked candidate and stays auditable', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'trace-zero-limit');
  const res = await answerLoreQuestion(
    db,
    answerMock('unused', ['Ardenne']),
    project.id,
    'bridge',
    { limit: 0, trace: { enabled: true } },
  );
  assert.deepEqual(res.passages, []);
  assert.ok(res.traceId);
  const list = events(db, res.traceId!);
  const summary = list.find((event) => event.event === 'retrieval.summary' && event.subject === 'search:fts');
  assert.deepEqual(
    [
      summary?.refs.raw_count,
      summary?.refs.dedup_count,
      summary?.refs.ranked_count,
      summary?.refs.selected_count,
      summary?.refs.budgeted_count,
      summary?.refs.excluded_count,
    ],
    [4, 4, 4, 0, 4, 0],
  );
  const cutoff = list.find((event) => event.event === 'retrieval.budget.cutoff' && event.subject === 'budget:passages');
  assert.equal(cutoff?.refs.count, 4);
  assert.equal(trace.auditTrace(db, res.traceId!)?.exhaustive, true);
  assert.deepEqual(trace.auditTrace(db, res.traceId!)?.violations, []);
  db.close();
});

test('a partial event-write failure marks the trace truncated and not exhaustive', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'trace-partial-write');
  db.exec(`
    CREATE TRIGGER fail_retrieval_completed
    BEFORE INSERT ON trace_event
    WHEN NEW.event = 'retrieval.completed'
    BEGIN
      SELECT RAISE(ABORT, 'forced retrieval trace write failure');
    END;
  `);
  const res = await answerLoreQuestion(db, answerMock('Answer [S1].'), project.id, 'bridge', {
    trace: { enabled: true },
  });
  assert.ok(res.passages.length > 0);
  assert.ok(res.traceId);
  const view = trace.showTrace(db, res.traceId!);
  assert.equal(view?.trace.completeness, 'truncated');
  assert.ok((view?.trace.droppedEvents ?? 0) >= 1);
  const audit = trace.auditTrace(db, res.traceId!);
  assert.equal(audit?.exhaustive, false);
  assert.deepEqual(audit?.violations, []);
  db.close();
});

test('index search reports per-group raw, selected and limit-cut counts', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'trace-index-limit');
  const tokens = ['zephyrone', 'zephyrtwo', 'zephyrthree', 'zephyrfour', 'zephyrfive',
    'zephyrsix', 'zephyrseven', 'zephyreight', 'zephyrnine', 'zephyrten', 'zephyreleven', 'zephyrtwelve'];
  for (const [i, token] of tokens.entries()) {
    insertEntity(db, project.id, `Zephyr ${token}`, `ent-zephyr-${i}`);
  }
  const res = await answerLoreQuestion(
    db,
    answerMock('Index answer.', []),
    project.id,
    tokens.join(' '),
    { trace: { enabled: true } },
  );
  assert.ok(res.traceId);
  const list = events(db, res.traceId!);
  const summary = list.find((event) => event.event === 'retrieval.summary' && event.subject === 'search:index:entity');
  assert.deepEqual(
    [
      summary?.refs.raw_count,
      summary?.refs.dedup_count,
      summary?.refs.ranked_count,
      summary?.refs.selected_count,
      summary?.refs.budgeted_count,
      summary?.refs.excluded_count,
    ],
    [12, 12, 12, 10, 2, 0],
  );
  const cutoff = list.find((event) => event.event === 'retrieval.budget.cutoff' && event.subject === 'budget:index:entity');
  assert.equal(cutoff?.refs.count, 2);
  const audit = trace.auditTrace(db, res.traceId!);
  assert.equal(audit?.exhaustive, true);
  assert.deepEqual(audit?.violations, []);
  db.close();
});
