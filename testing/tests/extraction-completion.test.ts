/**
 * Extraction completion is a parser/provider decision, not a call-success
 * decision. Salvaged rows survive, but a section that was cut off, missing,
 * partially filtered or malformed must keep the window unmined. Lazy retrieval
 * must not retry the same unproductive window on every query.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FinishReason } from '../../fanfable/src/core/llm.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { createProject } from '../../fanfable/src/plan/controller.ts';
import { importSource } from '../../fanfable/src/support/lore-import.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';

const SERENA_QUOTE = 'Serena Marsh watched it from the ridge';
const KADE_QUOTE = 'said Kade behind her';
const RAIN_QUOTE = 'The rain had not stopped for three days';

const SERENA = {
  kind: 'character',
  name: 'Serena Marsh',
  aliases: [],
  summary: 'A woman who watches the bridge.',
  attributes: {},
  role: '',
  status: '',
  chunk_index: 0,
  evidence: SERENA_QUOTE,
};

const KADE = {
  kind: 'character',
  name: 'Kade',
  aliases: [],
  summary: 'A frightened man.',
  attributes: {},
  role: '',
  status: '',
  chunk_index: 0,
  evidence: KADE_QUOTE,
};

const EVENT = {
  title: 'The rain stopped',
  summary: 'The rain stopped after three days.',
  when: 'after three days of rain',
  participants: [],
  location: 'Ardenne',
  chunk_index: 0,
  evidence: RAIN_QUOTE,
};

const FACT = {
  topic: 'the rain',
  statement: 'The rain had not stopped for three days.',
  kind: 'fact',
  certainty: 'confirmed',
  subject: 'Ardenne',
  chunk_index: 0,
  evidence: RAIN_QUOTE,
};

const ENTITIES_WITH_SERENA = JSON.stringify({ entities: [SERENA], facts: [] });
const EMPTY_RELATIONS = JSON.stringify({ relations: [] });
const EMPTY_TIMELINE = JSON.stringify({ timeline: [] });
const EMPTY_ENTITIES_FACTS = JSON.stringify({ entities: [], facts: [] });

type Handler = (req: { system?: string; messages: { content: string }[] }) => string;

function splitHandler(parts: {
  entitiesFacts?: string;
  relations?: string;
  timeline?: string;
} = {}): Handler {
  return (req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return parts.relations ?? EMPTY_RELATIONS;
    if (system.includes('"timeline"')) return parts.timeline ?? EMPTY_TIMELINE;
    return parts.entitiesFacts ?? ENTITIES_WITH_SERENA;
  };
}

/** Keep the mock's normal text, adding a finish reason only when requested. */
function finishProvider(
  handler: Handler,
  finishReason: (req: { system?: string; messages: { content: string }[] }) => FinishReason | undefined,
) {
  const llm = mockProvider(handler);
  const baseChat = llm.chat.bind(llm);
  llm.chat = async (req) => {
    const response = await baseChat(req);
    const reason = finishReason(req);
    return reason === undefined ? response : { ...response, finishReason: reason };
  };
  return llm;
}

function minedCount(db: ReturnType<typeof tempDb>['db'], projectId: number): number {
  return db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1',
    projectId,
  )?.n ?? 0;
}

function entityCount(db: ReturnType<typeof tempDb>['db'], projectId: number): number {
  return db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?',
    projectId,
  )?.n ?? 0;
}

function chunkIds(db: ReturnType<typeof tempDb>['db'], projectId: number): number[] {
  return db
    .all<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY seq', projectId)
    .map((row) => row.id);
}

function rowCount(
  db: ReturnType<typeof tempDb>['db'],
  table: 'canon_entity' | 'canon_fact' | 'canon_relation' | 'canon_timeline',
  projectId: number,
): number {
  return db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
    projectId,
  )?.n ?? 0;
}

function lastWindow(db: ReturnType<typeof tempDb>['db']) {
  return db.get<{
    state: string;
    sections: string;
    failed_sections: string;
    chunk_ids: string;
  }>('SELECT state, sections, failed_sections, chunk_ids FROM extraction_window_run ORDER BY id DESC LIMIT 1')!;
}

