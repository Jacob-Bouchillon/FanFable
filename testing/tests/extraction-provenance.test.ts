/**
 * Durable extraction-run provenance: the run and each window are written to
 * the database as they happen, so a crash leaves a truthful record. Provenance
 * is additive; lore_mined remains the extraction completion flag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../fanfable/src/core/db.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';

const SERENA_QUOTE = 'Serena Marsh watched it from the ridge';
const FACT_QUOTE = 'the bridge at Ardenne still stood';
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
const FACT = {
  topic: 'bridge',
  statement: 'The bridge at Ardenne still stood.',
  kind: 'fact',
  certainty: 'confirmed',
  subject: 'Serena Marsh',
  chunk_index: 0,
  evidence: FACT_QUOTE,
};

function isEntitiesSystem(system: string): boolean {
  return system.includes('people, peoples, places');
}

function completeMock(facts: Record<string, unknown>[] = []) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    if (isEntitiesSystem(system)) return JSON.stringify({ entities: [SERENA], facts });
    return JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] });
  });
}

function partialMock() {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) throw new Error('relations timed out');
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    if (isEntitiesSystem(system)) return JSON.stringify({ entities: [SERENA], facts: [] });
    return JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] });
  });
}

function minedCount(db: ReturnType<typeof tempDb>['db'], projectId: number): number {
  return (
    db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1',
      projectId,
    )?.n ?? 0
  );
}

function rows(db: ReturnType<typeof tempDb>['db'], table: string, projectId: number): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, projectId)?.n ?? 0;
}

test('migration 28 creates the provenance tables, columns and indexes', () => {
  const { db } = tempDb();
  const runColumns = db.all<{ name: string }>('PRAGMA table_info(extraction_run)').map((r) => r.name);
  const windowColumns = db.all<{ name: string }>('PRAGMA table_info(extraction_window_run)').map((r) => r.name);
  for (const name of [
    'id', 'project_id', 'started_at', 'finished_at', 'provider', 'model', 'prompt_hash',
    'seed', 'window_size', 'max_tokens', 'status', 'windows_total', 'windows_complete',
    'windows_partial', 'windows_failed',
  ]) {
    assert.ok(runColumns.includes(name), `extraction_run.${name}`);
  }
  for (const name of [
    'id', 'run_id', 'project_id', 'window_index', 'locator', 'state', 'sections',
    'failed_sections', 'wrote_entities', 'wrote_facts', 'wrote_relations', 'wrote_timeline',
    'error', 'chunk_ids', 'started_at', 'finished_at',
  ]) {
    assert.ok(windowColumns.includes(name), `extraction_window_run.${name}`);
  }
  const indexes = db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('extraction_run', 'extraction_window_run')",
    )
    .map((r) => r.name);
  for (const name of ['extraction_run_project', 'extraction_window_run_run', 'extraction_window_run_window']) {
    assert.ok(indexes.includes(name), name);
  }
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 33);
  assert.equal(db.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'version'")?.value, '1');
  db.close();
});

test('a complete window writes a completed run and a complete window row', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'provenance-complete');
  const stats = await lorebook.extractLore(db, completeMock(), project.id, {
    windowSize: 8,
    maxTokens: 3000,
    concurrency: 1,
  });
  const run = db.get<{
    id: number; status: string; provider: string; model: string; prompt_hash: string;
    seed: number | null; window_size: number; max_tokens: number;
    windows_total: number; windows_complete: number; windows_partial: number; windows_failed: number;
    finished_at: string | null;
  }>('SELECT * FROM extraction_run')!;
  assert.equal(run.status, 'completed');
  assert.equal(run.provider, 'mock');
  assert.ok(run.model.length > 0);
  assert.equal(run.prompt_hash.length, 64);
  assert.equal(run.seed, null);
  assert.equal(run.window_size, 8);
  assert.equal(run.max_tokens, 3000);
  assert.deepEqual(
    [run.windows_total, run.windows_complete, run.windows_partial, run.windows_failed],
    [1, 1, 0, 0],
  );
  assert.ok(run.finished_at);
  const window = db.get<{
    state: string; sections: string; failed_sections: string; wrote_entities: number;
    chunk_ids: string; error: string; finished_at: string | null;
  }>('SELECT * FROM extraction_window_run WHERE run_id = ?', run.id)!;
  assert.equal(window.state, 'complete');
  assert.deepEqual(JSON.parse(window.failed_sections), []);
  const sections = JSON.parse(window.sections) as Array<{ section: string; state: string }>;
  assert.ok(sections.some((s) => s.section === 'entities-facts' && s.state === 'succeeded'));
  assert.ok(window.wrote_entities > 0);
  assert.equal((JSON.parse(window.chunk_ids) as number[]).length, 4);
  assert.ok(window.finished_at);
  assert.equal(stats.windows, 1);
  assert.equal(minedCount(db, project.id), 4);
  assert.ok(lorebook.minedChunkProvenance(db, project.id).every((c) => c.state === 'complete'));
  db.close();
});

test('the run row is committed before the first model call', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'provenance-before-call');
  let sawRunning = false;
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    const run = db.get<{ status: string }>('SELECT status FROM extraction_run ORDER BY id LIMIT 1');
    if (run?.status === 'running') sawRunning = true;
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [SERENA], facts: [] });
  });
  await lorebook.extractLore(db, llm, project.id, { windowSize: 8, concurrency: 1 });
  assert.equal(sawRunning, true, 'the run is running before window work');
  assert.equal(db.get<{ status: string }>('SELECT status FROM extraction_run')?.status, 'completed');
  db.close();
});

test('a partial window writes a partial run/window with failed section and writes', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'provenance-partial');
  await lorebook.extractLore(db, partialMock(), project.id, { windowSize: 8, concurrency: 1 });
  const run = db.get<{
    id: number; status: string; windows_total: number; windows_complete: number;
    windows_partial: number; windows_failed: number;
  }>('SELECT * FROM extraction_run')!;
  assert.equal(run.status, 'partial');
  assert.deepEqual(
    [run.windows_total, run.windows_complete, run.windows_partial, run.windows_failed],
    [1, 0, 1, 0],
  );
  const window = db.get<{
    state: string; failed_sections: string; error: string; wrote_entities: number;
  }>('SELECT * FROM extraction_window_run WHERE run_id = ?', run.id)!;
  assert.equal(window.state, 'partial');
  assert.deepEqual(JSON.parse(window.failed_sections), ['relations']);
  assert.match(window.error, /relations timed out/);
  assert.ok(window.wrote_entities > 0);
  assert.equal(minedCount(db, project.id), 0);
  db.close();
});

test('a failed window writes failed state and stays unmined', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'provenance-failed');
  await lorebook.extractLore(
    db,
    mockProvider(() => {
      throw new Error('model down');
    }),
    project.id,
    { windowSize: 8, concurrency: 1 },
  );
  const run = db.get<{ id: number; status: string; windows_failed: number }>('SELECT * FROM extraction_run')!;
  assert.equal(run.status, 'failed');
  assert.equal(run.windows_failed, 1);
  const window = db.get<{ state: string; failed_sections: string; error: string }>(
    'SELECT * FROM extraction_window_run WHERE run_id = ?',
    run.id,
  )!;
  assert.equal(window.state, 'failed');
  assert.ok((JSON.parse(window.failed_sections) as string[]).includes('entities-facts'));
  assert.match(window.error, /model down/);
  assert.equal(minedCount(db, project.id), 0);
  db.close();
});

test('a successful retry creates a second run and does not duplicate rows', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'provenance-retry');
  await lorebook.extractLore(db, partialMock(), project.id, { windowSize: 8, concurrency: 1 });
  assert.deepEqual(
    [
      rows(db, 'canon_entity', project.id),
      rows(db, 'canon_fact', project.id),
      rows(db, 'canon_relation', project.id),
      rows(db, 'canon_timeline', project.id),
      rows(db, 'canon_ruling', project.id),
    ],
    [1, 0, 0, 0, 1],
    'the partial run wrote only the entity and its ruling',
  );

  await lorebook.extractLore(db, completeMock([FACT]), project.id, { windowSize: 8, concurrency: 1 });
  const runs = db.all<{
    id: number; status: string; prompt_hash: string; provider: string; model: string;
    window_size: number; max_tokens: number;
  }>('SELECT id, status, prompt_hash, provider, model, window_size, max_tokens FROM extraction_run ORDER BY id');
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.status, 'partial');
  assert.equal(runs[1]!.status, 'completed');
  assert.equal(runs[0]!.prompt_hash, runs[1]!.prompt_hash, 'the prompt/config hash is stable across retries');
  assert.equal(runs[0]!.provider, runs[1]!.provider);
  assert.equal(runs[0]!.model, runs[1]!.model);
  assert.equal(runs[0]!.window_size, runs[1]!.window_size);
  assert.equal(runs[0]!.max_tokens, runs[1]!.max_tokens);
  assert.equal(minedCount(db, project.id), 4, 'the successful retry marks the chunks mined');
  const counts = {
    entities: rows(db, 'canon_entity', project.id),
    facts: rows(db, 'canon_fact', project.id),
    relations: rows(db, 'canon_relation', project.id),
    timeline: rows(db, 'canon_timeline', project.id),
    rulings: rows(db, 'canon_ruling', project.id),
  };
  assert.deepEqual(counts, { entities: 1, facts: 1, relations: 0, timeline: 0, rulings: 1 });

  const third = await lorebook.extractLore(db, completeMock([FACT]), project.id, { windowSize: 8, concurrency: 1 });
  assert.equal(third.windows, 0, 'a fully mined rerun does no window work');
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_run')?.n, 2, 'no third run row');
  assert.deepEqual(
    {
      entities: rows(db, 'canon_entity', project.id),
      facts: rows(db, 'canon_fact', project.id),
      relations: rows(db, 'canon_relation', project.id),
      timeline: rows(db, 'canon_timeline', project.id),
      rulings: rows(db, 'canon_ruling', project.id),
    },
    counts,
    'no duplicate rows on the idempotent rerun',
  );
  db.close();
});

test('the lazy path also records one durable run and its window', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'provenance-lazy');
  const first = db.get<{ id: number }>(
    'SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1',
    project.id,
  )!.id;
  const stats = await lorebook.ensureWindowsForChunks(db, completeMock(), project.id, [first], {
    windowSize: 2,
    maxLazyWindows: 1,
    concurrency: 1,
  });
  assert.equal(stats.windows, 1);
  const run = db.get<{ id: number; status: string; windows_total: number; windows_complete: number }>(
    'SELECT * FROM extraction_run',
  )!;
  assert.equal(run.status, 'completed');
  assert.deepEqual([run.windows_total, run.windows_complete], [1, 1]);
  const window = db.get<{ state: string; chunk_ids: string }>(
    'SELECT state, chunk_ids FROM extraction_window_run WHERE run_id = ?',
    run.id,
  )!;
  assert.equal(window.state, 'complete');
  assert.equal((JSON.parse(window.chunk_ids) as number[]).length, 2);
  assert.equal(minedCount(db, project.id), 2);
  db.close();
});

test('an interrupted batch leaves its finished window rows and a failed run', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'provenance-crash');
  db.exec(`
    CREATE TRIGGER stop_second_window
    BEFORE INSERT ON extraction_window_run
    WHEN (SELECT COUNT(*) FROM extraction_window_run WHERE run_id = NEW.run_id) >= 1
    BEGIN SELECT RAISE(ABORT, 'simulated interruption'); END;
  `);
  await assert.rejects(
    () => lorebook.extractLore(db, partialMock(), project.id, { windowSize: 1, concurrency: 1 }),
    /simulated interruption/,
  );
  const run = db.get<{
    id: number; status: string; finished_at: string | null;
    windows_total: number; windows_complete: number; windows_partial: number; windows_failed: number;
  }>('SELECT * FROM extraction_run')!;
  assert.equal(run.status, 'failed');
  assert.ok(run.finished_at);
  assert.deepEqual(
    [run.windows_total, run.windows_complete, run.windows_partial, run.windows_failed],
    [4, 0, 1, 0],
  );
  const windows = db
    .all<{ window_index: number; state: string }>(
      'SELECT window_index, state FROM extraction_window_run WHERE run_id = ?',
      run.id,
    )
    .map((w) => ({ window_index: w.window_index, state: w.state }));
  assert.deepEqual(windows, [{ window_index: 0, state: 'partial' }]);
  assert.equal(minedCount(db, project.id), 0, 'partial windows stay unmined');
  const unfinished = lorebook.unfinishedExtractionRuns(db, project.id);
  const listed = unfinished.find((r) => r.runId === run.id)!;
  assert.ok(listed, 'the interrupted run is listed');
  assert.equal(listed.missingWindows, 3);
  assert.deepEqual(listed.retryableWindows, [
    { windowIndex: 0, locator: 'CHAPTER ONE: THE BRIDGE AT ARDENNE (p. 1)', state: 'partial' },
  ]);
  db.close();
});

test('the unfinished helper lists a running run with missing finish', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'provenance-running');
  const at = new Date().toISOString();
  const runId = db.run(
    `INSERT INTO extraction_run (project_id, started_at, status, windows_total) VALUES (?, ?, 'running', 3)`,
    project.id,
    at,
  ).lastInsertRowid;
  db.run(
    `INSERT INTO extraction_window_run
       (run_id, project_id, window_index, locator, state, sections, failed_sections,
        wrote_entities, wrote_facts, wrote_relations, wrote_timeline, error, chunk_ids, started_at)
     VALUES (?, ?, 1, 'p. 1', 'partial', '[]', '["relations"]', 1, 0, 0, 0, 'relations: timeout', '[1]', ?)`,
    runId,
    project.id,
    at,
  );
  const listed = lorebook.unfinishedExtractionRuns(db, project.id).find((r) => r.runId === runId);
  assert.ok(listed);
  assert.equal(listed.status, 'running');
  assert.equal(listed.finishedAt, null);
  assert.equal(listed.missingWindows, 2);
  assert.deepEqual(listed.retryableWindows, [{ windowIndex: 1, locator: 'p. 1', state: 'partial' }]);
  db.close();
});

test('a mined chunk with no window row is legacy-unknown, not complete', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'provenance-legacy');
  db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE project_id = ?', project.id);
  const before = lorebook.minedChunkProvenance(db, project.id);
  assert.equal(before.length, 4);
  assert.ok(before.every((c) => c.state === 'legacy-unknown'));

  const at = new Date().toISOString();
  const chunkId = db.get<{ id: number }>(
    'SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY seq LIMIT 1',
    project.id,
  )!.id;
  const runId = db.run(
    `INSERT INTO extraction_run
       (project_id, started_at, finished_at, status, windows_total, windows_complete)
     VALUES (?, ?, ?, 'completed', 1, 1)`,
    project.id,
    at,
    at,
  ).lastInsertRowid;
  db.run(
    `INSERT INTO extraction_window_run
       (run_id, project_id, window_index, locator, state, sections, failed_sections,
        wrote_entities, wrote_facts, wrote_relations, wrote_timeline, error, chunk_ids, started_at, finished_at)
     VALUES (?, ?, 0, 'p. 1', 'complete', '[]', '[]', 1, 0, 0, 0, '', ?, ?, ?)`,
    runId,
    project.id,
    JSON.stringify([chunkId]),
    at,
    at,
  );
  const after = lorebook.minedChunkProvenance(db, project.id);
  assert.equal(after.find((c) => c.chunkId === chunkId)?.state, 'complete');
  assert.equal(after.filter((c) => c.state === 'legacy-unknown').length, 3);
  db.close();
});

test('migration 28 leaves a pre-28 database canon and status content unchanged', () => {
  const { db, path } = tempDb();
  const project = seedProject(db, 'provenance-pre28');
  const at = new Date().toISOString();
  const a = db.run(
    `INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at)
     VALUES (?, 'character', 'A', '[]', ?, ?)`,
    project.id,
    at,
    at,
  ).lastInsertRowid;
  const b = db.run(
    `INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at)
     VALUES (?, 'character', 'B', '[]', ?, ?)`,
    project.id,
    at,
    at,
  ).lastInsertRowid;
  db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, review_status, confirmed_by_user, created_at)
     VALUES (?, ?, ?, 'ally of', 'user_confirmed', 1, ?)`,
    project.id,
    a,
    b,
    at,
  );
  const before = {
    chunks: rows(db, 'canon_chunk', project.id),
    entities: rows(db, 'canon_entity', project.id),
    relations: rows(db, 'canon_relation', project.id),
    status: db.get<{ review_status: string; confirmed_by_user: number }>(
      'SELECT review_status, confirmed_by_user FROM canon_relation WHERE project_id = ?',
      project.id,
    )!,
    schemaMeta: db.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'version'")?.value,
  };
  db.exec('DROP TABLE extraction_window_run; DROP TABLE extraction_run;');
  db.exec('PRAGMA user_version = 27');
  db.close();

  const reopened = new Db(path);
  assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 33);
  for (const table of ['extraction_run', 'extraction_window_run']) {
    assert.ok(
      reopened.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table),
      `${table} exists`,
    );
  }
  const indexes = reopened
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('extraction_run', 'extraction_window_run')",
    )
    .map((r) => r.name);
  for (const name of ['extraction_run_project', 'extraction_window_run_run', 'extraction_window_run_window']) {
    assert.ok(indexes.includes(name), name);
  }
  assert.equal(rows(reopened, 'canon_chunk', project.id), before.chunks);
  assert.equal(rows(reopened, 'canon_entity', project.id), before.entities);
  assert.equal(rows(reopened, 'canon_relation', project.id), before.relations);
  assert.deepEqual(
    reopened.get('SELECT review_status, confirmed_by_user FROM canon_relation WHERE project_id = ?', project.id),
    before.status,
  );
  assert.equal(
    reopened.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'version'")?.value,
    before.schemaMeta,
  );
  reopened.close();
});
