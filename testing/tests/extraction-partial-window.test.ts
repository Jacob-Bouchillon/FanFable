/**
 * A window is one unit of completion. If one split section writes rows and a
 * later section call fails, the window is partial: it must stay unmined so a
 * later run retries it, and the report must name the failed section.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';

const SERENA_QUOTE = 'Serena Marsh watched it from the ridge';

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

function minedCount(db: ReturnType<typeof tempDb>['db'], projectId: number): number {
  return db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1',
    projectId,
  )?.n ?? 0;
}

test('a section failure after a successful section keeps the window unmined', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'partial-window');
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) throw new Error('relations timed out');
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [SERENA], facts: [] });
  });

  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
  });

  assert.equal(stats.windows, 1, 'the fixture is one window');
  assert.ok(stats.entities > 0, 'the entity section wrote a row');
  assert.equal(stats.emptyWindows.length, 0, 'a partial window is not an empty window');

  const issue = stats.windowIssues.find((w) => w.state === 'partial');
  assert.ok(issue, 'a partial window is reported separately');
  assert.deepEqual(issue.failedSections, ['relations']);
  assert.ok(issue.succeededSections.includes('entities-facts'));
  assert.match(issue.detail, /relations: relations timed out/);
  assert.ok(issue.wrote.entities > 0, 'the report says what succeeded');
  const last = lorebook.lastExtractionReport(db, project.id);
  assert.ok(last?.windowIssues?.some((w) => w.state === 'partial'), 'the report survives the run');

  assert.equal(minedCount(db, project.id), 0, 'no chunk in a partial window is marked mined');

  // The partial window is still a candidate on the next incremental run.
  const retry = await lorebook.extractLore(
    db,
    mockProvider(() => JSON.stringify({ entities: [], relations: [], facts: [], timeline: [] })),
    project.id,
    { windowSize: 8, concurrency: 1 },
  );
  assert.equal(retry.windows, 1, 'a partial window is retried');
  assert.equal(minedCount(db, project.id), 0, 'a retry that wrote nothing leaves it retryable');
  db.close();
});

test('a window where every called section fails is reported as failed', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'failed-window');
  const stats = await lorebook.extractLore(
    db,
    mockProvider(() => {
      throw new Error('model down');
    }),
    project.id,
    { windowSize: 8, concurrency: 1 },
  );

  const issue = stats.windowIssues.find((w) => w.state === 'failed');
  assert.ok(issue, 'a failed window is reported separately');
  assert.ok(issue.failedSections.includes('entities-facts'));
  assert.ok(issue.failedSections.includes('timeline'));
  assert.match(issue.detail, /model down/);
  assert.ok(stats.emptyWindows.some((w) => w.reason === 'error'), 'it is also an empty window');
  assert.equal(minedCount(db, project.id), 0, 'a failed window is not marked mined');
  db.close();
});

test('all sections succeeding marks the window mined', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'complete-window');
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [SERENA], facts: [] });
  });

  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
  });

  assert.equal(stats.windowIssues.length, 0, 'no incomplete window is reported');
  const total = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)?.n ?? 0;
  assert.equal(minedCount(db, project.id), total, 'every chunk in the complete window is marked mined');
  db.close();
});