test('a known length stop is incomplete even when every section is valid JSON', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'completion-length');
  const llm = finishProvider(splitHandler(), () => 'length');

  const stats = await lorebook.extractLore(db, llm, project.id, { windowSize: 8, concurrency: 1 });

  assert.ok(stats.entities > 0, 'the valid rows are preserved');
  const issue = stats.windowIssues.find((window) => window.index === 0);
  assert.ok(issue, 'the window is not complete');
  assert.equal(issue.state, 'partial');
  assert.deepEqual(issue.incompleteSections, ['entities-facts', 'relations', 'timeline']);
  assert.match(issue.detail, /finish-length/);
  assert.equal(stats.emptyWindows.length, 0, 'a window with rows is not an empty window');
  assert.equal(minedCount(db, project.id), 0, 'no chunk is mined while the provider says length');

  const run = db.get<{ status: string; windows_partial: number }>(
    'SELECT status, windows_partial FROM extraction_run ORDER BY id DESC LIMIT 1',
  )!;
  assert.equal(run.status, 'partial');
  assert.equal(run.windows_partial, 1);

  const window = lastWindow(db);
  assert.equal(window.state, 'partial');
  assert.deepEqual(JSON.parse(window.failed_sections), []);
  const sections = JSON.parse(window.sections) as Array<{
    section: string;
    state: string;
    reason?: string;
    finishReason?: string;
  }>;
  assert.ok(
    sections.some(
      (section) =>
        section.section === 'entities-facts' &&
        section.state === 'incomplete' &&
        section.reason === 'finish-length' &&
        section.finishReason === 'length',
    ),
    'the durable window row keeps the provider reason',
  );
  db.close();
});

test('a missing facts section keeps the salvaged entity and the window unmined', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'completion-missing-facts');
  const llm = mockProvider(splitHandler({
    entitiesFacts: JSON.stringify({ entities: [SERENA] }),
  }));

  const stats = await lorebook.extractLore(db, llm, project.id, { windowSize: 8, concurrency: 1 });

  assert.equal(stats.entities, 1, 'the entity row is preserved');
  const issue = stats.windowIssues.find((window) => window.index === 0);
  assert.ok(issue);
  assert.equal(issue.state, 'partial');
  assert.deepEqual(issue.incompleteSections, ['entities-facts']);
  assert.match(issue.detail, /facts \(section-missing\)/);
  assert.equal(minedCount(db, project.id), 0);

  const sections = JSON.parse(lastWindow(db).sections) as Array<{
    section: string;
    state: string;
    reason?: string;
    incompleteParts?: Array<{ section: string; reason: string }>;
  }>;
  const report = sections.find((section) => section.section === 'entities-facts')!;
  assert.equal(report.state, 'incomplete');
  assert.deepEqual(report.incompleteParts, [{ section: 'facts', reason: 'section-missing' }]);
  db.close();
});

test('a salvaged partial section keeps its rows and records partial-array', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'completion-salvage');
  const truncated = `{"entities":[${JSON.stringify(SERENA)}],"facts":[{"topic":"rain"`;
  const llm = mockProvider(splitHandler({ entitiesFacts: truncated }));

  const stats = await lorebook.extractLore(db, llm, project.id, { windowSize: 8, concurrency: 1 });

  assert.equal(stats.entities, 1, 'salvage still writes the complete entity record');
  const issue = stats.windowIssues.find((window) => window.index === 0);
  assert.ok(issue);
  assert.deepEqual(issue.incompleteSections, ['entities-facts']);
  assert.match(issue.detail, /entities \(partial-array\)/);
  assert.match(issue.detail, /facts \(partial-array\)/);
  assert.equal(minedCount(db, project.id), 0);

  const first = entityCount(db, project.id);
  const retry = await lorebook.extractLore(db, mockProvider(splitHandler({ entitiesFacts: truncated })), project.id, {
    windowSize: 8,
    concurrency: 1,
  });
  assert.equal(retry.windows, 1, 'an explicit run still retries the incomplete window');
  assert.equal(entityCount(db, project.id), first, 'a repeated salvage does not duplicate the entity');
  assert.equal(minedCount(db, project.id), 0);
  db.close();
});

test('filtered malformed entries are incomplete and keep the window unmined', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'completion-filtered');
  const llm = mockProvider(splitHandler({
    entitiesFacts: JSON.stringify({ entities: [SERENA, null], facts: [null] }),
  }));

  const stats = await lorebook.extractLore(db, llm, project.id, { windowSize: 8, concurrency: 1 });

  assert.equal(stats.entities, 1);
  assert.equal(stats.facts, 0);
  const issue = stats.windowIssues.find((window) => window.index === 0);
  assert.ok(issue);
  assert.deepEqual(issue.incompleteSections, ['entities-facts']);
  assert.match(issue.detail, /entities \(mixed-entries\)/);
  assert.match(issue.detail, /facts \(mixed-entries\)/);
  assert.equal(minedCount(db, project.id), 0);
  db.close();
});

test('repeating an incomplete window does not duplicate salvaged facts or timeline rows', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'completion-repeat-dedupe');
  const handler = splitHandler({
    entitiesFacts: JSON.stringify({ entities: [SERENA], facts: [FACT, null] }),
    timeline: JSON.stringify({ timeline: [EVENT] }),
  });

  const first = await lorebook.extractLore(db, mockProvider(handler), project.id, {
    windowSize: 8,
    concurrency: 1,
  });
  assert.equal(first.windowIssues.length, 1);
  assert.deepEqual(
    [
      rowCount(db, 'canon_entity', project.id),
      rowCount(db, 'canon_fact', project.id),
      rowCount(db, 'canon_timeline', project.id),
    ],
    [1, 1, 1],
    'the valid salvaged rows are written once',
  );
  assert.equal(minedCount(db, project.id), 0);

  const second = await lorebook.extractLore(db, mockProvider(handler), project.id, {
    windowSize: 8,
    concurrency: 1,
  });
  assert.equal(second.windows, 1, 'the explicit retry runs again');
  assert.deepEqual(
    [
      rowCount(db, 'canon_entity', project.id),
      rowCount(db, 'canon_fact', project.id),
      rowCount(db, 'canon_timeline', project.id),
    ],
    [1, 1, 1],
    'the repeat updates/dedupes rather than adding salvaged rows',
  );
  assert.equal(minedCount(db, project.id), 0, 'the window stays incomplete and unmined');
  db.close();
});

test('repeating a salvaged relation updates rather than duplicating it', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'completion-repeat-relation');
  const relation = {
    from: 'Serena Marsh',
    to: 'Kade',
    kind: 'accompanied by',
    description: 'Kade stands behind her on the ridge.',
    chunk_index: 0,
    evidence: SERENA_QUOTE,
  };
  const truncated = `{"relations":[${JSON.stringify(relation)}`;
  const handler = splitHandler({
    entitiesFacts: JSON.stringify({ entities: [SERENA, KADE], facts: [] }),
    relations: truncated,
  });

  const first = await lorebook.extractLore(db, mockProvider(handler), project.id, {
    windowSize: 8,
    concurrency: 1,
  });
  assert.equal(first.relations, 1);
  assert.deepEqual(first.windowIssues[0]?.incompleteSections, ['relations']);
  assert.equal(rowCount(db, 'canon_relation', project.id), 1);
  assert.equal(minedCount(db, project.id), 0);

  const second = await lorebook.extractLore(db, mockProvider(handler), project.id, {
    windowSize: 8,
    concurrency: 1,
  });
  assert.equal(second.windows, 1, 'the explicit retry runs again');
  assert.equal(second.relations, 0, 'the existing relation is updated, not reinserted');
  assert.equal(rowCount(db, 'canon_relation', project.id), 1);
  assert.equal(minedCount(db, project.id), 0);
  db.close();
});

test('a missing relations section is incomplete, not an empty relationship answer', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'completion-missing-relations');
  const llm = mockProvider(splitHandler({ relations: JSON.stringify({ items: [] }) }));

  const stats = await lorebook.extractLore(db, llm, project.id, { windowSize: 8, concurrency: 1 });

  assert.equal(stats.entities, 1);
  const issue = stats.windowIssues.find((window) => window.index === 0);
  assert.ok(issue);
  assert.deepEqual(issue.incompleteSections, ['relations']);
  assert.match(issue.detail, /relations \(section-missing\)/);
  assert.equal(minedCount(db, project.id), 0);
  db.close();
});

test('explicit empty arrays are complete, but a zero-write window stays unmined', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'completion-empty-arrays');
  const llm = mockProvider(splitHandler({ entitiesFacts: EMPTY_ENTITIES_FACTS }));

  const stats = await lorebook.extractLore(db, llm, project.id, { windowSize: 8, concurrency: 1 });

  assert.equal(stats.windowIssues.length, 0, 'empty arrays are complete sections');
  assert.equal(stats.emptyWindows.length, 1);
  assert.equal(stats.emptyWindows[0]?.reason, 'empty-answer');
  assert.equal(minedCount(db, project.id), 0, 'the existing zero-write policy still leaves it unmined');

  const window = lastWindow(db);
  assert.equal(window.state, 'complete');
  const sections = JSON.parse(window.sections) as Array<{ section: string; state: string }>;
  assert.ok(sections.every((section) => section.state === 'succeeded' || section.state === 'skipped'));
  db.close();
});

test('absent, unknown and stop finish reasons do not by themselves make a window incomplete', async () => {
  for (const reason of [undefined, 'unknown', 'stop'] as const) {
    const { db } = tempDb();
    const project = seedProject(db, `completion-${reason ?? 'absent'}`);
    const llm = finishProvider(splitHandler(), () => reason);

    const stats = await lorebook.extractLore(db, llm, project.id, { windowSize: 8, concurrency: 1 });

    assert.equal(stats.windowIssues.length, 0, `${reason ?? 'absent'} stays parser-decided`);
    const total = db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?',
      project.id,
    )!.n;
    assert.equal(minedCount(db, project.id), total, `${reason ?? 'absent'} allows a complete window to be mined`);
    db.close();
  }
});

test('the no-roster relation skip remains explicit and does not block a complete window', async () => {
  const { db, path } = tempDb();
  const sourcePath = join(dirname(path), 'plain.txt');
  writeFileSync(
    sourcePath,
    'the rain fell on the bridge for three days.\nthe river ran fast.\nthen the rain stopped.\n',
  );
  const project = createProject(db, 'completion-no-roster');
  importSource(db, project.id, sourcePath);
  const plainEvent = { ...EVENT, title: 'rain stops', evidence: 'then the rain stopped' };
  const llm = mockProvider(splitHandler({
    entitiesFacts: EMPTY_ENTITIES_FACTS,
    timeline: JSON.stringify({ timeline: [plainEvent] }),
  }));

  const stats = await lorebook.extractLore(db, llm, project.id, { windowSize: 8, concurrency: 1 });

  assert.equal(stats.windowIssues.length, 0);
  const window = lastWindow(db);
  assert.equal(window.state, 'complete');
  const sections = JSON.parse(window.sections) as Array<{ section: string; state: string }>;
  assert.ok(sections.some((section) => section.section === 'relations' && section.state === 'skipped'));
  const total = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?',
    project.id,
  )!.n;
  assert.equal(minedCount(db, project.id), total);
  db.close();
});

test('the legacy path also refuses a known length stop and a missing-section answer', async () => {
  for (const [name, answer, finishReason] of [
    ['length', JSON.stringify({ entities: [SERENA], relations: [], facts: [], timeline: [] }), 'length'],
    ['missing', JSON.stringify({ entities: [SERENA] }), undefined],
  ] as const) {
    const { db } = tempDb();
    const project = seedProject(db, `completion-legacy-${name}`);
    const llm = finishProvider(() => answer, () => finishReason);

    const stats = await lorebook.extractLore(db, llm, project.id, {
      windowSize: 8,
      concurrency: 1,
      singlePrompt: true,
    });

    assert.equal(stats.entities, 1, `${name}: the valid entity is preserved`);
    const issue = stats.windowIssues.find((window) => window.index === 0);
    assert.ok(issue, `${name}: the legacy window is not complete`);
    assert.deepEqual(issue.incompleteSections, ['legacy']);
    assert.equal(minedCount(db, project.id), 0, `${name}: the legacy window stays unmined`);

    const window = lastWindow(db);
    assert.equal(window.state, 'partial');
    const sections = JSON.parse(window.sections) as Array<{
      section: string;
      state: string;
      finishReason?: string;
      incompleteParts?: Array<{ section: string; reason: string }>;
    }>;
    const legacy = sections.find((section) => section.section === 'legacy')!;
    assert.equal(legacy.state, 'incomplete');
    if (finishReason) {
      assert.equal(legacy.finishReason, 'length');
      assert.ok(legacy.incompleteParts?.every((part) => part.reason === 'finish-length'));
    } else {
      assert.ok(legacy.incompleteParts?.some((part) => part.section === 'facts' && part.reason === 'section-missing'));
    }
    db.close();
  }
});

test('lazy retrieval does not retry a previously incomplete window, but explicit extraction does', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'completion-lazy-skip');
  const partial = splitHandler({ entitiesFacts: JSON.stringify({ entities: [SERENA] }) });

  await lorebook.extractLore(db, mockProvider(partial), project.id, { windowSize: 8, concurrency: 1 });
  assert.equal(minedCount(db, project.id), 0);
  assert.equal(entityCount(db, project.id), 1);

  let lazyCalls = 0;
  const lazy = mockProvider((req) => {
    lazyCalls++;
    return splitHandler()(req);
  });
  const ids = chunkIds(db, project.id);
  const first = await lorebook.ensureWindowsForChunks(db, lazy, project.id, ids, {
    windowSize: 8,
    maxLazyWindows: 1,
  });
  assert.equal(lazyCalls, 0, 'lazy retrieval makes no model call for the incomplete window');
  assert.equal(first.windows, 0);
  assert.equal(first.skippedRepeatedWindows, 1);
  assert.equal(minedCount(db, project.id), 0);

  const second = await lorebook.ensureWindowsForChunks(db, lazy, project.id, ids, {
    windowSize: 8,
    maxLazyWindows: 1,
  });
  assert.equal(lazyCalls, 0, 'the skip is durable across lazy attempts');
  assert.equal(second.skippedRepeatedWindows, 1);

  const retry = await lorebook.extractLore(db, mockProvider(splitHandler()), project.id, {
    windowSize: 8,
    concurrency: 1,
  });
  assert.equal(retry.windows, 1, 'an explicit run retries the window');
  const total = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?',
    project.id,
  )!.n;
  assert.equal(minedCount(db, project.id), total);
  assert.equal(entityCount(db, project.id), 1, 'the explicit retry updates, never duplicates, the salvaged row');
  db.close();
});

test('an incomplete window in one project does not suppress lazy extraction in another', async () => {
  const { db } = tempDb();
  const first = seedProject(db, 'completion-project-a');
  const second = seedProject(db, 'completion-project-b');

  await lorebook.extractLore(
    db,
    mockProvider(splitHandler({ entitiesFacts: JSON.stringify({ entities: [SERENA] }) })),
    first.id,
    { windowSize: 8, concurrency: 1 },
  );
  assert.equal(minedCount(db, first.id), 0);

  let calls = 0;
  const lazy = mockProvider((req) => {
    calls++;
    return splitHandler()(req);
  });
  const mini = await lorebook.ensureWindowsForChunks(db, lazy, second.id, chunkIds(db, second.id), {
    windowSize: 8,
    maxLazyWindows: 1,
  });
  assert.ok(calls > 0, 'the other project is not blocked by the first project record');
  assert.equal(mini.windows, 1);
  const total = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?',
    second.id,
  )!.n;
  assert.equal(minedCount(db, second.id), total);
  assert.equal(minedCount(db, first.id), 0, 'the first project remains unmined');
  db.close();
});

test('trace enabled and disabled produce the same completion result', async () => {
  const results: Array<{
    entities: number;
    windows: number;
    issues: number;
    state: string | undefined;
    incomplete: string[] | undefined;
    mined: number;
  }> = [];

  for (const trace of [false, true]) {
    const { db } = tempDb();
    const project = seedProject(db, `completion-trace-${trace}`);
    const stats = await lorebook.extractLore(
      db,
      mockProvider(splitHandler({ entitiesFacts: JSON.stringify({ entities: [SERENA] }) })),
      project.id,
      { windowSize: 8, concurrency: 1, trace: { enabled: trace } },
    );
    const issue = stats.windowIssues.find((window) => window.index === 0);
    results.push({
      entities: stats.entities,
      windows: stats.windows,
      issues: stats.windowIssues.length,
      state: issue?.state,
      incomplete: issue?.incompleteSections,
      mined: minedCount(db, project.id),
    });
    if (trace) assert.ok(stats.traceId, 'the traced run records a trace id');
    else assert.equal(stats.traceId, undefined, 'the untraced run has no trace id');
    db.close();
  }

  assert.deepEqual(results[0], results[1], 'tracing does not change completion, rows or mined flags');
});
