/**
 * Durable extraction recovery: synthetic databases only.
 *
 * These tests exercise the additive ledger, bounded complete-batch staging,
 * attempt/lease/fencing behavior, stage coverage, replay, contribution
 * idempotency and parent completion. They do not touch canon or trial data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../../fanfable/src/core/db.ts';
import { runMigrations, tableExists } from '../../fanfable/src/core/migrations.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import {
  DEFAULT_RECOVERY_POLICY,
  RecoveryController,
  legacyStagedContributionStatus,
  recoveryContributionUid,
  recoveryPublishedChunkIds,
  recoveryStageFingerprint,
  stagedRecoveryContributionUid,
} from '../../fanfable/src/extract/recovery.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';
import type { FinishReason } from '../../fanfable/src/core/llm.ts';

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
const FACT = {
  topic: 'the rain',
  statement: 'The rain had not stopped for three days.',
  kind: 'fact',
  certainty: 'confirmed',
  subject: 'Ardenne',
  chunk_index: 0,
  evidence: RAIN_QUOTE,
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

type Handler = (req: { system?: string; messages: { content: string }[] }) => string;

function passageBody(prompt: string): string {
  const first = prompt.indexOf('\n');
  const second = first < 0 ? -1 : prompt.indexOf('\n', first + 1);
  return second < 0 ? prompt : prompt.slice(second + 1);
}

function splitHandler(parts: {
  entitiesFacts?: string;
  relations?: string;
  timeline?: string;
} = {}): Handler {
  return (req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return parts.relations ?? JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return parts.timeline ?? JSON.stringify({ timeline: [] });
    return parts.entitiesFacts ?? JSON.stringify({ entities: [SERENA], facts: [] });
  };
}

function finishProvider(
  handler: Handler,
  finishReason: FinishReason | undefined | ((req: { system?: string; messages: { content: string }[] }) => FinishReason | undefined),
) {
  const llm = mockProvider(handler);
  const baseChat = llm.chat.bind(llm);
  llm.chat = async (req) => {
    const response = await baseChat(req);
    const reason = typeof finishReason === 'function' ? finishReason(req) : finishReason;
    return reason === undefined ? response : { ...response, finishReason: reason };
  };
  return llm;
}

function gatedProvider(handler: Handler) {
  const llm = mockProvider(handler);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const baseChat = llm.chat.bind(llm);
  llm.chat = async (req) => {
    calls++;
    if (calls === 1) {
      started();
      await gate;
    }
    return { ...(await baseChat(req)), finishReason: 'stop' as const };
  };
  return { llm, started: startedPromise, release, calls: () => calls };
}

function tinyPolicy(overrides: Record<string, unknown> = {}) {
  return {
    leaseMs: 60_000,
    heartbeatMs: 60_000,
    backoffMs: [1, 1],
    ...overrides,
  };
}

function recovery(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    sleep: async () => {},
    policy: tinyPolicy(),
    ...overrides,
  };
}

function minedCount(db: ReturnType<typeof tempDb>['db'], projectId: number): number {
  return db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1',
    projectId,
  )?.n ?? 0;
}

function totalChunks(db: ReturnType<typeof tempDb>['db'], projectId: number): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', projectId)?.n ?? 0;
}

function count(db: ReturnType<typeof tempDb>['db'], table: string, projectId: number): number {
  return db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, projectId)?.n ?? 0;
}

function projectChunks(db: ReturnType<typeof tempDb>['db'], projectId: number): number[] {
  return db
    .all<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY seq', projectId)
    .map((row) => row.id);
}

function addSourceChunks(db: Db, projectId: number, count = 2, text?: string): number[] {
  const at = new Date().toISOString();
  const sourceId = db.run(
    `INSERT INTO canon_source (project_id, path, title, sha256, imported_at)
     VALUES (?, ?, 'Synthetic', 'synthetic', ?)`,
    projectId,
    `synthetic-${projectId}-${at}`,
    at,
  ).lastInsertRowid;
  const ids: number[] = [];
  for (let index = 0; index < count; index++) {
    ids.push(
      db.run(
        `INSERT INTO canon_chunk (source_id, project_id, seq, locator, text)
         VALUES (?, ?, ?, ?, ?)`,
        sourceId,
        projectId,
        index,
        `p. ${index + 1}`,
        text ?? `Synthetic passage ${index + 1}. Serena Marsh watched it from the ridge.`,
      ).lastInsertRowid,
    );
  }
  return ids;
}

function parentChild(controller: RecoveryController, projectId: number, chunkIds: number[], stages: Array<'entities-facts' | 'relations' | 'timeline' | 'legacy'> = ['entities-facts']) {
  const parentId = controller.beginParent({
    projectId,
    scopeKey: `test-${projectId}-${Math.random()}`,
    fingerprint: `parent-${Math.random()}`,
  });
  const fingerprint = `child-${Math.random()}`;
  const childId = controller.beginChild({
    parentId,
    projectId,
    workKey: `work-${projectId}-${Math.random()}`,
    windowIndex: 0,
    sourceOrder: 0,
    chunkIds,
    requiredStages: stages,
    fingerprint,
  });
  return { parentId, childId };
}

function stageFingerprint(stage: 'entities-facts' | 'relations' | 'timeline' | 'legacy' = 'entities-facts'): string {
  return recoveryStageFingerprint({
    stage,
    chunkIds: [1, 2],
    chunkHashes: ['a', 'b'],
    promptHash: 'prompt',
    provider: 'mock',
    model: 'mock',
    settingsHash: 'settings',
  });
}

function claim(controller: RecoveryController, childId: number, owner = 'owner-a') {
  const result = controller.claimChild(childId, owner);
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.fencing);
  return result.fencing!;
}

function setFingerprint(
  controller: RecoveryController,
  childId: number,
  stage: 'entities-facts' | 'relations' | 'timeline' | 'legacy',
  fingerprint: string,
  owner = 'owner-a',
): number {
  const child = controller.getChild(childId)!;
  const fencing = child.status === 'running' ? child.fencing : claim(controller, childId, owner);
  controller.setStageFingerprint(childId, stage, fingerprint, owner, fencing);
  return fencing;
}

/* --------------------------------------------------------------- migration */

function dropRecoveryTables(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS extraction_effect;
    DROP TABLE IF EXISTS extraction_contribution;
    DROP TABLE IF EXISTS extraction_stage_coverage;
    DROP TABLE IF EXISTS extraction_staged_batch;
    DROP TABLE IF EXISTS extraction_attempt;
    DROP TABLE IF EXISTS extraction_chunk_lease;
    DROP TABLE IF EXISTS extraction_roster_snapshot;
    DROP TABLE IF EXISTS extraction_recovery_chunk_work;
    DROP TABLE IF EXISTS extraction_recovery_run_child;
    DROP TABLE IF EXISTS extraction_recovery_child;
    DROP TABLE IF EXISTS extraction_recovery_parent;
  `);
}

test('migration 31 is additive, creates the recovery ledger and preserves legacy state', () => {
  const { db, path } = tempDb();
  for (const table of [
    'extraction_recovery_parent',
    'extraction_recovery_child',
    'extraction_attempt',
    'extraction_staged_batch',
    'extraction_stage_coverage',
    'extraction_contribution',
    'extraction_effect',
    'extraction_chunk_lease',
    'extraction_roster_snapshot',
  ]) {
    assert.ok(tableExists(db.raw, table), `${table} exists`);
  }
  assert.equal(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 32);
  const attemptColumns = db.all<{ name: string }>('PRAGMA table_info(extraction_attempt)').map((row) => row.name);
  assert.ok(attemptColumns.includes('fingerprint'), 'attempts carry their stage fingerprint');
  const attemptIndex = db.get<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'extraction_attempt_number'",
  );
  assert.match(attemptIndex?.sql ?? '', /child_id, stage, fingerprint, retry_epoch, attempt_number/);

  const project = seedProject(db, 'recovery-migration');
  db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE project_id = ?', project.id);
  const before = {
    chunks: totalChunks(db, project.id),
    mined: minedCount(db, project.id),
    entity: db.get<{ name: string; review_status: string }>(
      'SELECT name, review_status FROM canon_entity WHERE project_id = ? LIMIT 1',
      project.id,
    ),
  };
  dropRecoveryTables(db);
  db.exec('PRAGMA user_version = 30');
  db.close();

  const reopened = new Db(path);
  assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 32);
  assert.ok(tableExists(reopened.raw, 'extraction_recovery_parent'));
  assert.equal(totalChunks(reopened, project.id), before.chunks);
  assert.equal(minedCount(reopened, project.id), before.mined);
  assert.deepEqual(
    reopened.get('SELECT name, review_status FROM canon_entity WHERE project_id = ? LIMIT 1', project.id),
    before.entity,
  );
  assert.equal(legacyStagedContributionStatus(reopened, project.id).count, 0);
  reopened.close();
});


test('an old experimental v31 database upgrades to the revised recovery schema without reusing old rows', () => {
  const { db, path } = tempDb();
  const project = seedProject(db, 'recovery-old-v31');
  const now = new Date().toISOString();
  const parent = db.run(
    `INSERT INTO extraction_recovery_parent
       (project_id, scope_key, dependency_version, fingerprint, status, readiness, optional_status, created_at)
     VALUES (?, 'old-v31', 'old', 'old-parent', 'pending', 'pending', '{}', ?)`,
    project.id,
    now,
  ).lastInsertRowid;
  const child = db.run(
    `INSERT INTO extraction_recovery_child
       (parent_id, project_id, work_key, window_index, source_order, chunk_ids, required_stages,
        stage_fingerprints, fingerprint, status, fencing, retry_epoch, created_at)
     VALUES (?, ?, '', 0, 0, '[1]', '["entities-facts"]', '{}', 'old-child', 'pending', 0, 0, ?)`,
    parent,
    project.id,
    now,
  ).lastInsertRowid;
  db.run(
    `INSERT INTO extraction_attempt
       (child_id, project_id, stage, fingerprint, retry_epoch, attempt_number, status, owner,
        fencing, lease_until, started_at)
     VALUES (?, ?, 'entities-facts', 'old-fp', 0, 1, 'failed', 'old-owner', 1, ?, ?)`,
    child,
    project.id,
    now,
    now,
  );
  db.run(
    `INSERT INTO extraction_contribution
       (project_id, child_id, stage, contribution_uid, claim_type, payload_sha256,
        dependency_fingerprint, evaluation_count, disposition, applied_at)
     VALUES (?, ?, 'entities-facts', 'old-uid', 'entity', 'old-hash', '', 0, 'dropped', ?)`,
    project.id,
    child,
    now,
  );
  db.run(
    `INSERT INTO extraction_contribution
       (project_id, child_id, stage, contribution_uid, claim_type, payload_sha256,
        dependency_fingerprint, evaluation_count, disposition, applied_at)
     VALUES (?, ?, 'entities-facts', 'old-staged-uid', 'entity', 'old-staged-hash', '', 0, 'staged', ?)`,
    project.id,
    child,
    now,
  );
  db.exec(`
    DROP TABLE extraction_recovery_chunk_work;
    DROP TABLE extraction_recovery_run_child;
    DROP INDEX IF EXISTS extraction_attempt_number;
    DROP INDEX IF EXISTS extraction_attempt_child;
    DROP INDEX IF EXISTS extraction_recovery_child_work;
    ALTER TABLE extraction_recovery_parent DROP COLUMN readiness;
    ALTER TABLE extraction_recovery_parent DROP COLUMN optional_status;
    ALTER TABLE extraction_recovery_child DROP COLUMN work_key;
    ALTER TABLE extraction_recovery_child DROP COLUMN retry_epoch;
    ALTER TABLE extraction_attempt DROP COLUMN fingerprint;
    ALTER TABLE extraction_attempt DROP COLUMN retry_epoch;
    ALTER TABLE extraction_contribution DROP COLUMN dependency_fingerprint;
    ALTER TABLE extraction_contribution DROP COLUMN evaluation_count;
    PRAGMA user_version = 31;
  `);
  db.close();

  const reopened = new Db(path);
  assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 32);
  for (const table of ['extraction_recovery_run_child', 'extraction_recovery_chunk_work']) {
    assert.ok(tableExists(reopened.raw, table), `${table} added by migration 32`);
  }
  const oldChild = reopened.get<{ work_key: string; retry_epoch: number }>(
    'SELECT work_key, retry_epoch FROM extraction_recovery_child WHERE id = ?',
    child,
  );
  assert.equal(oldChild?.work_key, '', 'old child has no invented work identity');
  assert.equal(oldChild?.retry_epoch, 0);
  const attempt = reopened.get<{ fingerprint: string; retry_epoch: number }>(
    'SELECT fingerprint, retry_epoch FROM extraction_attempt WHERE child_id = ?',
    child,
  );
  assert.equal(attempt?.fingerprint, '');
  const contribution = reopened.get<{ dependency_fingerprint: string; disposition: string }>(
    'SELECT dependency_fingerprint, disposition FROM extraction_contribution WHERE contribution_uid = ?',
    'old-uid',
  );
  assert.equal(contribution?.disposition, 'dropped');
  assert.equal(contribution?.dependency_fingerprint, '');
  const legacyStaged = legacyStagedContributionStatus(reopened, project.id);
  assert.equal(legacyStaged.count, 1);
  assert.deepEqual(legacyStaged.claimTypes, ['entity']);
  assert.equal(legacyStaged.status, 'incompatible-prefix');
  assert.equal(
    reopened.get<{ disposition: string }>(
      'SELECT disposition FROM extraction_contribution WHERE contribution_uid = ?',
      'old-staged-uid',
    )?.disposition,
    'staged',
    'migration does not turn a pre-namespace staged row into applied state',
  );

  const controller = new RecoveryController(reopened);
  const newChild = controller.beginChild({
    parentId: parent,
    projectId: project.id,
    workKey: 'new-generation-work',
    windowIndex: 1,
    sourceOrder: 1,
    chunkIds: [1],
    requiredStages: ['entities-facts'],
    fingerprint: 'new-generation',
  });
  assert.ok(newChild > child);
  reopened.close();
});

test('a failed migration 31 rolls back and leaves the old version and legacy rows intact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fanfable-recovery-migrate-'));
  const path = join(dir, 'broken.db');
  const db = new Db(path);
  db.run("INSERT INTO project (id, name, created_at, updated_at) VALUES (1, 'legacy', '2024', '2024')");
  db.run(
    `INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at)
     VALUES (1, 'character', 'Legacy', '[]', '2024', '2024')`,
  );
  dropRecoveryTables(db);
  db.exec('PRAGMA user_version = 30');
  db.exec(`
    CREATE TABLE extraction_recovery_parent (
      id INTEGER PRIMARY KEY,
      scope_key TEXT NOT NULL
    );
  `);
  db.close();

  assert.throws(() => new Db(path), /migration 31/);
  const raw = new DatabaseSync(path, { readOnly: true });
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 30);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM canon_entity').get() as { n: number }).n, 1);
  raw.close();
});

/* ---------------------------------------------------------- empty/completion */

test('explicit complete-empty batches finalize coverage and mined state', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-empty');
  const llm = finishProvider(splitHandler({
    entitiesFacts: JSON.stringify({ entities: [], facts: [] }),
    relations: JSON.stringify({ relations: [] }),
    timeline: JSON.stringify({ timeline: [] }),
  }), 'stop');

  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery(),
  });

  assert.equal(stats.recovery?.status, 'complete');
  assert.equal(minedCount(db, project.id), totalChunks(db, project.id));
  assert.equal(stats.windowIssues.length, 0);
  assert.ok(stats.emptyWindows.some((window) => window.reason === 'empty-answer'));
  const coverages = db.all<{ stage: string; status: string }>(
    'SELECT stage, status FROM extraction_stage_coverage ORDER BY id',
  );
  assert.ok(coverages.every((coverage) => coverage.status === 'empty' || coverage.status === 'not_applicable'));
  db.close();
});

test('missing, malformed, ambiguous, salvaged, length and unknown output stay deferred', async () => {
  const cases: Array<{ name: string; answer: string; finish: FinishReason | undefined; expectWrites: number }> = [
    { name: 'missing-facts', answer: JSON.stringify({ entities: [SERENA] }), finish: 'stop', expectWrites: 0 },
    { name: 'malformed', answer: '{"entities":[', finish: 'stop', expectWrites: 0 },
    { name: 'ambiguous-bare-array', answer: JSON.stringify([SERENA]), finish: 'stop', expectWrites: 0 },
    { name: 'salvaged', answer: `{"entities":[${JSON.stringify(SERENA)}],"facts":[{"topic":"rain"`, finish: 'stop', expectWrites: 0 },
    { name: 'length-with-valid-json', answer: JSON.stringify({ entities: [SERENA], facts: [] }), finish: 'length', expectWrites: 0 },
    { name: 'unknown', answer: JSON.stringify({ entities: [SERENA], facts: [] }), finish: 'unknown', expectWrites: 0 },
    { name: 'missing-finish', answer: JSON.stringify({ entities: [SERENA], facts: [] }), finish: undefined, expectWrites: 0 },
  ];

  for (const item of cases) {
    const { db } = tempDb();
    const project = seedProject(db, `recovery-${item.name}`);
    const llm = finishProvider(splitHandler({ entitiesFacts: item.answer }), item.finish);
    const stats = await lorebook.extractLore(db, llm, project.id, {
      windowSize: 8,
      concurrency: 1,
      recovery: recovery(),
    });
    assert.equal(stats.recovery?.status, 'deferred', item.name);
    assert.equal(minedCount(db, project.id), 0, item.name);
    assert.equal(count(db, 'canon_entity', project.id), item.expectWrites, item.name);
    const attempts = db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_attempt WHERE stage = 'entities-facts'",
    )?.n;
    assert.equal(attempts, 3, `${item.name}: three bounded attempts`);
    const deferred = db.get<{ status: string }>(
      "SELECT status FROM extraction_stage_coverage WHERE stage = 'entities-facts' ORDER BY id DESC LIMIT 1",
    );
    assert.equal(deferred?.status, 'deferred', item.name);
    db.close();
  }
});

test('exact repeats are idempotent; distinct claims remain separate contributions', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-idempotent', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1);
  const project = { id: projectId };
  const entity = { ...SERENA, aliases: ['Serena'], summary: 'The watcher.' };
  const first = finishProvider(splitHandler({
    entitiesFacts: JSON.stringify({ entities: [entity], facts: [] }),
  }), 'stop');
  const one = await lorebook.extractLore(db, first, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery(),
  });
  assert.equal(one.recovery?.status, 'complete');
  const beforeEntity = db.get<{ mentions: number; aliases: string; summary: string }>(
    'SELECT mentions, aliases, summary FROM canon_entity WHERE project_id = ?',
    project.id,
  )!;
  assert.equal(beforeEntity.mentions, 1);
  assert.equal(count(db, 'extraction_contribution', project.id), 1);

  db.run('UPDATE canon_chunk SET lore_mined = 0 WHERE project_id = ?', project.id);
  const second = finishProvider(splitHandler({
    entitiesFacts: JSON.stringify({ entities: [entity], facts: [] }),
  }), 'stop');
  const two = await lorebook.extractLore(db, second, project.id, {
    windowSize: 1,
    concurrency: 1,
    recovery: recovery({ explicitRetry: true }),
  });
  assert.equal(two.recovery?.status, 'complete');
  assert.equal(two.entities, 0, 'the exact repeat does not apply a second entity claim');
  const afterRepeat = db.get<{ mentions: number; aliases: string; summary: string }>(
    'SELECT mentions, aliases, summary FROM canon_entity WHERE project_id = ?',
    project.id,
  )!;
  assert.deepEqual(afterRepeat, beforeEntity, 'exact repeat leaves the entity row unchanged');
  assert.equal(count(db, 'extraction_contribution', project.id), 1, 'no duplicate contribution row');

  db.run('UPDATE canon_chunk SET lore_mined = 0 WHERE project_id = ?', project.id);
  const distinct = finishProvider(splitHandler({
    entitiesFacts: JSON.stringify({
      entities: [{ ...entity, aliases: ['Watcher'], summary: 'A different summary.', evidence: SERENA_QUOTE }],
      facts: [],
    }),
  }), 'stop');
  await lorebook.extractLore(db, distinct, project.id, {
    windowSize: 2,
    concurrency: 1,
    recovery: recovery({ explicitRetry: true }),
  });
  const afterDistinct = db.get<{ mentions: number; aliases: string; summary: string }>(
    'SELECT mentions, aliases, summary FROM canon_entity WHERE project_id = ?',
    project.id,
  )!;
  assert.equal(afterDistinct.summary, beforeEntity.summary, 'fill-only keeps the first non-empty summary');
  assert.match(afterDistinct.aliases, /Watcher/);
  assert.equal(afterDistinct.mentions, 2, 'a distinct claim is a distinct mention contribution');
  assert.equal(count(db, 'extraction_contribution', project.id), 2);
  db.close();
});

/* ------------------------------------------------------ attempts/ownership */

test('three automatic attempts can recover on the third, and all failures become visibly deferred', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-attempts');
  let calls = 0;
  const flaky = finishProvider((req) => {
    calls++;
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return calls < 3 ? JSON.stringify({ entities: [SERENA] }) : JSON.stringify({ entities: [SERENA], facts: [] });
  }, 'stop');
  const stats = await lorebook.extractLore(db, flaky, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery(),
  });
  assert.equal(stats.recovery?.status, 'complete');
  const attempts = db.all<{ attempt_number: number; status: string }>(
    "SELECT attempt_number, status FROM extraction_attempt WHERE stage = 'entities-facts' ORDER BY attempt_number",
  );
  assert.deepEqual(attempts.map((row) => row.status), ['incomplete', 'incomplete', 'succeeded']);
  assert.equal(minedCount(db, project.id), totalChunks(db, project.id));

  const { db: db2 } = tempDb();
  const project2 = seedProject(db2, 'recovery-exhausted');
  const down = finishProvider(splitHandler({ entitiesFacts: JSON.stringify({ entities: [SERENA] }) }), 'stop');
  const failed = await lorebook.extractLore(db2, down, project2.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery(),
  });
  assert.equal(failed.recovery?.status, 'deferred');
  assert.equal(minedCount(db2, project2.id), 0);
  assert.equal(
    db2.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_attempt WHERE stage = 'entities-facts'")?.n,
    3,
  );
  const deferred = new RecoveryController(db2).deferred(project2.id);
  assert.equal(deferred.length, 1);
  assert.ok(deferred[0]!.nextRetryAt);
  db2.close();
  db.close();
});

test('an active lease blocks another owner and an expired lease is fenced', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-lease');
  let now = 1_000_000;
  const controller = new RecoveryController(
    db,
    { leaseMs: 1000, heartbeatMs: 500, backoffMs: [1] },
    { now: () => now, sleep: async () => {} },
  );
  const { childId } = parentChild(controller, project.id, projectChunks(db, project.id));
  const fingerprint = stageFingerprint();
  setFingerprint(controller, childId, 'entities-facts', fingerprint);
  const fencingA = claim(controller, childId, 'owner-a');
  assert.equal(controller.beginAttempt(childId, 'entities-facts', 'owner-a', fencingA, fingerprint).ok, true);

  const blocked = controller.claimChild(childId, 'owner-b');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'overlap');

  now += 2000;
  const fencingB = claim(controller, childId, 'owner-b');
  assert.ok(fencingB > fencingA, 'fencing increases monotonically');
  const staleRenew = controller.renewChild(childId, 'owner-a', fencingA);
  assert.equal(staleRenew.ok, false);
  const attemptB = controller.beginAttempt(childId, 'entities-facts', 'owner-b', fencingB, fingerprint);
  assert.equal(attemptB.ok, true);
  assert.throws(
    () =>
      controller.applyCoverage({
        childId,
        projectId: project.id,
        stage: 'entities-facts',
        fingerprint,
        attemptId: attemptB.attemptId!,
        owner: 'owner-a',
        fencing: fencingA,
        status: 'empty',
        apply: () => {},
      }),
    /stale-fencing/,
  );
  db.close();
});


test('a stale owner cannot overwrite the stage fingerprint after takeover', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-stale-pointer');
  const controller = new RecoveryController(db, { leaseMs: 1000, heartbeatMs: 500, backoffMs: [1] });
  const { childId } = parentChild(controller, project.id, projectChunks(db, project.id).slice(0, 1));
  const f1 = stageFingerprint();
  const f2 = recoveryStageFingerprint({
    stage: 'entities-facts', chunkIds: [1], chunkHashes: ['a'], promptHash: 'p2',
    provider: 'mock', model: 'mock', settingsHash: 's',
  });
  const fencingA = setFingerprint(controller, childId, 'entities-facts', f1);
  controller.releaseChild(childId, 'owner-a', fencingA);
  db.run('UPDATE extraction_chunk_lease SET lease_until = ? WHERE child_id = ?', new Date(Date.now() - 60_000).toISOString(), childId);
  const fencingB = claim(controller, childId, 'owner-b');
  assert.throws(
    () => controller.setStageFingerprint(childId, 'entities-facts', f2, 'owner-a', fencingA),
    /stale-fencing/,
  );
  controller.setStageFingerprint(childId, 'entities-facts', f2, 'owner-b', fencingB);
  assert.equal(controller.getChild(childId)?.stage_fingerprints.includes(f2), true);
  db.close();
});

test('a crash after a committed staged batch replays without a provider and applies once', async () => {
  const { db, path } = tempDb();
  const project = seedProject(db, 'recovery-replay');
  const ids = projectChunks(db, project.id);
  const controller = new RecoveryController(db, { leaseMs: 60_000, heartbeatMs: 60_000, backoffMs: [1] });
  const { childId } = parentChild(controller, project.id, ids);
  const fingerprint = stageFingerprint();
  setFingerprint(controller, childId, 'entities-facts', fingerprint);
  const fencing = claim(controller, childId);
  const attempt = controller.beginAttempt(childId, 'entities-facts', 'owner-a', fencing, fingerprint);
  assert.equal(attempt.ok, true);
  controller.stageBatch({
    attemptId: attempt.attemptId!,
    childId,
    projectId: project.id,
    stage: 'entities-facts',
    fingerprint,
    payload: { entities: [], facts: [] },
    finishReason: 'stop',
    complete: true,
  });
  db.run('CREATE TABLE recovery_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  const past = new Date(Date.now() - 60_000).toISOString();
  db.run('UPDATE extraction_chunk_lease SET lease_until = ? WHERE child_id = ?', past, childId);
  db.run('UPDATE extraction_attempt SET lease_until = ? WHERE child_id = ?', past, childId);
  db.close();

  const reopened = new Db(path);
  const replay = new RecoveryController(reopened, { leaseMs: 1000, heartbeatMs: 500, backoffMs: [1] });
  const staged = replay.latestStagedBatch(childId, 'entities-facts', fingerprint);
  assert.ok(staged);
  const fencing2 = claim(replay, childId, 'owner-b');
  replay.applyCoverage({
    childId,
    projectId: project.id,
    stage: 'entities-facts',
    fingerprint,
    attemptId: staged!.attempt_id,
    owner: 'owner-b',
    fencing: fencing2,
    status: 'empty',
    apply: () => reopened.run("INSERT INTO recovery_probe (value) VALUES ('once')"),
  });
  replay.applyCoverage({
    childId,
    projectId: project.id,
    stage: 'entities-facts',
    fingerprint,
    attemptId: staged!.attempt_id,
    owner: 'owner-b',
    fencing: fencing2,
    status: 'empty',
    apply: () => reopened.run("INSERT INTO recovery_probe (value) VALUES ('twice')"),
  });
  assert.equal(reopened.get<{ n: number }>('SELECT COUNT(*) AS n FROM recovery_probe')?.n, 1);
  assert.equal(replay.finalizeChild(childId, 'owner-b', fencing2), 'complete');
  assert.equal(reopened.get<{ n: number }>('SELECT COUNT(*) AS n FROM recovery_probe')?.n, 1);
  reopened.close();
});

test('parent completion waits for every required child and preserves source order', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-parent');
  const ids = projectChunks(db, project.id);
  const controller = new RecoveryController(db, { leaseMs: 1000, heartbeatMs: 500, backoffMs: [1] });
  const parentId = controller.beginParent({
    projectId: project.id,
    scopeKey: 'parent-test',
    fingerprint: 'parent-fingerprint',
  });
  const childA = controller.beginChild({
    parentId,
    projectId: project.id,
    workKey: 'work-a',
    windowIndex: 0,
    sourceOrder: 0,
    chunkIds: [ids[0]!],
    requiredStages: ['entities-facts'],
    fingerprint: 'child-a',
  });
  const childB = controller.beginChild({
    parentId,
    projectId: project.id,
    workKey: 'work-b',
    windowIndex: 1,
    sourceOrder: 1,
    chunkIds: [ids[1]!],
    requiredStages: ['entities-facts'],
    fingerprint: 'child-b',
  });
  const fingerprint = stageFingerprint();
  for (const [childId, owner] of [[childA, 'owner-a'], [childB, 'owner-b']] as const) {
    setFingerprint(controller, childId, 'entities-facts', fingerprint, owner);
    const fencing = claim(controller, childId, owner);
    const attempt = controller.beginAttempt(childId, 'entities-facts', owner, fencing, fingerprint);
    controller.stageBatch({
      attemptId: attempt.attemptId!,
      childId,
      projectId: project.id,
      stage: 'entities-facts',
      fingerprint,
      payload: { entities: [], facts: [] },
      finishReason: 'stop',
      complete: true,
    });
    controller.applyCoverage({
      childId,
      projectId: project.id,
      stage: 'entities-facts',
      fingerprint,
      attemptId: attempt.attemptId!,
      owner,
      fencing,
      status: 'empty',
      apply: () => {},
    });
  }
  assert.equal(controller.finalizeChild(childA, 'owner-a', 1), 'complete');
  assert.equal(controller.finalizeParent(parentId), 'pending');
  assert.equal(controller.finalizeChild(childB, 'owner-b', 1), 'complete');
  assert.equal(controller.finalizeParent(parentId), 'complete');
  assert.equal(minedCount(db, project.id), 2);
  const children = controller.children(parentId);
  assert.deepEqual(children.map((child) => child.source_order), [0, 1]);
  db.close();
});

test('roster changes invalidate relationship fingerprints without changing other stages', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-roster');
  const controller = new RecoveryController(db);
  const at = new Date().toISOString();
  db.run(
    `INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at)
     VALUES (?, 'character', 'Serena Marsh', '[]', ?, ?)`,
    project.id,
    at,
    at,
  );
  const base = {
    stage: 'relations' as const,
    chunkIds: [1],
    chunkHashes: ['a'],
    promptHash: 'p',
    provider: 'mock',
    model: 'mock',
    settingsHash: 's',
  };
  const before = controller.snapshotRoster(project.id);
  const first = recoveryStageFingerprint({ ...base, rosterFingerprint: before.fingerprint });
  db.run("UPDATE canon_entity SET aliases = '[\"New Alias\"]' WHERE project_id = ? AND id = (SELECT MIN(id) FROM canon_entity WHERE project_id = ?)", project.id, project.id);
  const after = controller.snapshotRoster(project.id);
  assert.notEqual(before.fingerprint, after.fingerprint);
  const second = recoveryStageFingerprint({ ...base, rosterFingerprint: after.fingerprint });
  assert.notEqual(first, second);
  const entityStage = recoveryStageFingerprint({ ...base, stage: 'entities-facts' });
  const entityStageAgain = recoveryStageFingerprint({ ...base, stage: 'entities-facts', rosterFingerprint: after.fingerprint });
  assert.equal(entityStage, entityStageAgain, 'non-relationship stages ignore the roster snapshot');
  db.close();
});

test('contribution identity separates different sources and repeats one source exactly', () => {
  const payload = { name: 'Serena Marsh', kind: 'character' };
  const one = recoveryContributionUid({ claimType: 'entity', sourceChunkId: 1, payload });
  const repeat = recoveryContributionUid({ claimType: 'entity', sourceChunkId: 1, payload });
  const regrouped = recoveryContributionUid({
    claimType: 'entity',
    sourceChunkId: 1,
    payload: { ...payload, chunk_index: 7 },
  });
  const otherSource = recoveryContributionUid({ claimType: 'entity', sourceChunkId: 2, payload });
  const otherKind = recoveryContributionUid({ claimType: 'fact', sourceChunkId: 1, payload });
  assert.equal(one, repeat);
  assert.equal(one, regrouped, 'window-relative chunk_index is not part of identity');
  assert.notEqual(one, otherSource);
  assert.notEqual(one, otherKind);
});


test('all covered side effects are idempotent on an exact retry and human decisions stay put', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-side-effects');
  const entity = { ...SERENA, aliases: ['Serena'], summary: 'The watcher.', evidence: SERENA_QUOTE };
  const relation = {
    from: 'Serena Marsh',
    to: 'Kade',
    kind: 'friend of',
    description: 'A claim with a deliberately non-verbatim citation.',
    chunk_index: 0,
    evidence: 'This sentence appears nowhere in the passage.',
  };
  const handler = (req: { system?: string; messages: { content: string }[] }) => {
    const system = req.system ?? '';
    const hasSerena = req.messages.some((message) => message.content.includes(SERENA_QUOTE));
    if (!hasSerena) {
      if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
      if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
      return JSON.stringify({ entities: [], facts: [] });
    }
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [relation] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [EVENT] });
    return JSON.stringify({ entities: [entity, KADE], facts: [FACT] });
  };
  const first = finishProvider(handler, 'stop');
  const one = await lorebook.extractLore(db, first, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery(),
  });
  assert.equal(one.recovery?.status, 'complete');
  const before = {
    entity: db.get('SELECT mentions, aliases, summary, review_status, source_refs FROM canon_entity WHERE project_id = ? AND name = ?', project.id, 'Serena Marsh'),
    facts: count(db, 'canon_fact', project.id),
    timeline: count(db, 'canon_timeline', project.id),
    notes: count(db, 'canon_tie_note', project.id),
    threadNotes: count(db, 'canon_thread_note', project.id),
    rulings: count(db, 'canon_ruling', project.id),
  };
  assert.ok(before.notes + before.threadNotes + before.rulings > 0, 'a side-effect row exists to protect');
  db.run("UPDATE canon_entity SET review_status = 'user_confirmed', summary = 'HUMAN SUMMARY' WHERE project_id = ? AND name = ?", project.id, 'Serena Marsh');
  const human = db.get('SELECT mentions, aliases, summary, review_status, source_refs FROM canon_entity WHERE project_id = ? AND name = ?', project.id, 'Serena Marsh');

  db.run('UPDATE canon_chunk SET lore_mined = 0 WHERE project_id = ?', project.id);
  const second = finishProvider(handler, 'stop');
  const two = await lorebook.extractLore(db, second, project.id, {
    windowSize: 1,
    concurrency: 1,
    recovery: recovery({ explicitRetry: true }),
  });
  assert.equal(two.recovery?.status, 'complete');
  assert.equal(two.entities, 0);
  assert.equal(two.facts, 0);
  assert.equal(two.relations, 0);
  assert.equal(two.timeline, 0);
  assert.deepEqual(
    db.get('SELECT mentions, aliases, summary, review_status, source_refs FROM canon_entity WHERE project_id = ? AND name = ?', project.id, 'Serena Marsh'),
    human,
  );
  assert.equal(count(db, 'canon_fact', project.id), before.facts);
  assert.equal(count(db, 'canon_timeline', project.id), before.timeline);
  assert.equal(count(db, 'canon_tie_note', project.id), before.notes);
  assert.equal(count(db, 'canon_thread_note', project.id), before.threadNotes);
  assert.equal(count(db, 'canon_ruling', project.id), before.rulings);
  db.close();
});

test('overlapping differently grouped children cannot both own a shared chunk', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-overlap');
  const ids = projectChunks(db, project.id);
  const controller = new RecoveryController(db, { leaseMs: 60_000, heartbeatMs: 60_000, backoffMs: [1] });
  const parentId = controller.beginParent({ projectId: project.id, scopeKey: 'overlap', fingerprint: 'overlap' });
  const a = controller.beginChild({
    parentId,
    projectId: project.id,
    workKey: 'overlap-a',
    windowIndex: 0,
    sourceOrder: 0,
    chunkIds: [ids[0]!, ids[1]!],
    requiredStages: ['entities-facts'],
    fingerprint: 'a',
  });
  const b = controller.beginChild({
    parentId,
    projectId: project.id,
    workKey: 'overlap-b',
    windowIndex: 1,
    sourceOrder: 1,
    chunkIds: [ids[1]!, ids[2]!],
    requiredStages: ['entities-facts'],
    fingerprint: 'b',
  });
  claim(controller, a, 'owner-a');
  const blocked = controller.claimChild(b, 'owner-b');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'overlap');
  assert.deepEqual(blocked.conflicts, [ids[1]]);
  db.close();
});

test('a crash during finalization rolls back mined state and can finalize again', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-finalize-crash');
  const controller = new RecoveryController(db, { leaseMs: 60_000, heartbeatMs: 60_000, backoffMs: [1] });
  const { childId } = parentChild(controller, project.id, projectChunks(db, project.id));
  const fingerprint = stageFingerprint();
  setFingerprint(controller, childId, 'entities-facts', fingerprint);
  const fencing = claim(controller, childId);
  const attempt = controller.beginAttempt(childId, 'entities-facts', 'owner-a', fencing, fingerprint);
  controller.stageBatch({
    attemptId: attempt.attemptId!, childId, projectId: project.id, stage: 'entities-facts', fingerprint,
    payload: { entities: [], facts: [] }, finishReason: 'stop', complete: true,
  });
  controller.applyCoverage({
    childId, projectId: project.id, stage: 'entities-facts', fingerprint,
    attemptId: attempt.attemptId!, owner: 'owner-a', fencing, status: 'empty', apply: () => {},
  });
  db.exec(`
    CREATE TRIGGER block_mined BEFORE UPDATE OF lore_mined ON canon_chunk
    WHEN NEW.lore_mined = 1
    BEGIN SELECT RAISE(ABORT, 'finalize crash'); END;
  `);
  assert.throws(() => controller.finalizeChild(childId, 'owner-a', fencing), /finalize crash/);
  assert.equal(minedCount(db, project.id), 0);
  db.exec('DROP TRIGGER block_mined');
  assert.equal(controller.finalizeChild(childId, 'owner-a', fencing), 'complete');
  assert.equal(minedCount(db, project.id), totalChunks(db, project.id));
  db.close();
});

test('source, prompt and settings changes produce different stage fingerprints', () => {
  const base = {
    stage: 'entities-facts' as const,
    chunkIds: [1],
    chunkHashes: ['a'],
    promptHash: 'p',
    provider: 'mock',
    model: 'mock',
    settingsHash: 's',
  };
  const a = recoveryStageFingerprint(base);
  assert.notEqual(a, recoveryStageFingerprint({ ...base, chunkHashes: ['b'] }));
  assert.notEqual(a, recoveryStageFingerprint({ ...base, promptHash: 'p2' }));
  assert.notEqual(a, recoveryStageFingerprint({ ...base, settingsHash: 's2' }));
  assert.notEqual(a, recoveryStageFingerprint({ ...base, model: 'm2' }));
});

test('recovery tracing does not change extraction rows or counts', async () => {
  const results: Array<{ stats: Record<string, unknown>; rows: Record<string, unknown> }> = [];
  for (const trace of [false, true]) {
    const { db } = tempDb();
    const project = seedProject(db, `recovery-trace-${trace}`);
    const llm = finishProvider(splitHandler({
      entitiesFacts: JSON.stringify({ entities: [SERENA], facts: [FACT] }),
      timeline: JSON.stringify({ timeline: [EVENT] }),
    }), 'stop');
    const stats = await lorebook.extractLore(db, llm, project.id, {
      windowSize: 8,
      concurrency: 1,
      trace: trace ? { enabled: true } : undefined,
      recovery: recovery(),
    });
    results.push({
      stats: { entities: stats.entities, facts: stats.facts, relations: stats.relations, timeline: stats.timeline, windows: stats.windows },
      rows: {
        entities: count(db, 'canon_entity', project.id),
        facts: count(db, 'canon_fact', project.id),
        relations: count(db, 'canon_relation', project.id),
        timeline: count(db, 'canon_timeline', project.id),
        mined: minedCount(db, project.id),
      },
    });
    if (trace) assert.ok(stats.traceId);
    else assert.equal(stats.traceId, undefined);
    db.close();
  }
  assert.deepEqual(results[0], results[1]);
});



test('an in-process abort marks the owning child failed and releases its leases; a stale owner cannot abort', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-abort');
  const controller = new RecoveryController(db, { leaseMs: 60_000, heartbeatMs: 60_000, backoffMs: [1] });
  const { childId, parentId } = parentChild(controller, project.id, projectChunks(db, project.id));
  const fingerprint = stageFingerprint();
  setFingerprint(controller, childId, 'entities-facts', fingerprint);
  const fencing = claim(controller, childId, 'owner-a');
  const attempt = controller.beginAttempt(childId, 'entities-facts', 'owner-a', fencing, fingerprint);
  assert.equal(attempt.ok, true);
  assert.equal(controller.abortChild(childId, 'owner-b', fencing, 'wrong owner'), false);
  assert.equal(controller.abortChild(childId, 'owner-a', fencing, 'test abort'), true);
  assert.equal(controller.getChild(childId)?.status, 'failed');
  assert.equal(controller.getParent(parentId)?.status, 'failed');
  assert.equal(
    db.get<{ status: string }>('SELECT status FROM extraction_attempt WHERE id = ?', attempt.attemptId)?.status,
    'abandoned',
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_chunk_lease WHERE lease_until > ?', new Date().toISOString())?.n,
    0,
  );
  db.close();
});

test('attempt budgets are grouped by stage fingerprint, so a config change gets a fresh bounded budget', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-fingerprint-budget');
  const controller = new RecoveryController(db, { leaseMs: 60_000, heartbeatMs: 60_000, backoffMs: [1] });
  const { childId } = parentChild(controller, project.id, projectChunks(db, project.id));
  const f1 = stageFingerprint('entities-facts');
  const f2 = recoveryStageFingerprint({
    stage: 'entities-facts', chunkIds: [1, 2], chunkHashes: ['a', 'b'],
    promptHash: 'prompt-v2', provider: 'mock', model: 'mock', settingsHash: 'settings',
  });
  setFingerprint(controller, childId, 'entities-facts', f1);
  const fencing = claim(controller, childId);
  const first = controller.beginAttempt(childId, 'entities-facts', 'owner-a', fencing, f1);
  assert.equal(first.attemptNumber, 1);
  controller.finishAttempt(first.attemptId!, 'failed', { owner: 'owner-a', fencing });
  setFingerprint(controller, childId, 'entities-facts', f2);
  const second = controller.beginAttempt(childId, 'entities-facts', 'owner-a', fencing, f2);
  assert.equal(second.ok, true);
  assert.equal(second.attemptNumber, 1, 'a new fingerprint has its own attempt one');
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_attempt WHERE fingerprint = ?", f1)?.n,
    1,
  );
  db.close();
});

test('stale owner cannot stage, defer or finalize; attempt/child linkage is enforced', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-stale-owner');
  const ids = projectChunks(db, project.id);
  const controller = new RecoveryController(db, { leaseMs: 1000, heartbeatMs: 500, backoffMs: [1] });
  const { childId } = parentChild(controller, project.id, ids);
  const fingerprint = stageFingerprint();
  setFingerprint(controller, childId, 'entities-facts', fingerprint);
  const fencingA = claim(controller, childId, 'owner-a');
  const attemptA = controller.beginAttempt(childId, 'entities-facts', 'owner-a', fencingA, fingerprint);
  assert.equal(attemptA.ok, true);
  // Same-owner re-claim is idempotent.
  assert.equal(controller.claimChild(childId, 'owner-a').fencing, fencingA);

  controller.releaseChild(childId, 'owner-a', fencingA);
  db.run('UPDATE extraction_chunk_lease SET lease_until = ? WHERE child_id = ?', new Date(Date.now() - 60_000).toISOString(), childId);
  const fencingB = claim(controller, childId, 'owner-b');
  assert.ok(fencingB > fencingA);
  const attemptB = controller.beginAttempt(childId, 'entities-facts', 'owner-b', fencingB, fingerprint);
  assert.equal(attemptB.ok, true);
  assert.throws(
    () =>
      controller.stageBatch({
        attemptId: attemptA.attemptId!,
        childId,
        projectId: project.id,
        stage: 'entities-facts',
        fingerprint,
        payload: { entities: [], facts: [] },
        finishReason: 'stop',
        complete: true,
      }),
    /not running|stale-fencing/,
  );
  assert.throws(
    () =>
      controller.deferStage({
        childId,
        projectId: project.id,
        stage: 'entities-facts',
        fingerprint,
        attemptId: attemptA.attemptId,
        owner: 'owner-a',
        fencing: fencingA,
        reason: 'stale',
      }),
    /stale-fencing/,
  );
  assert.throws(
    () => controller.finalizeChild(childId, 'owner-a', fencingA),
    /stale-fencing/,
  );
  assert.throws(
    () =>
      controller.applyCoverage({
        childId,
        projectId: project.id,
        stage: 'entities-facts',
        fingerprint: 'other-fingerprint',
        attemptId: attemptB.attemptId!,
        owner: 'owner-b',
        fencing: fencingB,
        status: 'empty',
        apply: () => {},
      }),
    /stale-attempt/,
  );
  assert.equal(controller.stageBatch({
    attemptId: attemptB.attemptId!,
    childId,
    projectId: project.id,
    stage: 'entities-facts',
    fingerprint,
    payload: { entities: [], facts: [] },
    finishReason: 'stop',
    complete: true,
  }) > 0, true);
  assert.equal(
    controller.applyCoverage({
      childId,
      projectId: project.id,
      stage: 'entities-facts',
      fingerprint,
      attemptId: attemptB.attemptId!,
      owner: 'owner-b',
      fencing: fencingB,
      status: 'empty',
      apply: () => {},
    }).status,
    'empty',
  );
  db.close();
});



test('an error after window completion still finalizes the recovery parent in the finally path', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-finalize-finally');
  db.exec(`
    CREATE TRIGGER block_window_insert BEFORE INSERT ON extraction_window_run
    BEGIN SELECT RAISE(ABORT, 'window provenance crash'); END;
  `);
  const llm = finishProvider(splitHandler(), 'stop');
  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery(),
  });
  assert.equal(stats.recovery?.status, 'failed');
  assert.equal(minedCount(db, project.id), 0, 'no false mined after provenance failure');
  const parent = db.get<{ id: number; status: string }>(
    'SELECT id, status FROM extraction_recovery_parent ORDER BY id DESC LIMIT 1',
  );
  assert.ok(parent);
  assert.equal(parent.status, 'failed');
  const child = db.get<{ status: string }>(
    'SELECT status FROM extraction_recovery_child WHERE parent_id = ?',
    parent.id,
  );
  assert.equal(child?.status, 'failed');
  assert.ok(
    stats.windowIssues.some((issue) => /finalize:.*window provenance crash/.test(issue.detail)),
  );
  db.close();
});

test('a roster change during a relationship call fails closed instead of applying a stale snapshot', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-roster-change');
  let mutated = false;
  const handler = (req: { system?: string }) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      if (!mutated) {
        mutated = true;
        db.run(
          `INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at)
           VALUES (?, 'character', 'Roster Shift', '[]', ?, ?)`,
          project.id,
          new Date().toISOString(),
          new Date().toISOString(),
        );
      }
      return JSON.stringify({ relations: [] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [SERENA], facts: [] });
  };
  const llm = finishProvider(handler, 'stop');
  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery(),
  });
  assert.equal(stats.recovery?.status, 'complete');
  assert.equal(count(db, 'canon_relation', project.id), 0);
  const relationAttempts = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM extraction_attempt WHERE stage = 'relations'",
  )?.n;
  assert.equal(relationAttempts, 2, 'one stale snapshot then one fresh snapshot');
  assert.equal(
    db.get<{ status: string }>(
      "SELECT status FROM extraction_stage_coverage WHERE stage = 'relations' ORDER BY id DESC LIMIT 1",
    )?.status,
    'empty',
  );
  db.close();
});

test('default real-provider extraction uses recovery without an explicit flag', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-default-real');
  const settings = {
    ...(await import('../../fanfable/src/core/llm.ts')).DEFAULT_LLM_SETTINGS,
    provider: 'ollama' as const,
    model: 'synthetic-ollama',
  };
  const llm = {
    settings,
    available: async () => true,
    chat: async (req: { system?: string }) => {
      const system = req.system ?? '';
      const text = system.includes('KNOWN ENTITIES')
        ? JSON.stringify({ relations: [] })
        : system.includes('"timeline"')
          ? JSON.stringify({ timeline: [] })
          : JSON.stringify({ entities: [SERENA], facts: [] });
      return { text, model: settings.model, provider: settings.provider, durationMs: 0, finishReason: 'stop' as const };
    },
  };
  const stats = await lorebook.extractLore(db, llm as never, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: { sleep: async () => {}, policy: tinyPolicy() },
  });
  assert.equal(stats.recovery?.status, 'complete');
  assert.equal(stats.recovery?.readiness, 'staged_only');
  assert.equal(minedCount(db, project.id), 0);
  assert.equal(count(db, 'canon_entity', project.id), 0);
  assert.ok((stats.entities ?? 0) > 0);
  db.close();
});

test('distinct timeline claims with the same title are kept separate', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-timeline-identity');
  const eventOne = { ...EVENT, title: 'A crossing', summary: 'The first crossing.', evidence: 'Someone had crossed.' };
  const eventTwo = { ...EVENT, title: 'A crossing', summary: 'A different crossing.', evidence: 'Someone had crossed.' };
  const llm = finishProvider(splitHandler({
    entitiesFacts: JSON.stringify({ entities: [SERENA], facts: [] }),
    timeline: JSON.stringify({ timeline: [eventOne, eventTwo] }),
  }), 'stop');
  await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery(),
  });
  assert.equal(count(db, 'canon_timeline', project.id), 2);
  db.close();
});


test('a multi-window restart links reusable work and does not abandon sealed windows or budgets', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-subset-restart');
  let calls = 0;
  const handler = (req: { system?: string }) => {
    calls++;
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  };
  const llm = finishProvider(handler, 'stop');
  const first = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 1,
    concurrency: 1,
    maxWindows: 2,
    recovery: recovery(),
  });
  assert.equal(first.recovery?.status, 'complete');
  const firstCalls = calls;
  assert.equal(firstCalls, 6, 'two windows × three sections');
  assert.equal(minedCount(db, project.id), 2);
  const firstChildren = db.all<{ id: number }>('SELECT id FROM extraction_recovery_child ORDER BY id');
  assert.equal(firstChildren.length, 2);
  const firstLinks = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_run_child')?.n;
  assert.equal(firstLinks, 2);

  const second = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 1,
    concurrency: 1,
    recovery: recovery(),
  });
  assert.equal(second.recovery?.status, 'complete');
  assert.equal(calls, firstCalls + 6, 'only the two pending windows call the provider');
  assert.equal(minedCount(db, project.id), 4);
  const allChildren = db.all<{ id: number }>('SELECT id FROM extraction_recovery_child ORDER BY id');
  assert.equal(allChildren.length, 4, 'completed work is reused, not re-created');
  const allLinks = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_run_child')?.n;
  assert.equal(allLinks, 6, 'the second run links two old and two new children');
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_parent')?.n,
    2,
    'parent is run provenance, not work identity',
  );
  assert.ok(firstChildren.every((child) =>
    db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM extraction_recovery_run_child WHERE child_id = ?',
      child.id,
    )?.n === 2,
  ));
  db.close();
});


test('lazy selections reuse compatible work without duplicate calls or budget resets', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-lazy-vary');
  const ids = projectChunks(db, project.id);
  let calls = 0;
  const llm = finishProvider((req) => {
    calls++;
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  (llm.settings as { provider: 'ollama' }).provider = 'ollama';

  const first = await lorebook.ensureWindowsForChunks(db, llm, project.id, [ids[0]!], {
    windowSize: 1,
    maxLazyWindows: 1,
  });
  assert.equal(first.windows, 1);
  assert.equal(calls, 3);
  assert.equal(first.recovery?.readiness, 'staged_only');
  assert.equal(minedCount(db, project.id), 0);

  const second = await lorebook.ensureWindowsForChunks(db, llm, project.id, [ids[1]!], {
    windowSize: 1,
    maxLazyWindows: 1,
  });
  assert.equal(second.windows, 1);
  assert.equal(calls, 6);
  assert.equal(minedCount(db, project.id), 0);

  const repeated = await lorebook.ensureWindowsForChunks(db, llm, project.id, [ids[0]!], {
    windowSize: 1,
    maxLazyWindows: 1,
  });
  assert.equal(repeated.windows, 1, 'the completed window is located, not re-created');
  assert.equal(calls, 6, 'a compatible completed child makes no provider call');

  const all = await lorebook.ensureWindowsForChunks(db, llm, project.id, ids, {
    windowSize: 1,
    maxLazyWindows: 4,
  });
  assert.equal(all.windows, 4);
  assert.equal(calls, 12, 'only the two previously pending windows call all sections');
  assert.equal(minedCount(db, project.id), 0);
  assert.equal(count(db, 'canon_entity', project.id), 0);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_child WHERE project_id = ?', project.id)?.n,
    4,
  );
  db.close();
});

test('legacy mined windows are never reset or reprocessed in recovery mode', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-legacy-boundary');
  const ids = projectChunks(db, project.id);
  db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE id = ?', ids[0]);
  let calls = 0;
  const llm = finishProvider((req) => {
    calls++;
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 1,
    concurrency: 1,
    fresh: true,
    recovery: recovery(),
  });
  assert.equal(stats.legacyBlockedWindows, 1);
  assert.equal(
    db.get<{ lore_mined: number }>('SELECT lore_mined FROM canon_chunk WHERE id = ?', ids[0])?.lore_mined,
    1,
    'legacy flag is not reset',
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_chunk_work WHERE chunk_id = ?', ids[0])?.n,
    0,
    'legacy row is never claimed as recovery work',
  );
  assert.equal(minedCount(db, project.id), 4, 'the other three windows finalize');
  assert.equal(calls, 9, 'three windows × three sections');
  db.close();
});

test('in-place source changes create a new generation while exact contributions remain idempotent', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-source-change', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1);
  const entity = { ...SERENA, aliases: ['Serena'], summary: 'The watcher.' };
  let calls = 0;
  const llm = finishProvider((req) => {
    calls++;
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [entity], facts: [] });
  }, 'stop');
  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8, concurrency: 1, recovery: recovery(),
  });
  assert.equal(first.recovery?.status, 'complete');
  const firstCalls = calls;
  assert.equal(firstCalls, 3);
  const beforeMentions = db.get<{ mentions: number }>(
    'SELECT mentions FROM canon_entity WHERE project_id = ? AND name = ?',
    projectId,
    'Serena Marsh',
  )?.mentions;
  assert.equal(beforeMentions, 1);

  const rerun = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8, concurrency: 1, recovery: recovery(),
  });
  assert.equal(rerun.recovery?.status, 'complete');
  assert.equal(calls, firstCalls, 'a compatible completed child short-circuits');
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_child WHERE project_id = ?', projectId)?.n,
    1,
  );

  db.run('UPDATE canon_chunk SET text = ? WHERE project_id = ?', 'SERENA_QUOTE_CHANGED', projectId);
  const changed = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8, concurrency: 1, recovery: recovery(),
  });
  assert.equal(changed.recovery?.status, 'complete');
  assert.equal(calls, firstCalls + 3, 'changed source content gets a new generation');
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_child WHERE project_id = ?', projectId)?.n,
    2,
  );
  assert.equal(
    db.get<{ mentions: number }>(
      'SELECT mentions FROM canon_entity WHERE project_id = ? AND name = ?',
      projectId,
      'Serena Marsh',
    )?.mentions,
    1,
    'the exact contribution is not applied twice',
  );

  (llm.settings as { model: string }).model = 'mock-model-v2';
  const configured = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8, concurrency: 1, recovery: recovery(),
  });
  assert.equal(configured.recovery?.status, 'complete');
  assert.equal(calls, firstCalls + 6, 'a model/config change gets another generation');
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_child WHERE project_id = ?', projectId)?.n,
    3,
  );
  db.close();
});

test('lease renewal is all-or-nothing and never revives an expired lease', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-renew');
  const controller = new RecoveryController(db, { leaseMs: 60_000, heartbeatMs: 60_000, backoffMs: [1] });
  const ids = projectChunks(db, project.id);
  const { childId } = parentChild(controller, project.id, ids.slice(0, 2));
  const fencing = claim(controller, childId, 'owner-a');
  const leases = db.all<{ chunk_id: number; lease_until: string }>(
    'SELECT chunk_id, lease_until FROM extraction_chunk_lease WHERE child_id = ? ORDER BY chunk_id',
    childId,
  );
  db.run(
    'UPDATE extraction_chunk_lease SET lease_until = ? WHERE chunk_id = ?',
    new Date(Date.now() - 60_000).toISOString(),
    leases[0]!.chunk_id,
  );
  const secondBefore = leases[1]!.lease_until;
  assert.equal(controller.renewChild(childId, 'owner-a', fencing).ok, false);
  assert.equal(
    db.get<{ lease_until: string }>(
      'SELECT lease_until FROM extraction_chunk_lease WHERE chunk_id = ?',
      leases[1]!.chunk_id,
    )?.lease_until,
    secondBefore,
    'the other chunk was not partially renewed',
  );
  db.close();
});

test('a deferred entities stage with an empty roster stays deferred without stale-fencing', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-deferred-no-roster');
  const llm = finishProvider(splitHandler({ entitiesFacts: JSON.stringify({ entities: [] }) }), 'stop');
  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery(),
  });
  assert.equal(stats.recovery?.status, 'deferred');
  assert.equal(minedCount(db, project.id), 0);
  assert.equal(
    stats.windowIssues.some((issue) => /stale-fencing/.test(issue.detail)),
    false,
  );
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_attempt WHERE stage = 'relations'")?.n,
    0,
    'the empty-roster branch does not attempt on a deferred child',
  );
  db.close();
});

test('recovery makes mandatory correctness and optional work visibly pending', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-readiness');
  const llm = finishProvider(splitHandler(), 'stop');
  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery(),
    embed: { baseUrl: 'http://127.0.0.1:1' },
  });
  assert.equal(stats.recovery?.status, 'complete');
  assert.equal(stats.recovery?.readiness, 'correctness_pending');
  assert.equal(stats.recovery?.optional.noteIngestion, 'deferred');
  assert.equal(stats.recovery?.optional.closeTheLoop, 'deferred');
  assert.equal(stats.recovery?.optional.embeddings, 'pending');
  assert.equal(stats.recovery?.optional.projectWideDisposition, 'pending');
  const parent = db.get<{ readiness: string; optional_status: string }>(
    'SELECT readiness, optional_status FROM extraction_recovery_parent ORDER BY id DESC LIMIT 1',
  )!;
  assert.equal(parent.readiness, 'correctness_pending');
  assert.match(parent.optional_status, /pending/);
  db.close();
});

test('applyCoverage rejects missing, wrong-stage, wrong-status and incomplete sealed batches', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-sealed');
  const controller = new RecoveryController(db, { leaseMs: 60_000, heartbeatMs: 60_000, backoffMs: [1] });
  const { childId } = parentChild(controller, project.id, projectChunks(db, project.id).slice(0, 1));
  const fingerprint = stageFingerprint();
  const fencing = setFingerprint(controller, childId, 'entities-facts', fingerprint);
  const attempt = controller.beginAttempt(childId, 'entities-facts', 'owner-a', fencing, fingerprint);
  assert.equal(attempt.ok, true);
  assert.throws(
    () =>
      controller.applyCoverage({
        childId,
        projectId: project.id,
        stage: 'entities-facts',
        fingerprint,
        attemptId: attempt.attemptId!,
        owner: 'owner-a',
        fencing,
        status: 'empty',
        apply: () => {},
      }),
    /sealed-batch-missing/,
  );
  controller.stageBatch({
    attemptId: attempt.attemptId!, childId, projectId: project.id, stage: 'entities-facts', fingerprint,
    payload: { entities: [], facts: [] }, finishReason: 'stop', complete: false,
  });
  assert.throws(
    () => controller.applyCoverage({
      childId, projectId: project.id, stage: 'entities-facts', fingerprint,
      attemptId: attempt.attemptId!, owner: 'owner-a', fencing, status: 'empty', apply: () => {},
    }),
    /sealed-batch-missing/,
  );
  const completeAttempt = controller.beginAttempt(childId, 'entities-facts', 'owner-a', fencing, fingerprint);
  controller.stageBatch({
    attemptId: completeAttempt.attemptId!, childId, projectId: project.id, stage: 'entities-facts', fingerprint,
    payload: { entities: [], facts: [] }, finishReason: 'stop', complete: true,
  });
  assert.throws(
    () => controller.applyCoverage({
      childId, projectId: project.id, stage: 'timeline', fingerprint,
      attemptId: completeAttempt.attemptId!, owner: 'owner-a', fencing, status: 'empty', apply: () => {},
    }),
    /stale-attempt/,
  );
  assert.throws(
    () => controller.applyCoverage({
      childId, projectId: project.id, stage: 'entities-facts', fingerprint,
      attemptId: completeAttempt.attemptId!, owner: 'owner-a', fencing, status: 'complete', apply: () => {},
    }),
    /sealed-batch-status-mismatch/,
  );
  assert.equal(
    controller.applyCoverage({
      childId, projectId: project.id, stage: 'entities-facts', fingerprint,
      attemptId: completeAttempt.attemptId!, owner: 'owner-a', fencing, status: 'empty', apply: () => {},
    }).status,
    'empty',
  );
  db.close();
});

test('a real domain write failure rolls back contribution, effects, coverage and mined state', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-domain-failure');
  db.exec(`
    CREATE TRIGGER block_entity_insert BEFORE INSERT ON canon_entity
    BEGIN SELECT RAISE(ABORT, 'domain entity failure'); END;
  `);
  const llm = finishProvider(splitHandler(), 'stop');
  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery(),
  });
  assert.equal(stats.recovery?.status, 'deferred');
  assert.equal(count(db, 'canon_entity', project.id), 0);
  assert.equal(count(db, 'canon_fact', project.id), 0);
  assert.equal(count(db, 'extraction_contribution', project.id), 0);
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_stage_coverage WHERE status IN ('complete','empty')")?.n,
    0,
  );
  assert.equal(minedCount(db, project.id), 0);
  db.close();
});

test('a dropped unresolved relation is re-evaluated when its dependencies improve', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-dropped-relation', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1, 'Serena Marsh and Kade are friends at the gate.');
  const evidence = 'Serena Marsh and Kade are friends at the gate.';
  const relation = {
    from: 'Serena Marsh',
    to: 'Kade',
    kind: 'friend of',
    description: 'They are friends.',
    chunk_index: 0,
    evidence,
  };
  const serena = { ...SERENA, evidence: 'Serena Marsh' };
  const kade = { ...KADE, evidence: 'Kade' };
  let phase = 0;
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [relation] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: phase === 0 ? [serena] : [serena, kade], facts: [] });
  }, 'stop');
  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8, concurrency: 1, recovery: recovery(),
  });
  assert.equal(first.recovery?.status, 'complete');
  assert.equal(count(db, 'canon_relation', projectId), 0);
  assert.equal(
    db.get<{ disposition: string }>(
      "SELECT disposition FROM extraction_contribution WHERE claim_type = 'relation' ORDER BY id DESC LIMIT 1",
    )?.disposition,
    'dropped',
  );
  phase = 1;
  const second = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1, concurrency: 1, recovery: recovery(),
  });
  assert.equal(second.recovery?.status, 'complete');
  assert.equal(count(db, 'canon_relation', projectId), 1, 'the now-resolvable claim is applied');
  assert.equal(
    db.get<{ disposition: string }>(
      "SELECT disposition FROM extraction_contribution WHERE claim_type = 'relation' ORDER BY id DESC LIMIT 1",
    )?.disposition,
    'applied',
  );
  db.close();
});

test('explicit retry reopens a deferred work unit with a new retry epoch', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-explicit-retry');
  const missing = finishProvider(splitHandler({ entitiesFacts: JSON.stringify({ entities: [SERENA] }) }), 'stop');
  const first = await lorebook.extractLore(db, missing, project.id, {
    windowSize: 8, concurrency: 1, recovery: recovery(),
  });
  assert.equal(first.recovery?.status, 'deferred');
  assert.equal(minedCount(db, project.id), 0);
  const deferredChild = db.get<{ id: number; retry_epoch: number }>(
    'SELECT id, retry_epoch FROM extraction_recovery_child WHERE project_id = ?',
    project.id,
  )!;
  const good = finishProvider(splitHandler({
    entitiesFacts: JSON.stringify({ entities: [SERENA], facts: [] }),
  }), 'stop');
  const second = await lorebook.extractLore(db, good, project.id, {
    windowSize: 8, concurrency: 1, recovery: recovery({ explicitRetry: true }),
  });
  assert.equal(second.recovery?.status, 'complete');
  assert.equal(minedCount(db, project.id), totalChunks(db, project.id));
  const retried = db.get<{ retry_epoch: number }>(
    'SELECT retry_epoch FROM extraction_recovery_child WHERE id = ?',
    deferredChild.id,
  )!;
  assert.ok(retried.retry_epoch > deferredChild.retry_epoch, 'explicit retry advances only the retry epoch');
  db.close();
});

test('relation snapshots store exact prompt names and resolver rows consistently', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-snapshot-exact');
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at)
     VALUES (?, 'character', 'Snapshot A', '["Alias A"]', ?, ?)`,
    project.id,
    now,
    now,
  );
  const controller = new RecoveryController(db);
  const rows = db.all<{ id: number; kind: string; name: string; aliases: string; review_status: string }>(
    "SELECT id, kind, name, aliases, COALESCE(review_status, 'accepted') AS review_status FROM canon_entity WHERE project_id = ? ORDER BY id",
    project.id,
  );
  const first = controller.snapshotRelationStage(project.id, ['Snapshot A'], rows);
  const second = controller.snapshotRelationStage(project.id, ['Snapshot A'], rows);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.promptNames, ['Snapshot A']);
  assert.deepEqual(first.entities.map((entity) => entity.name), rows.map((row) => row.name));
  const stored = controller.relationSnapshot(project.id, first.fingerprint);
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), JSON.parse(JSON.stringify(first)));
  assert.notEqual(
    first.fingerprint,
    controller.snapshotRelationStage(project.id, ['Different Prompt'], rows).fingerprint,
  );
  db.close();
});


test('separate DB connections fence stale workers on staging and finalization', () => {
  const { db, path } = tempDb();
  const project = seedProject(db, 'recovery-cross-connection');
  const ids = projectChunks(db, project.id);
  const a = new RecoveryController(db, { leaseMs: 1000, heartbeatMs: 500, backoffMs: [1] });
  const second = new Db(path);
  const b = new RecoveryController(second, { leaseMs: 1000, heartbeatMs: 500, backoffMs: [1] });
  const { childId } = parentChild(a, project.id, ids.slice(0, 1));
  const fingerprint = stageFingerprint();
  const fencingA = setFingerprint(a, childId, 'entities-facts', fingerprint, 'owner-a');
  const attemptA = a.beginAttempt(childId, 'entities-facts', 'owner-a', fencingA, fingerprint);
  assert.equal(attemptA.ok, true);
  assert.equal(b.claimChild(childId, 'owner-b').reason, 'overlap');
  db.run(
    'UPDATE extraction_chunk_lease SET lease_until = ? WHERE child_id = ?',
    new Date(Date.now() - 60_000).toISOString(),
    childId,
  );
  const fencingB = claim(b, childId, 'owner-b');
  assert.ok(fencingB > fencingA);
  assert.throws(
    () => a.stageBatch({
      attemptId: attemptA.attemptId!, childId, projectId: project.id, stage: 'entities-facts', fingerprint,
      payload: { entities: [], facts: [] }, finishReason: 'stop', complete: true,
    }),
    /not running|stale/,
  );
  assert.throws(() => a.finalizeChild(childId, 'owner-a', fencingA), /stale-fencing/);
  const attemptB = b.beginAttempt(childId, 'entities-facts', 'owner-b', fencingB, fingerprint);
  b.stageBatch({
    attemptId: attemptB.attemptId!, childId, projectId: project.id, stage: 'entities-facts', fingerprint,
    payload: { entities: [], facts: [] }, finishReason: 'stop', complete: true,
  });
  assert.equal(
    b.applyCoverage({
      childId, projectId: project.id, stage: 'entities-facts', fingerprint,
      attemptId: attemptB.attemptId!, owner: 'owner-b', fencing: fencingB, status: 'empty', apply: () => {},
    }).status,
    'empty',
  );
  assert.equal(b.finalizeChild(childId, 'owner-b', fencingB), 'complete');
  db.close();
  second.close();
});


test('same-pair claims with different evidence remain separate contributions', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-distinct-claims', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1, 'Serena Marsh and Kade are friends at the gate. Serena Marsh and Kade were enemies in the war.');
  const serena = { ...SERENA, evidence: 'Serena Marsh and Kade are friends at the gate.' };
  const kade = { ...KADE, evidence: 'Serena Marsh and Kade are friends at the gate.' };
  const relations = [
    { from: 'Serena Marsh', to: 'Kade', kind: 'friend of', description: 'friends', chunk_index: 0, evidence: 'Serena Marsh and Kade are friends at the gate.' },
    { from: 'Serena Marsh', to: 'Kade', kind: 'friend of', description: 'enemies', chunk_index: 0, evidence: 'Serena Marsh and Kade were enemies in the war.' },
  ];
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [serena, kade], facts: [] });
  }, 'stop');
  await lorebook.extractLore(db, llm, projectId, { windowSize: 8, concurrency: 1, recovery: recovery() });
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_contribution WHERE claim_type = 'relation'")?.n,
    2,
  );
  assert.ok(count(db, 'canon_relation', projectId) >= 1);
  db.close();
});


test('staging-only writes no canon, mined flags, provenance, notes or embeddings', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-stage-only-isolation');
  const relation = {
    from: 'Serena Marsh', to: 'Kade', kind: 'friend of', description: 'friends',
    chunk_index: 0, evidence: SERENA_QUOTE,
  };
  let relationSystem = '';
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      relationSystem = system;
      return JSON.stringify({ relations: [relation] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [EVENT] });
    return JSON.stringify({ entities: [SERENA, KADE], facts: [FACT] });
  }, 'stop');
  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
    embed: { baseUrl: 'http://127.0.0.1:1' },
  });
  assert.equal(stats.recovery?.status, 'complete');
  assert.equal(stats.recovery?.readiness, 'staged_only');
  assert.equal(stats.recovery?.optional.embeddings, 'unavailable-staging-only');
  assert.equal(stats.recovery?.optional.publication, 'not_implemented');
  assert.ok(stats.entities > 0 && stats.relations > 0);
  assert.match(relationSystem, /Serena Marsh/);
  assert.match(relationSystem, /Kade/);

  for (const table of ['canon_entity', 'canon_fact', 'canon_relation', 'canon_timeline', 'canon_tie_note', 'canon_tie_hint', 'canon_ruling', 'extraction_run', 'extraction_window_run']) {
    assert.equal(count(db, table, project.id), 0, `${table} must stay untouched`);
  }
  assert.equal(minedCount(db, project.id), 0, 'no mined flags');
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_contribution WHERE disposition = ?', 'staged')?.n,
    5,
    'staged entities, fact, relation and timeline are recorded in staging',
  );
  assert.ok(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_contribution WHERE canon_id IS NOT NULL')?.n === 0,
  );
  assert.ok(
    (db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_staged_batch WHERE complete = 1')?.n ?? 0) >= 3,
  );
  db.close();
});

test('stage-only later-window relation prompt carries verified aliases from earlier staged entities', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-staged-alias-roster', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const chunkIds = addSourceChunks(db, projectId, 2);
  db.run('UPDATE canon_chunk SET text = ? WHERE id = ?',
    'Etta Vale is called Fox by the crew.', chunkIds[0]);
  db.run('UPDATE canon_chunk SET text = ? WHERE id = ?',
    'Niko Renn trusts Fox with the route.', chunkIds[1]);

  const etta = {
    kind: 'character', name: 'Etta Vale', aliases: ['Fox'], summary: 'A scout.',
    attributes: {}, role: 'scout', status: '', chunk_index: 0,
    evidence: 'Etta Vale is called Fox by the crew.',
  };
  const niko = {
    kind: 'character', name: 'Niko Renn', aliases: [], summary: 'A route-truster.',
    attributes: {}, role: '', status: '', chunk_index: 0,
    evidence: 'Niko Renn trusts Fox with the route.',
  };
  const relation = {
    from: 'Niko Renn', to: 'Fox', kind: 'trusted', description: 'trusts with the route',
    chunk_index: 0, evidence: 'Niko Renn trusts Fox with the route.',
  };
  let laterRelationPrompt = '';
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    const user = req.messages.map((message) => message.content).join('\n');
    if (system.includes('KNOWN ENTITIES')) {
      if (user.includes('Niko Renn')) laterRelationPrompt = system;
      return JSON.stringify({ relations: user.includes('Niko Renn') ? [relation] : [] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    if (user.includes('Niko Renn')) return JSON.stringify({ entities: [niko], facts: [] });
    return JSON.stringify({ entities: [etta], facts: [] });
  }, 'stop');

  const result = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });

  assert.equal(result.recovery?.completeChildren, 2, 'both synthetic windows should finish their stages');
  assert.match(laterRelationPrompt, /Etta Vale \(also known as: Fox\)/);
  assert.match(laterRelationPrompt, /alternate names for the entity on that line, not separate entities/);
  assert.match(laterRelationPrompt, /use the listed canonical entity name/);
  assert.equal(count(db, 'canon_entity', projectId), 0, 'stage-only must not write canon entities');
  assert.equal(count(db, 'canon_relation', projectId), 0, 'stage-only must not write canon relations');
  assert.equal(minedCount(db, projectId), 0, 'stage-only must not mark chunks mined');
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_contribution WHERE claim_type = 'relation' AND disposition = 'staged'")?.n,
    1,
    'the later-window alias relation should be retained in staging',
  );
  db.close();
});

test('staging-only no-name relation coverage is reused without calls or deferral', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-stage-only-no-name', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1, 'the rain fell on the bridge for three days.');
  const project = { id: projectId };
  let calls = 0;
  const llm = finishProvider((req) => {
    calls++;
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const first = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8, concurrency: 1, recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.recovery?.status, 'complete');
  const firstCalls = calls;
  assert.equal(firstCalls, 2, 'entities-facts and timeline only');
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_stage_coverage WHERE stage = 'relations' AND status = 'not_applicable'")?.n,
    1,
  );
  const second = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8, concurrency: 1, recovery: recovery({ stageOnly: true }),
  });
  assert.equal(second.recovery?.status, 'complete');
  assert.equal(calls, firstCalls, 'unchanged no-name work reuses not_applicable coverage');
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_attempt WHERE stage = 'relations'")?.n,
    1,
  );
  db.close();
});

test('staging-only repeated regrouping keeps exact candidates idempotent and no canon', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-stage-only-regroup', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1);
  const entity = { ...SERENA, aliases: ['Serena'], summary: 'The watcher.' };
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [entity], facts: [] });
  }, 'stop');
  await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8, concurrency: 1, recovery: recovery({ stageOnly: true }),
  });
  const firstContributions = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_contribution')?.n;
  assert.equal(firstContributions, 1);
  db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE project_id = ?', projectId);
  await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1, concurrency: 1, recovery: recovery({ stageOnly: true }),
  });
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_contribution')?.n,
    firstContributions,
    'same source/claim contributes once across regrouping',
  );
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(
    db.get<{ lore_mined: number }>('SELECT lore_mined FROM canon_chunk WHERE project_id = ? LIMIT 1', projectId)?.lore_mined,
    1,
    'existing mined flag is not changed by staging-only',
  );
  db.close();
});

test('staging-only lazy retrieval does not start hidden model work', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-stage-only-lazy');
  let calls = 0;
  const llm = finishProvider(() => { calls++; return JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] }); }, 'stop');
  (llm.settings as { provider: 'ollama' }).provider = 'ollama';
  const ids = projectChunks(db, project.id);
  const result = await lorebook.mineUnminedHits(db, llm, project.id, ids);
  assert.equal(result, undefined);
  assert.equal(calls, 0);
  assert.equal(count(db, 'canon_entity', project.id), 0);
  db.close();
});

test('staging-only trace requests do not create provenance or trace rows', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-stage-only-trace');
  const llm = finishProvider(splitHandler(), 'stop');
  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
    trace: { enabled: true },
  });
  assert.equal(stats.recovery?.readiness, 'staged_only');
  assert.equal(stats.traceId, undefined, 'staging-only does not claim trace provenance');
  assert.equal(count(db, 'trace', project.id), 0);
  assert.equal(count(db, 'trace_event', project.id), 0);
  assert.equal(count(db, 'extraction_run', project.id), 0);
  db.close();
});

test('bounded staging runs skip completed work and keep making progress', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-stage-only-budget', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 6);
  let calls = 0;
  const llm = finishProvider(() => {
    calls++;
    return JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] });
  }, 'stop');
  const run = (extra: Record<string, unknown> = {}) => lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    maxWindows: 2,
    recovery: recovery({ stageOnly: true, ...extra }),
  });

  const first = await run();
  assert.equal(first.windows, 2);
  assert.equal(first.recoverySkippedComplete, 0);
  assert.equal(first.recovery?.status, 'complete');
  assert.equal(calls, 4, 'two windows, entities-facts and timeline; no names means no relation call');

  const second = await run();
  assert.equal(second.windows, 2);
  assert.equal(second.recoverySkippedComplete, 2, 'completed windows do not consume the budget again');
  assert.equal(second.recovery?.status, 'complete');
  assert.equal(calls, 8);

  const third = await run();
  assert.equal(third.windows, 2);
  assert.equal(third.recoverySkippedComplete, 4);
  assert.equal(third.recovery?.status, 'complete');
  assert.equal(calls, 12);

  const fourth = await run();
  assert.equal(fourth.windows, 0);
  assert.equal(fourth.recoveryNoEligibleWork, true);
  assert.equal(fourth.recoverySkippedComplete, 6);
  assert.equal(fourth.stageOnly, true);
  assert.equal(calls, 12, 'no provider calls for already-complete work');
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_child WHERE project_id = ?', projectId)?.n,
    6,
    'stable work identity creates one child per window',
  );
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(count(db, 'extraction_run', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('deferred staging work is visible, skipped automatically and retried only explicitly', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-stage-only-deferral', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 4);
  let calls = 0;
  let broken = true;
  const llm = finishProvider((req) => {
    calls++;
    const system = req.system ?? '';
    if (broken && !system.includes('KNOWN ENTITIES') && !system.includes('"timeline"')) {
      return 'not json';
    }
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const run = (extra: Record<string, unknown> = {}) => lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true, ...extra }),
  });

  const deferred = await run();
  assert.equal(deferred.windows, 1);
  assert.equal(deferred.recovery?.status, 'deferred');
  assert.equal(deferred.recovery?.deferredChildren, 1);
  assert.equal(calls, 3, 'three total bounded attempts, then visible deferral');
  const deferredChild = db.get<{ status: string }>(
    'SELECT status FROM extraction_recovery_child WHERE project_id = ?',
    projectId,
  );
  assert.equal(deferredChild?.status, 'deferred');

  broken = false;
  const second = await run();
  assert.equal(second.windows, 1);
  assert.equal(second.recoverySkippedDeferred, 1);
  assert.equal(second.recovery?.status, 'complete');
  assert.equal(calls, 5);

  const third = await run();
  assert.equal(third.windows, 1);
  assert.equal(third.recoverySkippedDeferred, 1);
  assert.equal(third.recoverySkippedComplete, 1);
  assert.equal(calls, 7);

  const fourth = await run();
  assert.equal(fourth.windows, 1);
  assert.equal(fourth.recoverySkippedDeferred, 1);
  assert.equal(fourth.recoverySkippedComplete, 2);
  assert.equal(calls, 9);

  const exhausted = await run();
  assert.equal(exhausted.windows, 0);
  assert.equal(exhausted.recoveryNoEligibleWork, true);
  assert.equal(exhausted.recoverySkippedDeferred, 1);
  assert.equal(exhausted.recoverySkippedComplete, 3);
  assert.equal(calls, 9, 'deferred work is never retried automatically');

  const retried = await run({ explicitRetry: true });
  assert.equal(retried.windows, 1);
  assert.equal(retried.recoverySkippedComplete, 3);
  assert.equal(retried.recovery?.status, 'complete');
  assert.equal(calls, 11, 'explicit retry runs the deferred window once');
  assert.equal(
    db.get<{ status: string; retry_epoch: number }>(
      'SELECT status, retry_epoch FROM extraction_recovery_child WHERE project_id = ? AND status = ?',
      projectId,
      'complete',
    )?.retry_epoch,
    1,
  );
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(count(db, 'extraction_run', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('a crashed staging relation batch replays without a provider or a live canon resolver', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-staging-relation-replay', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(
    db,
    projectId,
    1,
    'Serena Marsh watched it from the ridge. "Wait," said Kade behind her. The rain had not stopped for three days.',
  );
  const relation = {
    from: 'Serena Marsh',
    to: 'Kade',
    kind: 'friend of',
    description: 'They wait together.',
    chunk_index: 0,
    evidence: KADE_QUOTE,
  };
  let relationCalls = 0;
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      relationCalls++;
      return JSON.stringify({ relations: [relation] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [SERENA, KADE], facts: [FACT] });
  }, 'stop');
  // Crash after the relation batch is sealed but before coverage commits.
  db.exec(`
    CREATE TRIGGER crash_relation_coverage
    BEFORE INSERT ON extraction_stage_coverage
    WHEN NEW.stage = 'relations' AND NEW.status <> 'deferred'
    BEGIN SELECT RAISE(ABORT, 'relation-coverage-crash'); END;
  `);
  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.recovery?.status, 'deferred');
  assert.equal(relationCalls, 3, 'three bounded attempts staged a sealed batch but could not commit coverage');
  db.exec('DROP TRIGGER crash_relation_coverage');
  const sealed = db.all<{ id: number; fingerprint: string }>(
    "SELECT id, fingerprint FROM extraction_staged_batch WHERE stage = 'relations' AND complete = 1",
  );
  assert.equal(sealed.length, 1, 'one sealed relation batch survived the crash');
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_stage_coverage WHERE stage = 'relations' AND status IN ('complete','empty','not_applicable')",
    )?.n,
    0,
    'no relation coverage committed before the crash',
  );

  let replayRelationCalls = 0;
  let replayOtherCalls = 0;
  const replay = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      replayRelationCalls++;
      throw new Error('sealed relation replay must not call the provider');
    }
    replayOtherCalls++;
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [SERENA, KADE], facts: [FACT] });
  }, 'stop');
  const second = await lorebook.extractLore(db, replay, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true, explicitRetry: true }),
  });
  assert.equal(second.recovery?.status, 'complete');
  assert.equal(replayRelationCalls, 0, 'the sealed relation batch replays without a provider');
  assert.equal(replayOtherCalls, 1, 'only the previously uncovered timeline stage calls the provider');
  const stagedRelation = db.get<{ disposition: string; payload_sha256: string }>(
    "SELECT disposition, payload_sha256 FROM extraction_contribution WHERE stage = 'relations' ORDER BY id DESC LIMIT 1",
  );
  assert.equal(stagedRelation?.disposition, 'staged');
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_staged_batch WHERE stage = 'relations' AND complete = 1",
    )?.n,
    1,
    'replay reuses the sealed batch instead of staging another',
  );
  assert.equal(count(db, 'canon_entity', projectId), 0, 'no canon entity was created for resolution');
  assert.equal(count(db, 'canon_relation', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('a changed canon roster prevents stale staging relation replay and replans with the live snapshot', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-staging-relation-roster-change', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(
    db,
    projectId,
    1,
    'Serena Marsh watched it from the ridge. "Wait," said Kade behind her. The rain had not stopped for three days.',
  );
  const relation = {
    from: 'Serena Marsh',
    to: 'Kade',
    kind: 'friend of',
    description: 'Stale relation.',
    chunk_index: 0,
    evidence: KADE_QUOTE,
  };
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [relation] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [SERENA, KADE], facts: [FACT] });
  }, 'stop');
  db.exec(`
    CREATE TRIGGER crash_relation_coverage
    BEFORE INSERT ON extraction_stage_coverage
    WHEN NEW.stage = 'relations' AND NEW.status <> 'deferred'
    BEGIN SELECT RAISE(ABORT, 'relation-coverage-crash'); END;
  `);
  await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  db.exec('DROP TRIGGER crash_relation_coverage');
  const oldBatch = db.get<{ fingerprint: string }>(
    "SELECT fingerprint FROM extraction_staged_batch WHERE stage = 'relations' ORDER BY id DESC LIMIT 1",
  )!;
  db.run(
    `INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at)
     VALUES (?, 'character', 'Live Only', '[]', ?, ?)`,
    projectId,
    now,
    now,
  );

  let relationCalls = 0;
  const fresh = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      relationCalls++;
      return JSON.stringify({
        relations: [{ ...relation, description: 'Fresh relation.' }],
      });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [SERENA, KADE], facts: [FACT] });
  }, 'stop');
  const second = await lorebook.extractLore(db, fresh, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true, explicitRetry: true }),
  });
  assert.equal(second.recovery?.status, 'complete');
  assert.equal(relationCalls, 1, 'the changed roster gets a fresh relation call');
  const newBatch = db.get<{ fingerprint: string; payload_json: string }>(
    "SELECT fingerprint, payload_json FROM extraction_staged_batch WHERE stage = 'relations' ORDER BY id DESC LIMIT 1",
  )!;
  assert.notEqual(newBatch.fingerprint, oldBatch.fingerprint);
  assert.match(newBatch.payload_json, /Fresh relation/);
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_contribution WHERE stage = 'relations' AND disposition = 'staged'",
    )?.n,
    1,
    'only the fresh snapshot is applied; the stale sealed batch is left untouched',
  );
  assert.equal(count(db, 'canon_relation', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('relation prompting sees only verified current staged entities, never invalid citations or superseded batches', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-staged-roster-verified', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(
    db,
    projectId,
    1,
    'serena marsh watched it from the ridge. phantom name was here. old ghost waited.',
  );
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'serena marsh watched it from the ridge',
  };
  const phantom = {
    ...serena,
    name: 'Phantom Name',
    evidence: 'this sentence is not in the passage at all',
  };
  let relationCalls = 0;
  let relationSystem = '';
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      relationCalls++;
      relationSystem = system;
      return JSON.stringify({ relations: [] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [serena, phantom], facts: [] });
  }, 'stop');

  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.recovery?.status, 'complete');
  assert.equal(relationCalls, 1, 'staged entities make an otherwise empty canon roster promptable');
  assert.match(relationSystem, /Serena Marsh/);
  assert.doesNotMatch(relationSystem, /Phantom Name/, 'an unverified citation never joins the roster');
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_contribution WHERE claim_type = 'entity' AND disposition = 'staged'",
    )?.n,
    1,
    'only the verified entity has a staged contribution',
  );
  const relationStatus = db.get<{ status: string }>(
    "SELECT status FROM extraction_stage_coverage WHERE stage = 'relations' ORDER BY id DESC LIMIT 1",
  )?.status;
  assert.equal(relationStatus, 'empty', 'the relation stage ran instead of declaring no names');

  const applied = db.get<{ attempt_id: number; child_id: number; project_id: number }>(
    `SELECT b.attempt_id, b.child_id, b.project_id
       FROM extraction_stage_coverage cov
       JOIN extraction_staged_batch b
         ON b.attempt_id = cov.attempt_id AND b.child_id = cov.child_id
        AND b.stage = cov.stage AND b.fingerprint = cov.fingerprint
      WHERE cov.stage = 'entities-facts' AND cov.status IN ('complete', 'empty')
      ORDER BY b.id DESC LIMIT 1`,
  )!;
  const oldPayload = JSON.stringify({
    entities: [{
      ...serena,
      name: 'Old Ghost',
      evidence: 'old ghost waited',
    }],
    facts: [],
  });
  db.run(
    `INSERT INTO extraction_staged_batch
       (attempt_id, child_id, project_id, stage, fingerprint, payload_json,
        payload_sha256, byte_size, complete, finish_reason, created_at)
     VALUES (?, ?, ?, 'entities-facts', 'old-generation-fingerprint', ?, 'old-hash', ?, 1, 'stop', ?)`,
    applied.attempt_id,
    applied.child_id,
    applied.project_id,
    oldPayload,
    Buffer.byteLength(oldPayload),
    now,
  );
  // Force a new relationship fingerprint; the entities-facts generation stays
  // the current one, so only its verified contribution may be used.
  db.run(
    `INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at)
     VALUES (?, 'character', 'Roster Anchor', '[]', ?, ?)`,
    projectId,
    now,
    now,
  );
  const second = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(second.recovery?.status, 'complete');
  assert.equal(relationCalls, 2, 'the changed relationship fingerprint replans');
  assert.match(relationSystem, /Serena Marsh/);
  assert.doesNotMatch(relationSystem, /Old Ghost/, 'a superseded entities-facts batch is ignored');
  assert.doesNotMatch(relationSystem, /Phantom Name/);
  assert.equal(count(db, 'canon_entity', projectId), 1, 'only the synthetic roster anchor is canon');
  assert.equal(count(db, 'canon_relation', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('stage-only work is not authoritative published coverage after legacy mining', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-stage-only-vs-legacy', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 2);
  let calls = 0;
  const llm = finishProvider((req) => {
    calls++;
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const stagedRun = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(stagedRun.recovery?.status, 'complete');
  assert.equal(recoveryPublishedChunkIds(db, projectId).size, 0, 'staging is not published coverage');
  const afterStageCalls = calls;
  db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE project_id = ?', projectId);

  const blocked = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(blocked.legacyBlockedWindows, 2);
  assert.equal(blocked.windows, 0);
  assert.equal(calls, afterStageCalls, 'legacy mined passages are not sent to the provider');
  assert.equal(minedCount(db, projectId), 2);

  const freshStage = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    fresh: true,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(freshStage.legacyBlockedWindows, 2);
  assert.equal(minedCount(db, projectId), 2, 'stage-only fresh never resets legacy flags');

  const freshPublish = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    fresh: true,
    recovery: recovery({ stageOnly: false }),
  });
  assert.equal(freshPublish.legacyBlockedWindows, 2);
  assert.equal(minedCount(db, projectId), 2, 'published-fresh resets only authoritative coverage');
  assert.equal(calls, afterStageCalls);
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(count(db, 'extraction_run', projectId), 0);
  assert.equal(
    db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM extraction_recovery_chunk_work WHERE project_id = ?',
      projectId,
    )?.n,
    2,
    'staged work remains recorded, just not authoritative',
  );
  db.close();
});

test('long passages are split into exhaustive fragment units instead of a prefix-only read', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-fragment-coverage', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1, `${'x'.repeat(1500)} Serena Marsh watched it from the ridge.`);
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const stats = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(stats.fragmentMode, true);
  assert.equal(stats.truncatedPassages, 0);
  assert.equal(stats.coverageNonExhaustive, false);
  assert.equal(stats.promptPassageChars, lorebook.PROMPT_PASSAGE_CHARS);
  assert.equal(stats.fragmentCoverage?.plannedFragments, 2);
  assert.equal(stats.fragmentCoverage?.completeFragments, 2);
  assert.equal(stats.fragmentCoverage?.status, 'complete');
  assert.equal(stats.fragmentCoverage?.completeSourceChunks, 1);
  assert.equal(stats.fragmentCoverage?.partialSourceChunks, 0);
  assert.equal(stats.recovery?.readiness, 'staged_only');
  const coverage = stats.recovery?.optional.coverage as {
    status: string;
    plannedFragments: number;
    completeFragments: number;
  };
  assert.equal(coverage.status, 'complete');
  assert.equal(coverage.plannedFragments, 2);
  assert.equal(coverage.completeFragments, 2);
  const parent = db.get<{ optional_status: string }>(
    'SELECT optional_status FROM extraction_recovery_parent ORDER BY id DESC LIMIT 1',
  )!;
  assert.match(parent.optional_status, /"status":"complete"/);
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('an empty source returns a truthful empty staging result, and the CLI never claims extraction success', async () => {
  const { db, path } = tempDb();
  const now = new Date().toISOString();
  const projectName = 'recovery-empty-source';
  db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES (?, ?, ?)`,
    projectName,
    now,
    now,
  );
  const llm = finishProvider(splitHandler(), 'stop');
  const projectId = db.get<{ id: number }>(
    'SELECT id FROM project WHERE name = ?',
    projectName,
  )!.id;
  const stats = await lorebook.extractLore(db, llm, projectId, {
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(stats.emptySource, true);
  assert.equal(stats.stageOnly, true);
  assert.equal(stats.windows, 0);
  assert.equal(stats.entities, 0);
  assert.equal(stats.recovery, undefined);
  assert.equal(count(db, 'canon_entity', projectId), 0);

  db.run(
    `INSERT INTO extraction_contribution
       (project_id, child_id, stage, contribution_uid, claim_type, payload_sha256,
        dependency_fingerprint, evaluation_count, disposition, applied_at)
     VALUES (?, 1, 'entities-facts', 'legacy-empty-source-uid', 'entity', 'legacy-hash', '', 0, 'staged', ?)`,
    projectId,
    now,
  );

  const cli = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
  const out = spawnSync(
    process.execPath,
    ['--no-warnings', cli, '--db', path, '--project', projectName, 'lore', 'extract'],
    { encoding: 'utf8' },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /nothing to (extract|stage): no imported passages/);
  assert.match(out.stdout, /pre-namespace staged contribution/);
  assert.doesNotMatch(out.stdout, /extracted 0 entities/);

  const ui = readFileSync(resolve(import.meta.dirname, '../../fanfable/src/ui/app.js'), 'utf8');
  assert.match(ui, /res\.emptySource/);
  assert.match(ui, /coverage is not exhaustive/);
  db.close();
});

test('CLI --trace fails fast without --legacy and help states the canon boundary', () => {
  const { db, path } = tempDb();
  seedProject(db, 'recovery-cli-trace-scope');
  db.close();
  const cli = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
  const help = spawnSync(process.execPath, ['--no-warnings', cli, '--help'], {
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--trace requires --legacy/);
  assert.match(help.stdout, /stage-only extraction does not write traces/);
  assert.match(help.stdout, /only on a disposable database/);
  for (const heading of ['CONFLICTS', 'GRAPH']) {
    assert.equal(
      // ANSI color codes sit directly before the heading text, so a word
      // boundary would fail against the trailing 'm' of the escape sequence.
      (help.stdout.match(new RegExp(heading, 'g')) ?? []).length,
      1,
      `help should print the ${heading} section once`,
    );
  }

  const out = spawnSync(
    process.execPath,
    [
      '--no-warnings',
      cli,
      '--db',
      path,
      '--project',
      'recovery-cli-trace-scope',
      'lore',
      'extract',
      '--trace',
    ],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(out.status, 1);
  assert.match(out.stderr, /--trace requires --legacy/);
  assert.match(out.stderr, /stage-only extraction does not write traces/);
  assert.match(out.stderr, /only on a disposable database/);
  assert.doesNotMatch(out.stdout, /Extracting book lore/);

  const reopened = new Db(path);
  assert.equal(reopened.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_run')?.n, 0);
  assert.equal(
    reopened.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_parent')?.n,
    0,
  );
  assert.equal(reopened.get<{ n: number }>('SELECT COUNT(*) AS n FROM trace')?.n, 0);
  reopened.close();
});

test('a changed extraction config does not reuse an earlier generation staged roster', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-cross-generation-roster', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(
    db,
    projectId,
    1,
    'serena marsh watched it from the ridge. rain fell all day.',
  );
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'serena marsh watched it from the ridge',
  };
  let relationCalls = 0;
  let relationSystem = '';
  const relationSystems: string[] = [];
  let emitSerena = true;
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      relationCalls++;
      relationSystem = system;
      relationSystems.push(system);
      return JSON.stringify({ relations: [] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: emitSerena ? [serena] : [], facts: [] });
  }, 'stop');

  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.recovery?.status, 'complete');
  assert.equal(relationCalls, 1);
  assert.match(relationSystem, /Serena Marsh/);
  const stagedBefore = db.get<{ contribution_uid: string; disposition: string }>(
    "SELECT contribution_uid, disposition FROM extraction_contribution WHERE claim_type = 'entity'",
  )!;
  assert.equal(stagedBefore.disposition, 'staged');
  assert.match(stagedBefore.contribution_uid, /^staged:/);

  // windowSize is part of the stage config hash. The changed config is a new
  // generation, so the second run must not inherit the earlier staged roster.
  emitSerena = false;
  const second = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(second.recovery?.status, 'complete');
  assert.equal(
    relationCalls,
    1,
    'the changed config never prompts relations with the earlier generation staged entity',
  );
  assert.equal(relationSystems.length, 1);
  assert.match(relationSystems[0]!, /Serena Marsh/);
  const secondCoverage = db.get<{ result_json: string }>(
    "SELECT result_json FROM extraction_stage_coverage WHERE stage = 'entities-facts' ORDER BY id DESC LIMIT 1",
  )!;
  assert.match(
    secondCoverage.result_json,
    /"stagedEntityUids":\[\]/,
    'the new generation stages no entity of its own',
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_contribution')?.n,
    1,
    'the earlier staged claim is preserved without being reused by the new generation',
  );
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(count(db, 'canon_relation', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('staged claims live in a private namespace and cannot block a later publication effect', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-staged-namespace');
  const controller = new RecoveryController(db, tinyPolicy());
  const { childId } = parentChild(controller, project.id, projectChunks(db, project.id).slice(0, 1));
  const payload = { name: 'Serena Marsh', evidence: SERENA_QUOTE };
  const domainUid = recoveryContributionUid({
    claimType: 'entity',
    sourceChunkId: projectChunks(db, project.id)[0]!,
    payload,
  });
  const staged = controller.recordContribution({
    projectId: project.id,
    childId,
    stage: 'entities-facts',
    claimType: 'entity',
    uid: stagedRecoveryContributionUid(domainUid),
    payload,
    dependencyFingerprint: 'stage-generation',
    disposition: 'staged',
  });
  assert.equal(staged.inserted, true);
  controller.finalizeContribution(staged.id!, { disposition: 'staged' });
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_effect')?.n,
    0,
    'staging writes no domain effect',
  );
  assert.equal(
    db.get<{ canon_table: string; canon_id: number | null }>(
      'SELECT canon_table, canon_id FROM extraction_contribution WHERE id = ?',
      staged.id,
    )?.canon_table,
    '',
  );

  const publication = controller.recordContribution({
    projectId: project.id,
    childId,
    stage: 'entities-facts',
    claimType: 'entity',
    uid: domainUid,
    payload,
    dependencyFingerprint: 'publication-generation',
    disposition: 'applying',
  });
  assert.equal(publication.inserted, true, 'the private staged namespace leaves the domain UID free');
  assert.notEqual(publication.id, staged.id);
  controller.finalizeContribution(publication.id!, {
    disposition: 'applied',
    canonTable: 'canon_entity',
    canonId: 999,
  });
  controller.recordEffect({
    contributionId: publication.id!,
    effectType: 'claim',
    effectKey: domainUid,
    canonTable: 'canon_entity',
    canonId: 999,
  });
  assert.equal(
    db.get<{ disposition: string }>('SELECT disposition FROM extraction_contribution WHERE id = ?', staged.id)?.disposition,
    'staged',
    'publication does not mutate the staging row',
  );
  assert.equal(
    db.get<{ disposition: string }>('SELECT disposition FROM extraction_contribution WHERE id = ?', publication.id)?.disposition,
    'applied',
  );
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_effect')?.n, 1);
  db.close();
});

test('a crash after a sealed no-name relation batch replays without a new attempt', async () => {
  const { db, path } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-no-name-crash', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1, 'the quiet bridge stood empty in the rain.');
  let relationCalls = 0;
  const failProvider = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      relationCalls++;
      throw new Error('no-name replay must not call the provider');
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  db.exec(`
    CREATE TRIGGER crash_no_name_coverage
    BEFORE INSERT ON extraction_stage_coverage
    WHEN NEW.stage = 'relations' AND NEW.status IN ('not_applicable', 'deferred')
    BEGIN SELECT RAISE(ABORT, 'no-name-coverage-crash'); END;
  `);
  const crashed = await lorebook.extractLore(db, failProvider, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(crashed.recovery?.status, 'failed');
  assert.equal(crashed.windows, 1);
  assert.equal(relationCalls, 0);
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_attempt WHERE stage = 'relations'",
    )?.n,
    1,
    'the crash left the single sealed attempt',
  );
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_staged_batch WHERE stage = 'relations' AND complete = 1",
    )?.n,
    1,
  );
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_stage_coverage WHERE stage = 'relations' AND status = 'not_applicable'",
    )?.n,
    0,
  );
  db.exec('DROP TRIGGER crash_no_name_coverage');
  db.close();

  const reopened = new Db(path);
  let replayRelationCalls = 0;
  let replayTimelineCalls = 0;
  const replayProvider = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      replayRelationCalls++;
      throw new Error('sealed no-name replay must not call the provider');
    }
    replayTimelineCalls++;
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const replay = await lorebook.extractLore(reopened, replayProvider, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(replay.recovery?.status, 'complete');
  assert.equal(replayRelationCalls, 0);
  assert.equal(replayTimelineCalls, 1, 'only the uncovered timeline stage calls the provider');
  assert.equal(
    reopened.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_attempt WHERE stage = 'relations'",
    )?.n,
    1,
    'replay reuses the sealed attempt instead of consuming another',
  );
  assert.equal(
    reopened.get<{ status: string }>(
      "SELECT status FROM extraction_stage_coverage WHERE stage = 'relations' ORDER BY id DESC LIMIT 1",
    )?.status,
    'not_applicable',
  );

  const beforeRepeatCalls = replayTimelineCalls;
  const repeat = await lorebook.extractLore(reopened, replayProvider, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(repeat.recovery?.status, 'complete');
  assert.equal(replayRelationCalls, 0);
  assert.equal(replayTimelineCalls, beforeRepeatCalls, 'a complete repeated run performs no calls');
  assert.equal(
    reopened.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_attempt WHERE stage = 'relations'",
    )?.n,
    1,
  );
  assert.equal(count(reopened, 'canon_entity', projectId), 0);
  assert.equal(minedCount(reopened, projectId), 0);
  reopened.close();
});

test('budgeted fragment reuse preserves full coverage and source changes invalidate prior fragments', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-fragment-reuse', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const longText = `${'x'.repeat(1500)} tail text.`;
  addSourceChunks(db, projectId, 2, longText);
  let calls = 0;
  const llm = finishProvider((req) => {
    calls++;
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.fragmentCoverage?.plannedFragments, 4);
  assert.equal(first.fragmentCoverage?.completeFragments, 4);
  assert.equal(first.fragmentCoverage?.status, 'complete');
  const afterFirstCalls = calls;

  const reused = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(reused.recoveryNoEligibleWork, true);
  assert.equal(reused.windows, 0);
  assert.equal(reused.recoverySkippedComplete, 4);
  assert.equal(reused.fragmentCoverage?.plannedFragments, 4);
  assert.equal(reused.fragmentCoverage?.completeFragments, 4);
  assert.equal(reused.fragmentCoverage?.status, 'complete');
  assert.equal(calls, afterFirstCalls, 'complete fragments make no new calls');

  db.run('UPDATE canon_chunk SET text = ? WHERE project_id = ?', `${'y'.repeat(1500)} changed tail.`, projectId);
  const changed = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(changed.recoverySkippedComplete, 0, 'the old generation is not reused after a source change');
  assert.equal(changed.fragmentCoverage?.plannedFragments, 4);
  assert.equal(changed.fragmentCoverage?.completeFragments, 1);
  assert.equal(changed.fragmentCoverage?.status, 'partial');
  assert.equal(changed.fragmentCoverage?.partialSourceChunks, 1);
  assert.ok(calls > afterFirstCalls);
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);

  const ui = readFileSync(resolve(import.meta.dirname, '../../fanfable/src/ui/app.js'), 'utf8');
  assert.match(ui, /fragmentCoverage/);
  assert.match(ui, /Source coverage/);
  assert.match(ui, /windowIssues/);
  assert.match(ui, /deferredChildren/);
  assert.match(ui, /recoveryRelationStale/);
  assert.match(ui, /Staging incomplete/);
  const cli = readFileSync(resolve(import.meta.dirname, '../../fanfable/src/cli.ts'), 'utf8');
  assert.match(cli, /fragmentCoverage/);
  assert.match(cli, /source coverage:/);
  assert.match(cli, /fragments complete/);
  db.close();
});

test('a bounded later window sees verified staged entities from earlier completed windows', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-bounded-roster', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const ids = addSourceChunks(
    db,
    projectId,
    1,
    'Serena Marsh watched it from the ridge. "Wait," said Kade behind her. They were friends at the gate.',
  );
  const sourceId = db.get<{ source_id: number }>(
    'SELECT source_id FROM canon_chunk WHERE id = ?',
    ids[0],
  )!.source_id;
  ids.push(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, text)
       VALUES (?, ?, 1, 'p. 2', ?)`,
      sourceId,
      projectId,
      'serena marsh waited alone. the rain fell.',
    ).lastInsertRowid,
  );
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'Serena Marsh watched it from the ridge',
  };
  let relationCalls = 0;
  let relationSystem = '';
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      relationCalls++;
      relationSystem = system;
      return JSON.stringify({ relations: [] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    const passage = req.messages[0]?.content ?? '';
    return JSON.stringify({ entities: passage.includes('ridge') ? [serena] : [], facts: [] });
  }, 'stop');

  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.windows, 1);
  assert.equal(relationCalls, 1);
  const firstChild = db.get<{ chunk_ids: string }>(
    'SELECT chunk_ids FROM extraction_recovery_child ORDER BY id LIMIT 1',
  )!;
  assert.deepEqual(JSON.parse(firstChild.chunk_ids), [ids[0]]);

  const second = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(second.windows, 1);
  assert.equal(second.recoverySkippedComplete, 1);
  assert.equal(relationCalls, 2, 'the later bounded window prompts with the earlier verified entity');
  assert.match(relationSystem, /Serena Marsh/);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_child')?.n,
    2,
  );
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(count(db, 'canon_relation', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('a changed roster schedules stale no-name relationship coverage once and then stabilises', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-stale-no-name', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1, 'the quiet bridge stood empty in the rain.');
  let calls = 0;
  const llm = finishProvider((req) => {
    calls++;
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.recovery?.status, 'complete');
  const firstCalls = calls;
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_attempt WHERE stage = 'relations'",
    )?.n,
    1,
  );
  db.run(
    `INSERT INTO canon_entity (project_id, kind, name, aliases, created_at, updated_at)
     VALUES (?, 'character', 'Roster Shift', '[]', ?, ?)`,
    projectId,
    now,
    now,
  );

  const revalidated = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(revalidated.windows, 1);
  assert.equal(revalidated.recoveryRosterStale, 1);
  assert.equal(revalidated.recoverySkippedComplete, 0);
  assert.equal(calls, firstCalls, 'no-name revalidation needs no model call');
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_attempt WHERE stage = 'relations'",
    )?.n,
    2,
    'the stale not_applicable fingerprint gets one fresh attempt',
  );

  const stable = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(stable.recoveryNoEligibleWork, true);
  assert.equal(stable.recoveryRosterStale, 0);
  assert.equal(stable.recoverySkippedComplete, 1);
  assert.equal(calls, firstCalls);
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_attempt WHERE stage = 'relations'",
    )?.n,
    2,
    'a stable roster does not reopen the window again',
  );
  assert.equal(count(db, 'canon_entity', projectId), 1, 'only the synthetic roster anchor is canon');
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('source changes keep earlier staged entities out of a later bounded roster', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-roster-source-isolation', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(
    db,
    projectId,
    1,
    'Serena Marsh watched it from the ridge. "Wait," said Kade behind her.',
  );
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'Serena Marsh watched it from the ridge',
  };
  let relationCalls = 0;
  let relationSystem = '';
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      relationCalls++;
      relationSystem = system;
      return JSON.stringify({ relations: [] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    const passage = req.messages[0]?.content ?? '';
    return JSON.stringify({ entities: passage.includes('ridge') ? [serena] : [], facts: [] });
  }, 'stop');
  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.recovery?.status, 'complete');
  const firstCalls = relationCalls;
  assert.equal(firstCalls, 1);

  relationSystem = '';
  db.run(
    'UPDATE canon_chunk SET text = ? WHERE project_id = ?',
    'serena marsh waited alone. the rain fell.',
    projectId,
  );
  const second = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(second.windows, 1);
  assert.equal(second.recoverySkippedComplete, 0, 'the source-changed generation is not reused');
  assert.equal(relationCalls, firstCalls, 'the old staged entity never enters the new generation roster');
  assert.doesNotMatch(relationSystem, /Serena Marsh/);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_recovery_child')?.n,
    2,
  );
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('pre-namespace staged rows are detected, never reused, and never handed to non-stage callers', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-legacy-staged-detect');
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO extraction_contribution
       (project_id, child_id, stage, contribution_uid, claim_type, payload_sha256,
        dependency_fingerprint, evaluation_count, disposition, applied_at)
     VALUES (?, 1, 'entities-facts', 'legacy-staged-uid', 'entity', 'legacy-hash', '', 0, 'staged', ?)`,
    project.id,
    now,
  );
  const status = legacyStagedContributionStatus(db, project.id);
  assert.equal(status.count, 1);
  assert.equal(status.status, 'incompatible-prefix');
  assert.equal(status.action, 'manual-review-required');

  const controller = new RecoveryController(db, tinyPolicy());
  const { childId } = parentChild(controller, project.id, projectChunks(db, project.id).slice(0, 1));
  const attempted = controller.recordContribution({
    projectId: project.id,
    childId,
    stage: 'entities-facts',
    claimType: 'entity',
    uid: 'legacy-staged-uid',
    payload: { name: 'Legacy', evidence: 'legacy' },
    dependencyFingerprint: 'publication-attempt',
    disposition: 'applying',
  });
  assert.equal(attempted.inserted, false);
  assert.equal(attempted.id, null, 'a legacy staged row is never returned as claimable');
  assert.equal(
    db.get<{ disposition: string }>(
      'SELECT disposition FROM extraction_contribution WHERE contribution_uid = ?',
      'legacy-staged-uid',
    )?.disposition,
    'staged',
  );

  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const stats = await lorebook.extractLore(db, llm, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(stats.legacyStagedContributions?.count, 1);
  assert.equal(stats.legacyStagedContributions?.action, 'manual-review-required');
  assert.equal(count(db, 'canon_entity', project.id), 0);
  assert.equal(minedCount(db, project.id), 0);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_effect')?.n,
    0,
  );
  const ui = readFileSync(resolve(import.meta.dirname, '../../fanfable/src/ui/app.js'), 'utf8');
  assert.match(ui, /legacyStagedContributions/);
  db.close();
});

test('a change in another window invalidates the whole source generation roster', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-generation-window-change', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const ids = addSourceChunks(
    db,
    projectId,
    1,
    'KADE: Wait! Kade and Mara were friends at the gate. serena marsh watched.',
  );
  const sourceId = db.get<{ source_id: number }>(
    'SELECT source_id FROM canon_chunk WHERE id = ?',
    ids[0],
  )!.source_id;
  ids.push(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, text)
       VALUES (?, ?, 1, 'p. 2', ?)`,
      sourceId,
      projectId,
      'serena marsh waited alone.',
    ).lastInsertRowid,
  );
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'serena marsh watched',
  };
  let phase = 1;
  let bRelationCalls = 0;
  let bRelationSystem = '';
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    const passage = req.messages[0]?.content ?? '';
    const isB = passage.includes('waited alone');
    if (system.includes('KNOWN ENTITIES')) {
      if (isB) {
        bRelationCalls++;
        bRelationSystem = system;
      }
      return JSON.stringify({ relations: [] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({
      entities: phase === 1 && passage.includes('serena marsh watched') ? [serena] : [],
      facts: [],
    });
  }, 'stop');
  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.windows, 1);
  assert.equal(bRelationCalls, 0);

  phase = 2;
  db.run(
    'UPDATE canon_chunk SET text = ? WHERE id = ?',
    'serena marsh waited alone by the river.',
    ids[1],
  );
  const second = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(second.windows, 2);
  assert.equal(bRelationCalls, 0, 'the other window no longer sees the previous generation entity');
  assert.doesNotMatch(bRelationSystem, /Serena Marsh/);
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('adding or removing a source from scope isolates old staged entities', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-generation-source-scope', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const ids = addSourceChunks(
    db,
    projectId,
    1,
    'KADE: Wait! Kade and Mara were friends at the gate. serena marsh watched.',
  );
  const sourceA = db.get<{ source_id: number }>(
    'SELECT source_id FROM canon_chunk WHERE id = ?',
    ids[0],
  )!.source_id;
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'serena marsh watched',
  };
  let phase = 1;
  let relationSystem = '';
  let relationCalls = 0;
  let bRelationCalls = 0;
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    const passage = req.messages[0]?.content ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      relationCalls++;
      if (passage.includes('waited alone')) {
        bRelationCalls++;
        relationSystem = `${passage}\n${system}`;
      }
      return JSON.stringify({ relations: [] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({
      entities: phase === 1 && passage.includes('serena marsh watched') ? [serena] : [],
      facts: [],
    });
  }, 'stop');
  const first = await lorebook.extractLore(db, llm, projectId, {
    sourceId: sourceA,
    windowSize: 1,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.recovery?.status, 'complete');
  const callsAfterA = relationCalls;
  assert.equal(callsAfterA, 1);

  // Add a second source. Extracting the whole project is a different source
  // generation, so the old source-A child cannot enter source-B's roster.
  const sourceB = db.run(
    `INSERT INTO canon_source (project_id, path, title, sha256, imported_at)
     VALUES (?, ?, 'Synthetic B', 'synthetic-b', ?)`,
    projectId,
    `synthetic-b-${projectId}`,
    now,
  ).lastInsertRowid;
  db.run(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, text)
     VALUES (?, ?, 0, 'p. b1', ?)`,
    sourceB,
    projectId,
    'serena marsh waited alone.',
  );
  phase = 2;
  bRelationCalls = 0;
  relationSystem = '';
  const added = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(added.recovery?.status, 'complete');
  assert.equal(bRelationCalls, 0, 'source B does not inherit source A staged entities');
  assert.doesNotMatch(relationSystem, /Serena Marsh/);

  // Removing the second source from scope likewise starts a new generation.
  bRelationCalls = 0;
  relationSystem = '';
  const removed = await lorebook.extractLore(db, llm, projectId, {
    sourceId: sourceA,
    windowSize: 1,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(removed.recovery?.status, 'complete');
  assert.equal(bRelationCalls, 0);
  assert.doesNotMatch(relationSystem, /Serena Marsh/);
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('a legacy-blocked window does not contribute staged roster entities', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-legacy-blocked-roster', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const ids = addSourceChunks(
    db,
    projectId,
    1,
    'KADE: Wait! Kade and Mara were friends at the gate. serena marsh watched.',
  );
  const sourceId = db.get<{ source_id: number }>(
    'SELECT source_id FROM canon_chunk WHERE id = ?',
    ids[0],
  )!.source_id;
  ids.push(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, text)
       VALUES (?, ?, 1, 'p. 2', ?)`,
      sourceId,
      projectId,
      'serena marsh waited alone.',
    ).lastInsertRowid,
  );
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'serena marsh watched',
  };
  let relationCalls = 0;
  let bRelationSystem = '';
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    const passage = req.messages[0]?.content ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      relationCalls++;
      if (passage.includes('waited alone')) bRelationSystem = system;
      return JSON.stringify({ relations: [] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({
      entities: passage.includes('serena marsh watched') ? [serena] : [],
      facts: [],
    });
  }, 'stop');
  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.windows, 1);
  const callsAfterFirst = relationCalls;
  db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE id = ?', ids[0]);

  const second = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(second.windows, 1);
  assert.equal(second.legacyBlockedWindows, 1);
  assert.equal(relationCalls, callsAfterFirst, 'the blocked window does not seed the eligible prompt');
  assert.doesNotMatch(bRelationSystem, /Serena Marsh/);
  const relationCoverage = db.get<{ status: string }>(
    "SELECT status FROM extraction_stage_coverage WHERE stage = 'relations' ORDER BY id DESC LIMIT 1",
  );
  assert.equal(relationCoverage?.status, 'not_applicable');
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(count(db, 'canon_relation', projectId), 0);
  db.close();
});

test('fragment prompts cover every source character and never exceed the character bound', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-fragment-delivery', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const text = `${'A'.repeat(1399)}FINAL_CHAR_MARKER`;
  addSourceChunks(db, projectId, 1, text);
  const captured = new Set<string>();
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    const body = passageBody(req.messages[0]?.content ?? '');
    if (body) captured.add(body);
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const stats = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  const chunk = db.get<lorebook.ChunkRow>(
    `SELECT c.*, s.title AS source_title, s.path
       FROM canon_chunk c JOIN canon_source s ON s.id = c.source_id
      WHERE c.project_id = ?`,
    projectId,
  )!;
  const plan = lorebook.planRecoveryFragments([chunk]);
  assert.equal(plan.length, 2);
  assert.deepEqual(
    [...captured].sort(),
    plan.map((fragment) => fragment.window[0]!.text).sort(),
    'every planned fragment was actually delivered',
  );
  for (const fragment of plan) {
    assert.ok(fragment.window[0]!.text.length <= 1400, 'each request fragment is bounded');
  }
  const covered = new Uint8Array(text.length);
  for (const fragment of plan) {
    for (let i = fragment.sourceStart; i < fragment.sourceEnd; i++) covered[i] = 1;
  }
  assert.ok(covered.every((value) => value === 1), 'every source character is covered');
  assert.ok([...captured].some((body) => body.includes('FINAL_CHAR_MARKER')));
  assert.equal(stats.fragmentCoverage?.status, 'complete');
  assert.equal(stats.fragmentCoverage?.plannedFragments, 2);
  assert.equal(stats.fragmentCoverage?.completeFragments, 2);
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(count(db, 'canon_relation', projectId), 0);
  assert.equal(count(db, 'extraction_run', projectId), 0);
  assert.equal(count(db, 'extraction_window_run', projectId), 0);
  assert.equal(count(db, 'embedding', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('repeated exact fragment evidence fails closed instead of mapping to the first occurrence', () => {
  const chunk: lorebook.ChunkRow = {
    id: 1,
    seq: 0,
    heading: '',
    locator: 'p. 1',
    text: 'Repeat me. filler. Repeat me.',
    source_title: 'Synthetic',
    path: 'synthetic',
    source_id: 1,
    chunk_start: 100,
    chunk_end: 132,
  };
  const span = lorebook.verifySpan('Repeat me.', chunk);
  assert.equal(span.status, 'dropped');
  assert.equal(span.chunk_start, undefined);
  assert.equal(span.chunk_end, undefined);
});

test('short-window staging audits final roster staleness and converges on revalidation', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-short-roster-stale', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const ids = addSourceChunks(db, projectId, 1, 'KADE: Wait! Kade and Mara were friends at the gate.');
  const sourceId = db.get<{ source_id: number }>(
    'SELECT source_id FROM canon_chunk WHERE id = ?',
    ids[0],
  )!.source_id;
  db.run(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, text)
     VALUES (?, ?, 1, 'p. 2', ?)`,
    sourceId,
    projectId,
    'Serena Marsh watched from the ridge.',
  );
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'Serena Marsh',
  };
  const handler = (req: { system?: string; messages: { content: string }[] }) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    const body = passageBody(req.messages[0]?.content ?? '');
    return JSON.stringify({ entities: body.includes('Serena Marsh') ? [serena] : [], facts: [] });
  };
  const llm = mockProvider(handler);
  const baseChat = llm.chat.bind(llm);
  llm.chat = async (req) => {
    const system = req.system ?? '';
    const body = passageBody(req.messages[0]?.content ?? '');
    if (
      body.includes('Serena Marsh') &&
      !system.includes('KNOWN ENTITIES') &&
      !system.includes('"timeline"')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return { ...(await baseChat(req)), finishReason: 'stop' as const };
  };
  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 2,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.fragmentCoverage, undefined);
  assert.equal(first.recovery?.status, 'partial');
  assert.ok((first.recoveryRelationStale ?? 0) >= 1);
  assert.equal(
    db.get<{ status: string }>(
      'SELECT status FROM extraction_recovery_parent ORDER BY id DESC LIMIT 1',
    )?.status,
    'partial',
  );
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);

  const revalidated = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 1,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(revalidated.recovery?.status, 'complete');
  assert.equal(revalidated.recoveryRelationStale, 0);
  assert.ok((revalidated.recoveryRosterStale ?? 0) >= 1);
  assert.equal(
    db.get<{ status: string }>(
      'SELECT status FROM extraction_recovery_parent ORDER BY id DESC LIMIT 1',
    )?.status,
    'complete',
  );
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('a later fragment that adds a staged entity makes earlier relation coverage partial until revalidated', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-fragment-roster-stale', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const prefix = 'KADE: Wait! Kade and Mara were friends at the gate.';
  const text = `${prefix}${'x'.repeat(1500 - prefix.length)} Serena Marsh ${'x'.repeat(2800 - 1500)}`;
  addSourceChunks(db, projectId, 1, text);
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'Serena Marsh',
  };
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    const body = passageBody(req.messages[0]?.content ?? '');
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({
      entities: body.includes('Serena Marsh') ? [serena] : [],
      facts: [],
    });
  }, 'stop');
  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.fragmentCoverage?.completeFragments, 3);
  assert.equal(first.fragmentCoverage?.status, 'partial');
  assert.ok((first.fragmentCoverage?.staleRelationFragments ?? 0) >= 1);
  assert.equal(first.recovery?.status, 'partial');
  assert.equal(
    db.get<{ status: string }>(
      'SELECT status FROM extraction_recovery_parent ORDER BY id DESC LIMIT 1',
    )?.status,
    'partial',
  );
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_stage_coverage WHERE stage = 'relations' AND status IN ('complete','empty','not_applicable')",
    )?.n,
    3,
  );

  const revalidated = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(revalidated.fragmentCoverage?.status, 'complete');
  assert.equal(revalidated.fragmentCoverage?.staleRelationFragments, 0);
  assert.equal(revalidated.recovery?.status, 'complete');
  assert.equal(revalidated.recoveryRosterStale, 1);
  assert.equal(revalidated.recoverySkippedComplete, 2);
  assert.equal(
    db.get<{ status: string }>(
      'SELECT status FROM extraction_recovery_parent ORDER BY id DESC LIMIT 1',
    )?.status,
    'complete',
  );
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('cross-boundary evidence is stored with canonical-chunk start and end offsets', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-fragment-offsets', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const evidence = 'Serena Marsh and Kade were friends at the gate.';
  const text = `${'x'.repeat(1379)} ${evidence} ${'y'.repeat(600)}`;
  addSourceChunks(db, projectId, 1, text);
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'Serena Marsh',
  };
  const kade = {
    ...serena,
    name: 'Kade',
    evidence: 'Kade',
  };
  const relation = {
    from: 'Serena Marsh',
    to: 'Kade',
    kind: 'friend of',
    description: 'They were friends.',
    chunk_index: 0,
    evidence,
  };
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      return JSON.stringify({ relations: [relation] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [serena, kade], facts: [] });
  }, 'stop');
  const stats = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(stats.fragmentCoverage?.status, 'partial');
  assert.ok((stats.fragmentCoverage?.staleRelationFragments ?? 0) >= 1);
  const batches = db.all<{ payload_json: string }>(
    "SELECT payload_json FROM extraction_staged_batch WHERE stage = 'relations' AND complete = 1",
  );
  const annotated = batches
    .flatMap((batch) => {
      try {
        return (JSON.parse(batch.payload_json) as { relations?: Array<Record<string, unknown>> }).relations ?? [];
      } catch {
        return [];
      }
    })
    .find((row) => row.evidence === evidence && row.chunk_start !== undefined) as Record<string, unknown> | undefined;
  assert.ok(annotated, 'the cross-boundary relation was sealed');
  assert.equal(annotated.chunk_start, 1380);
  assert.equal(annotated.chunk_end, 1380 + evidence.length);
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM extraction_contribution WHERE claim_type = ?', 'relation')?.n,
    1,
    'only the complete fragment stages the relation',
  );
  const revalidated = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(revalidated.fragmentCoverage?.status, 'complete');
  assert.equal(revalidated.fragmentCoverage?.staleRelationFragments, 0);
  assert.equal(count(db, 'canon_relation', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('an intermediate fragment failure resumes alone and never completes the source early', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-fragment-retry', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const chars = Array.from({ length: 3000 }, () => 'x');
  const markers = ['MARK0', 'MARK1', 'MARK2'];
  for (let i = 0; i < markers.length; i++) {
    const start = i * 1144;
    if (start > 0) chars[start - 1] = ' ';
    for (let j = 0; j < markers[i]!.length; j++) chars[start + j] = markers[i]![j]!;
    if (start + markers[i]!.length < chars.length) chars[start + markers[i]!.length] = ' ';
  }
  const text = chars.join('');
  addSourceChunks(db, projectId, 1, text);
  let broken = true;
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    const body = passageBody(req.messages[0]?.content ?? '');
    const marker = markers.find((value) => body.startsWith(value)) ?? 'MARK0';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    if (broken && marker === 'MARK1') return 'not json';
    return JSON.stringify({
      entities: [{ ...SERENA, name: `Actor ${marker.at(-1)}`, evidence: marker }],
      facts: [],
    });
  }, 'stop');
  const partial = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(partial.fragmentCoverage?.plannedFragments, 3);
  assert.equal(partial.fragmentCoverage?.completeFragments, 2);
  assert.equal(partial.fragmentCoverage?.status, 'partial');
  assert.equal(partial.fragmentCoverage?.partialSourceChunks, 1);
  assert.equal(partial.recovery?.status, 'deferred');
  const contributionsBefore = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM extraction_contribution WHERE claim_type = 'entity'",
  )?.n;
  assert.equal(contributionsBefore, 2);

  broken = false;
  const resumed = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true, explicitRetry: true }),
  });
  assert.equal(resumed.fragmentCoverage?.status, 'partial');
  assert.equal(resumed.fragmentCoverage?.completeFragments, 3);
  assert.equal(resumed.fragmentCoverage?.partialSourceChunks, 0);
  assert.ok((resumed.fragmentCoverage?.staleRelationFragments ?? 0) >= 1);
  assert.equal(resumed.recovery?.status, 'partial');
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_contribution WHERE claim_type = 'entity'")?.n,
    3,
    'the two completed fragments were not re-applied; only the deferred fragment was added',
  );
  assert.equal(
    db.get<{ n: number }>(
      'SELECT COUNT(DISTINCT contribution_uid) AS n FROM extraction_contribution',
    )?.n,
    3,
    'each fragment keeps a distinct contribution',
  );
  const stabilized = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(stabilized.fragmentCoverage?.status, 'complete');
  assert.equal(stabilized.fragmentCoverage?.staleRelationFragments, 0);
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('overlap keeps exact evidence idempotent but distinct claims separate', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-fragment-overlap', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const evidence = 'Serena Marsh and Kade were friends at the gate.';
  const text = `${'x'.repeat(1199)} ${evidence} ${'y'.repeat(1700)}`;
  addSourceChunks(db, projectId, 1, text);
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'Serena Marsh',
  };
  const kade = { ...serena, name: 'Kade', evidence: 'Kade' };
  const relations = [
    { from: 'Serena Marsh', to: 'Kade', kind: 'friend of', description: 'Friends.', chunk_index: 0, evidence },
    { from: 'Serena Marsh', to: 'Kade', kind: 'ally of', description: 'Allies.', chunk_index: 0, evidence },
  ];
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [serena, kade], facts: [] });
  }, 'stop');
  const stats = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(stats.fragmentCoverage?.status, 'complete');
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_contribution WHERE claim_type = 'relation'")?.n,
    2,
    'the two kinds are distinct claims',
  );
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(DISTINCT contribution_uid) AS n FROM extraction_contribution WHERE claim_type = 'relation'",
    )?.n,
    2,
    'overlap does not duplicate either claim',
  );
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM extraction_contribution WHERE claim_type = 'entity'")?.n,
    2,
  );
  assert.equal(count(db, 'canon_relation', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('bounded fragment runs report partial coverage until every fragment is resumed', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-fragment-partial', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1, 'x'.repeat(3000));
  let calls = 0;
  const llm = finishProvider((req) => {
    calls++;
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const first = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.fragmentCoverage?.plannedFragments, 3);
  assert.equal(first.fragmentCoverage?.selectedFragments, 1);
  assert.equal(first.fragmentCoverage?.completeFragments, 1);
  assert.equal(first.fragmentCoverage?.status, 'partial');
  assert.equal(first.fragmentCoverage?.partialSourceChunks, 1);
  const callsAfterFirst = calls;

  const second = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(second.fragmentCoverage?.completeFragments, 2);
  assert.equal(second.fragmentCoverage?.status, 'partial');
  assert.equal(second.recoverySkippedComplete, 1);
  assert.ok(calls > callsAfterFirst);

  const third = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(third.fragmentCoverage?.completeFragments, 3);
  assert.equal(third.fragmentCoverage?.completeSourceChunks, 1);
  assert.equal(third.fragmentCoverage?.status, 'complete');
  assert.equal(third.recoverySkippedComplete, 2);
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('two same-generation staging invocations get distinct parent attribution', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-run-id-collision', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 2);
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const opts = {
    windowSize: 1,
    concurrency: 1,
    maxWindows: 1,
    recovery: recovery({ stageOnly: true }),
  };
  await lorebook.extractLore(db, llm, projectId, opts);
  await lorebook.extractLore(db, llm, projectId, opts);
  const parents = db.all<{ id: number; scope_key: string }>(
    'SELECT id, scope_key FROM extraction_recovery_parent WHERE project_id = ? ORDER BY id',
    projectId,
  );
  assert.equal(parents.length, 2);
  assert.notEqual(parents[0]!.scope_key, parents[1]!.scope_key);
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('stale parent downgrade is atomic with finalization', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-atomic-stale-parent');
  const controller = new RecoveryController(db, tinyPolicy());
  const { parentId, childId } = parentChild(controller, project.id, projectChunks(db, project.id).slice(0, 1));
  db.run("UPDATE extraction_recovery_child SET status = 'complete' WHERE id = ?", childId);
  db.exec(`
    CREATE TRIGGER fail_stale_parent_update
    BEFORE UPDATE OF status ON extraction_recovery_parent
    WHEN NEW.status = 'partial'
    BEGIN SELECT RAISE(ABORT, 'stale-parent-finalize-failure'); END;
  `);
  assert.throws(
    () => controller.finalizeParent(parentId, { forcePartial: true }),
    /stale-parent-finalize-failure/,
  );
  assert.equal(controller.getParent(parentId)?.status, 'pending', 'failed finalization rolled back');
  db.exec('DROP TRIGGER fail_stale_parent_update');
  assert.equal(controller.finalizeParent(parentId, { forcePartial: true }), 'partial');
  assert.equal(controller.getParent(parentId)?.status, 'partial');
  assert.equal(controller.getChild(childId)?.status, 'complete', 'child completion is preserved');
  assert.equal(controller.getParent(parentId)?.completed_at, null);
  db.close();
});

test('thrown window errors are counted safely and never reported as success', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-thrown-window', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1);
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  db.exec(`
    CREATE TRIGGER synthetic_lease_failure
    BEFORE INSERT ON extraction_chunk_lease
    BEGIN SELECT RAISE(ABORT, 'synthetic lease failure with passage-like text'); END;
  `);
  const stats = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  db.exec('DROP TRIGGER synthetic_lease_failure');
  assert.equal(stats.executionFailures, 1);
  assert.ok(stats.emptyWindows.some((entry) => entry.reason === 'error'));
  assert.notEqual(stats.recovery?.status, 'complete');
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  const ui = readFileSync(resolve(import.meta.dirname, '../../fanfable/src/ui/app.js'), 'utf8');
  assert.match(ui, /executionFailures/);
  assert.match(ui, /emptyWindows/);
  assert.match(ui, /failed/);
  const cli = readFileSync(resolve(import.meta.dirname, '../../fanfable/src/cli.ts'), 'utf8');
  assert.match(cli, /executionFailures/);
  db.close();
});

test('CLI reports a none fragment aggregate as incomplete, never staged-only success', async () => {
  const { db, path } = tempDb();
  const now = new Date().toISOString();
  const projectName = 'recovery-cli-none-fragments';
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at, settings) VALUES (?, ?, ?, ?)`,
    projectName,
    now,
    now,
    JSON.stringify({ provider: 'mock' }),
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1, 'x'.repeat(3000));
  db.close();
  const cli = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
  const out = spawnSync(
    process.execPath,
    ['--no-warnings', cli, '--db', path, '--project', projectName, 'lore', 'extract', '--max-windows', '1'],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /staging incomplete \(not canon\)/);
  assert.match(out.stdout, /source coverage is incomplete/);
  assert.doesNotMatch(out.stdout, /staged only \(not canon\)/);
});

test('direct lazy stage-only windows report stale roster coverage honestly', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-lazy-stale-roster', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const ids = addSourceChunks(db, projectId, 1, 'KADE: Wait! Kade and Mara were friends at the gate.');
  const sourceId = db.get<{ source_id: number }>(
    'SELECT source_id FROM canon_chunk WHERE id = ?',
    ids[0],
  )!.source_id;
  ids.push(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, text)
       VALUES (?, ?, 1, 'p. 2', ?)`,
      sourceId,
      projectId,
      'Serena Marsh watched from the ridge.',
    ).lastInsertRowid,
  );
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'Serena Marsh',
  };
  const handler = (req: { system?: string; messages: { content: string }[] }) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    const body = passageBody(req.messages[0]?.content ?? '');
    return JSON.stringify({ entities: body.includes('Serena Marsh') ? [serena] : [], facts: [] });
  };
  const llm = mockProvider(handler);
  const baseChat = llm.chat.bind(llm);
  llm.chat = async (req) => {
    const system = req.system ?? '';
    const body = passageBody(req.messages[0]?.content ?? '');
    if (
      body.includes('Serena Marsh') &&
      !system.includes('KNOWN ENTITIES') &&
      !system.includes('"timeline"')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return { ...(await baseChat(req)), finishReason: 'stop' as const };
  };
  const opts = {
    windowSize: 1,
    concurrency: 2,
    maxLazyWindows: 2,
    recovery: recovery({ stageOnly: true }),
  };
  const first = await lorebook.ensureWindowsForChunks(db, llm, projectId, ids, opts);
  assert.equal(first.recovery?.status, 'partial');
  assert.ok((first.recoveryRelationStale ?? 0) >= 1);
  assert.equal(
    db.get<{ status: string }>(
      'SELECT status FROM extraction_recovery_parent ORDER BY id DESC LIMIT 1',
    )?.status,
    'partial',
  );

  const revalidated = await lorebook.ensureWindowsForChunks(db, llm, projectId, ids, {
    ...opts,
    concurrency: 1,
  });
  assert.equal(revalidated.recovery?.status, 'complete');
  assert.equal(revalidated.recoveryRelationStale, 0);
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('offset-validated staged entities survive repeated full-chunk evidence ambiguity', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-offset-roster', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const text = `${'x'.repeat(100)} serena marsh ${'x'.repeat(1880)} serena marsh ${'x'.repeat(900)}`;
  const [sourceChunkId] = addSourceChunks(db, projectId, 1, text);
  assert.ok(sourceChunkId !== undefined);
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'serena marsh',
  };
  let relationCalls = 0;
  let relationSystem = '';
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      relationCalls++;
      relationSystem = system;
      return JSON.stringify({ relations: [] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    const body = passageBody(req.messages[0]?.content ?? '');
    return JSON.stringify({
      entities: body.includes('serena marsh') ? [serena] : [],
      facts: [],
    });
  }, 'stop');
  const stats = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(stats.fragmentCoverage?.status, 'complete');
  assert.ok(relationCalls >= 1, 'the offset-validated entity reaches the relation prompt');
  assert.match(relationSystem, /Serena Marsh/);
  const rows = db.all<{ contribution_uid: string }>(
    "SELECT contribution_uid FROM extraction_contribution WHERE claim_type = 'entity'",
  );
  assert.equal(rows.length, 2, 'the two source offsets remain distinct claims');
  const needle = 'serena marsh';
  const firstStart = text.indexOf(needle);
  const secondStart = text.indexOf(needle, firstStart + needle.length);
  assert.ok(firstStart >= 0 && secondStart > firstStart);
  const contributed = new Set(rows.map((row) => row.contribution_uid));
  for (const start of [firstStart, secondStart]) {
    const expected = stagedRecoveryContributionUid(
      recoveryContributionUid({
        claimType: 'entity',
        sourceChunkId,
        payload: {
          ...serena,
          evidence: needle,
          chunk_start: start,
          chunk_end: start + needle.length,
        },
      }),
    );
    assert.ok(
      contributed.has(expected),
      `valid chunk_index 0 maps to canonical offset ${start} of source chunk ${sourceChunkId}`,
    );
  }
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('malformed chunk indexes never select a source chunk', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-invalid-chunk-index', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const [firstChunkId, secondChunkId] = addSourceChunks(db, projectId, 2);
  const firstQuote = 'Ada found the red kite above the mill.';
  const secondQuote = 'Bram carried the brass lantern to the dock.';
  const sharedQuote = 'The shared bell rang across the harbour.';
  db.run(
    'UPDATE canon_chunk SET text = ? WHERE id = ?',
    `${firstQuote} ${sharedQuote}`,
    firstChunkId,
  );
  db.run(
    'UPDATE canon_chunk SET text = ? WHERE id = ?',
    `${secondQuote} ${sharedQuote}`,
    secondChunkId,
  );
  assert.ok(firstChunkId !== undefined && secondChunkId !== undefined);

  const entity = (name: string, chunkIndex: unknown, evidence: string): Record<string, unknown> => ({
    kind: 'character',
    name,
    aliases: [],
    summary: '',
    attributes: {},
    role: '',
    status: '',
    chunk_index: chunkIndex,
    evidence,
  });
  const validFirst = entity('Valid First', 0, firstQuote);
  const validSecond = entity('Valid Second', 1, secondQuote);
  const sharedFirst = entity('Shared First', 0, sharedQuote);
  const sharedSecond = entity('Shared Second', 1, sharedQuote);
  const malformed = (
    [
      ['Null Index', null],
      ['Empty Index', ''],
      ['False Index', false],
      ['True Index', true],
      ['String Index', '1'],
      ['Zero String Index', '0'],
      ['Padded String Index', '01'],
      ['Spaced String Index', ' 1'],
      ['Plus String Index', '+1'],
      ['Fraction String Index', '1.0'],
      ['Fraction Index', 1.5],
      ['Negative Index', -1],
      ['Out Of Range Index', 2],
      ['Missing Index', undefined],
    ] as const
  ).map(([name, chunkIndex]) => entity(name, chunkIndex, sharedQuote));

  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({
      entities: [validFirst, validSecond, sharedFirst, sharedSecond, ...malformed],
      facts: [],
    });
  }, 'stop');

  const stats = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 2,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(stats.windows, 1);
  assert.equal(stats.entities, 4, 'only explicitly indexed claims are staged');

  const uidFor = (
    raw: Record<string, unknown>,
    sourceChunkId: number,
    quote: string,
  ): string =>
    stagedRecoveryContributionUid(
      recoveryContributionUid({
        claimType: 'entity',
        sourceChunkId,
        payload: { ...raw, evidence: quote },
      }),
    );
  const expected = new Set([
    uidFor(validFirst, firstChunkId, firstQuote),
    uidFor(validSecond, secondChunkId, secondQuote),
    uidFor(sharedFirst, firstChunkId, sharedQuote),
    uidFor(sharedSecond, secondChunkId, sharedQuote),
  ]);
  const rows = db.all<{ contribution_uid: string }>(
    "SELECT contribution_uid FROM extraction_contribution WHERE claim_type = 'entity' ORDER BY id",
  );
  assert.equal(rows.length, 4, 'malformed indexes produce no staged contribution');
  assert.deepEqual(new Set(rows.map((row) => row.contribution_uid)), expected);
  assert.ok(
    !rows.some(
      (row) => row.contribution_uid === uidFor(sharedFirst, secondChunkId, sharedQuote),
    ),
    'a claim never crosses to the other chunk that also contains its quote',
  );
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('lazy budget skips complete and deferred hits before selecting later eligible work', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-lazy-budget-order', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const ids = addSourceChunks(db, projectId, 3);
  let calls = 0;
  const good = finishProvider((req) => {
    calls++;
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  }, 'stop');
  const bad = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return 'not json';
  }, 'stop');
  const opts = {
    windowSize: 1,
    maxLazyWindows: 1,
    recovery: recovery({ stageOnly: true }),
  };
  await lorebook.ensureWindowsForChunks(db, good, projectId, [ids[0]!], opts);
  await lorebook.ensureWindowsForChunks(db, bad, projectId, [ids[1]!], opts);
  const callsBefore = calls;

  const picked = await lorebook.ensureWindowsForChunks(db, good, projectId, ids, opts);
  assert.equal(picked.windows, 1);
  assert.equal(picked.recoverySkippedComplete, 1);
  assert.equal(picked.recoverySkippedDeferred, 1);
  assert.equal(calls, callsBefore + 2, 'only the later eligible window calls the provider');
  assert.equal(
    db.get<{ status: string }>(
      'SELECT status FROM extraction_recovery_child WHERE chunk_ids = ?',
      JSON.stringify([ids[2]]),
    )?.status,
    'complete',
  );
  assert.equal(
    db.get<{ status: string }>(
      'SELECT status FROM extraction_recovery_child WHERE chunk_ids = ?',
      JSON.stringify([ids[1]]),
    )?.status,
    'deferred',
  );
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('a sibling connection generation is refreshed before the final stale audit', async () => {
  const { db, path } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-concurrent-sibling', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const ids = addSourceChunks(db, projectId, 1, 'KADE: Wait! Kade and Mara were friends at the gate.');
  const sourceId = db.get<{ source_id: number }>(
    'SELECT source_id FROM canon_chunk WHERE id = ?',
    ids[0],
  )!.source_id;
  ids.push(
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, text)
       VALUES (?, ?, 1, 'p. 2', ?)`,
      sourceId,
      projectId,
      'Serena Marsh watched from the ridge.',
    ).lastInsertRowid,
  );
  const serena = {
    kind: 'character',
    name: 'Serena Marsh',
    aliases: [],
    summary: 'A watcher.',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence: 'Serena Marsh',
  };
  let releaseA!: () => void;
  const release = new Promise<void>((resolve) => { releaseA = resolve; });
  let startedA!: () => void;
  const started = new Promise<void>((resolve) => { startedA = resolve; });
  const a = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: [], facts: [] });
  });
  const aBase = a.chat.bind(a);
  a.chat = async (req) => {
    const system = req.system ?? '';
    const body = passageBody(req.messages[0]?.content ?? '');
    if (!system.includes('KNOWN ENTITIES') && !system.includes('"timeline"') && body.includes('KADE')) {
      startedA();
      await release;
    }
    return { ...(await aBase(req)), finishReason: 'stop' as const };
  };
  const b = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    const body = passageBody(req.messages[0]?.content ?? '');
    return JSON.stringify({ entities: body.includes('Serena Marsh') ? [serena] : [], facts: [] });
  }, 'stop');
  const opts = {
    windowSize: 1,
    concurrency: 1,
    maxLazyWindows: 1,
    recovery: recovery({ stageOnly: true }),
  };
  const aPromise = lorebook.ensureWindowsForChunks(db, a, projectId, [ids[0]!], opts);
  await started;
  // The guard is per Db instance, so a second connection can create the
  // compatible sibling this final-audit regression needs. Separate processes
  // have the same unguarded gap and remain an operational constraint.
  const siblingDb = new Db(path);
  const bResult = await lorebook.ensureWindowsForChunks(siblingDb, b, projectId, [ids[1]!], opts);
  siblingDb.close();
  assert.equal(bResult.recovery?.status, 'complete');
  releaseA();
  const aResult = await aPromise;
  assert.equal(aResult.recovery?.status, 'partial');
  assert.ok((aResult.recoveryRelationStale ?? 0) >= 1);

  const revalidated = await lorebook.ensureWindowsForChunks(db, a, projectId, [ids[0]!], opts);
  assert.equal(revalidated.recovery?.status, 'complete');
  assert.equal(revalidated.recoveryRelationStale, 0);
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('stage-only extraction rejects an overlapping same-project request before its provider runs', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'guard-same-project');
  const slow = gatedProvider(splitHandler());
  let rejectedCalls = 0;
  const secondHandler = splitHandler();
  const second = finishProvider((req) => {
    rejectedCalls++;
    return secondHandler(req);
  }, 'stop');
  const opts = {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  };
  const first = lorebook.extractLore(db, slow.llm, project.id, opts);
  await slow.started;
  const parentsBefore = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM extraction_recovery_parent WHERE project_id = ?',
    project.id,
  )?.n ?? 0;
  await assert.rejects(
    lorebook.extractLore(db, second, project.id, opts),
    (err: unknown) =>
      err instanceof lorebook.StageOnlyExtractionBusyError &&
      err.code === 'stage-only-busy' &&
      err.message.includes('already running for project'),
  );
  assert.equal(slow.calls(), 1, 'the held request made the only provider call');
  assert.equal(rejectedCalls, 0, 'the rejected request never reaches its provider');
  assert.equal(
    db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM extraction_recovery_parent WHERE project_id = ?',
      project.id,
    )?.n,
    parentsBefore,
    'the rejected request creates no recovery parent',
  );
  slow.release();
  const result = await first;
  assert.equal(result.recovery?.status, 'complete');
  assert.equal(count(db, 'canon_entity', project.id), 0);
  assert.equal(minedCount(db, project.id), 0);
  assert.ok(
    (db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_contribution WHERE claim_type = 'entity' AND disposition = 'staged'",
    )?.n ?? 0) > 0,
    'only staged contributions are written',
  );
  db.close();
});

test('stage-only extraction lets a different project proceed while one is running', async () => {
  const { db } = tempDb();
  const firstProject = seedProject(db, 'guard-project-a');
  const secondProject = seedProject(db, 'guard-project-b');
  const slow = gatedProvider(splitHandler());
  const opts = {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  };
  const first = lorebook.extractLore(db, slow.llm, firstProject.id, opts);
  await slow.started;
  let secondCalls = 0;
  const secondHandler = splitHandler();
  const second = finishProvider((req) => {
    secondCalls++;
    return secondHandler(req);
  }, 'stop');
  const secondResult = await lorebook.extractLore(db, second, secondProject.id, opts);
  assert.equal(secondResult.recovery?.status, 'complete');
  assert.ok(secondCalls > 0, 'the other project still calls its provider');
  slow.release();
  const firstResult = await first;
  assert.equal(firstResult.recovery?.status, 'complete');
  assert.equal(count(db, 'canon_entity', firstProject.id), 0);
  assert.equal(count(db, 'canon_entity', secondProject.id), 0);
  assert.equal(minedCount(db, firstProject.id), 0);
  assert.equal(minedCount(db, secondProject.id), 0);
  db.close();
});

test('a failed stage-only run releases the guard for an explicit retry', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'guard-retry');
  const missing = finishProvider(
    splitHandler({ entitiesFacts: JSON.stringify({ entities: [SERENA] }) }),
    'stop',
  );
  const first = await lorebook.extractLore(db, missing, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(first.recovery?.status, 'deferred');
  const good = finishProvider(splitHandler(), 'stop');
  const second = await lorebook.extractLore(db, good, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true, explicitRetry: true }),
  });
  assert.equal(second.recovery?.status, 'complete');
  assert.equal(count(db, 'canon_entity', project.id), 0);
  assert.equal(minedCount(db, project.id), 0);
  db.close();
});

test('the stage-only guard covers direct lazy extraction and releases after completion', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'guard-lazy');
  const ids = projectChunks(db, project.id);
  assert.ok(ids.length >= 2);
  const slow = gatedProvider(splitHandler());
  const opts = {
    windowSize: 1,
    maxLazyWindows: 1,
    recovery: recovery({ stageOnly: true }),
  };
  const first = lorebook.ensureWindowsForChunks(db, slow.llm, project.id, [ids[0]!], opts);
  await slow.started;
  let rejectedCalls = 0;
  const secondHandler = splitHandler();
  const second = finishProvider((req) => {
    rejectedCalls++;
    return secondHandler(req);
  }, 'stop');
  await assert.rejects(
    lorebook.ensureWindowsForChunks(db, second, project.id, [ids[1]!], opts),
    /already running for project/,
  );
  assert.equal(rejectedCalls, 0);
  assert.equal(slow.calls(), 1);
  slow.release();
  const firstResult = await first;
  assert.equal(firstResult.recovery?.status, 'complete');
  let laterCalls = 0;
  const laterHandler = splitHandler();
  const later = finishProvider((req) => {
    laterCalls++;
    return laterHandler(req);
  }, 'stop');
  const laterResult = await lorebook.ensureWindowsForChunks(db, later, project.id, [ids[1]!], opts);
  assert.equal(laterResult.recovery?.status, 'complete');
  assert.ok(laterCalls > 0, 'the guard is released after the first lazy run');
  assert.equal(count(db, 'canon_entity', project.id), 0);
  assert.equal(minedCount(db, project.id), 0);
  db.close();
});

test('CLI reports an incomplete stage-only run without canon writes', () => {
  const { db, path } = tempDb();
  const now = new Date().toISOString();
  const projectName = 'guard-cli-incomplete';
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at, settings) VALUES (?, ?, ?, ?)`,
    projectName,
    now,
    now,
    JSON.stringify({ provider: 'mock' }),
  ).lastInsertRowid;
  addSourceChunks(db, projectId, 1, 'Serena Marsh watched it from the ridge.');
  db.close();
  const cli = resolve(import.meta.dirname, '../../fanfable/src/cli.ts');
  const out = spawnSync(
    process.execPath,
    ['--no-warnings', cli, '--db', path, '--project', projectName, 'lore', 'extract'],
    { encoding: 'utf8', timeout: 60000 },
  );
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /staging incomplete \(not canon\)/);
  assert.doesNotMatch(out.stdout, /staged only \(not canon\)/);
  assert.doesNotMatch(out.stdout, /extracted \d+ entities/);
  const reopened = new Db(path);
  assert.equal(
    reopened.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM extraction_recovery_parent WHERE project_id = ?',
      projectId,
    )?.n,
    1,
  );
  for (const table of ['canon_entity', 'canon_fact', 'canon_relation', 'canon_timeline', 'extraction_run']) {
    assert.equal(
      reopened.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
        projectId,
      )?.n,
      0,
      `${table} is untouched by the incomplete staging run`,
    );
  }
  assert.equal(minedCount(reopened, projectId), 0);
  reopened.close();
});

test('a throwing progress callback releases the stage-only guard', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('guard-progress-throw', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  let providerCalls = 0;
  const llm = mockProvider(() => {
    providerCalls++;
    return JSON.stringify({ entities: [], facts: [] });
  });
  let threw = false;
  await assert.rejects(
    lorebook.extractLore(db, llm, projectId, {
      recovery: recovery({ stageOnly: true }),
      onProgress: () => {
        if (threw) return;
        threw = true;
        throw new Error('synthetic progress callback failure');
      },
    }),
    /synthetic progress callback failure/,
  );
  assert.equal(threw, true);
  assert.equal(providerCalls, 0, 'an empty source never reaches the provider');
  const second = await lorebook.extractLore(db, llm, projectId, {
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(second.emptySource, true);
  assert.equal(second.stageOnly, true);
  assert.equal(second.windows, 0);
  assert.equal(providerCalls, 0, 'the retry also stays on the empty-source path');
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(count(db, 'extraction_recovery_parent', projectId), 0);
  assert.equal(
    db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM extraction_run WHERE project_id = ?',
      projectId,
    )?.n,
    0,
  );
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('mixed stage-only entry points share the same Db/project guard', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'guard-mixed-entry');
  const ids = projectChunks(db, project.id);
  assert.ok(ids.length > 0);
  const firstProvider = gatedProvider(splitHandler());
  const first = lorebook.extractLore(db, firstProvider.llm, project.id, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  await firstProvider.started;
  let lazyCalls = 0;
  const lazyHandler = splitHandler();
  const lazy = finishProvider((req) => {
    lazyCalls++;
    return lazyHandler(req);
  }, 'stop');
  await assert.rejects(
    lorebook.ensureWindowsForChunks(db, lazy, project.id, [ids[0]!], {
      windowSize: 1,
      maxLazyWindows: 1,
      recovery: recovery({ stageOnly: true }),
    }),
    /already running for project/,
  );
  assert.equal(lazyCalls, 0, 'the mixed-entry call never reaches its provider');
  firstProvider.release();
  const firstResult = await first;
  assert.equal(firstResult.recovery?.status, 'complete');
  assert.equal(count(db, 'canon_entity', project.id), 0);
  assert.equal(minedCount(db, project.id), 0);
  db.close();
});

test('fragment evidence offsets use UTF-16 indices after a supplementary-plane character', async () => {
  const { db } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-fragment-utf16-offsets', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const evidence = 'the brass compass pointed north';
  const text = `${'a'.repeat(1400)}😀${'b'.repeat(20)} ${evidence} ${'c'.repeat(300)}`;
  addSourceChunks(db, projectId, 1, text);
  const witness = {
    kind: 'character',
    name: 'Compass Witness',
    aliases: [],
    summary: '',
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence,
  };
  const llm = finishProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    const body = passageBody(req.messages[0]?.content ?? '');
    return JSON.stringify({
      entities: body.includes(evidence) ? [witness] : [],
      facts: [],
    });
  }, 'stop');

  const stats = await lorebook.extractLore(db, llm, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: recovery({ stageOnly: true }),
  });
  assert.equal(stats.fragmentCoverage?.plannedFragments, 2);
  assert.equal(stats.fragmentCoverage?.completeFragments, 2);
  const expectedStart = text.indexOf(evidence);
  const expectedEnd = expectedStart + evidence.length;
  assert.ok(expectedStart > 1400, 'evidence is in the second fragment');
  assert.equal(text.slice(expectedStart, expectedEnd), evidence);

  const entities = db
    .all<{ payload_json: string }>(
      "SELECT payload_json FROM extraction_staged_batch WHERE stage = 'entities-facts' ORDER BY id",
    )
    .flatMap((row) => {
      const payload = JSON.parse(row.payload_json) as {
        entities?: Array<Record<string, unknown>>;
      };
      return payload.entities ?? [];
    })
    .filter((entity) => entity.name === 'Compass Witness');
  assert.equal(entities.length, 1, 'the evidence appears in exactly one fragment batch');
  const staged = entities[0]!;
  assert.equal(
    staged.chunk_start,
    expectedStart,
    'chunk_start is the canonical UTF-16 index',
  );
  assert.equal(
    staged.chunk_end,
    expectedEnd,
    'chunk_end is the canonical UTF-16 index',
  );
  assert.equal(
    text.slice(Number(staged.chunk_start), Number(staged.chunk_end)),
    evidence,
    'the persisted half-open range slices to the evidence',
  );
  assert.equal(count(db, 'canon_entity', projectId), 0);
  assert.equal(minedCount(db, projectId), 0);
  db.close();
});

test('a subprocess crash resumes the same stage-only recovery child', () => {
  const { db, path } = tempDb();
  const now = new Date().toISOString();
  const projectId = db.run(
    `INSERT INTO project (name, created_at, updated_at) VALUES ('recovery-subprocess', ?, ?)`,
    now,
    now,
  ).lastInsertRowid;
  const passage =
    'Serena Marsh watched it from the ridge. The rain had not stopped for three days.';
  const [chunkId] = addSourceChunks(db, projectId, 1, passage);
  assert.ok(chunkId !== undefined);
  db.close();

  const scriptDir = mkdtempSync(join(tmpdir(), 'fanfable-recovery-child-'));
  const childPath = join(scriptDir, 'child.mjs');
  const dbModule = resolve(import.meta.dirname, '../../fanfable/src/core/db.ts');
  const lorebookModule = resolve(import.meta.dirname, '../../fanfable/src/lorebook.ts');
  const llmModule = resolve(import.meta.dirname, '../../fanfable/src/core/llm.ts');
  const childScript = `
import { writeSync } from 'node:fs';
const { Db } = await import(${JSON.stringify(dbModule)});
const lorebook = await import(${JSON.stringify(lorebookModule)});
const { MockProvider } = await import(${JSON.stringify(llmModule)});
const [dbPath, projectArg, mode] = process.argv.slice(2);
const projectId = Number(projectArg);
const entity = ${JSON.stringify(SERENA)};
const fact = ${JSON.stringify(FACT)};
const db = new Db(dbPath);
const provider = new MockProvider({ provider: 'mock', model: 'subprocess-recovery' });
const marker = (stage) => writeSync(1, 'CALL ' + stage + '\\n');
provider.chat = async (req) => {
  const system = req.system ?? '';
  if (system.includes('KNOWN ENTITIES')) {
    marker('relations');
    if (mode === 'crash') process.exit(73);
    return {
      text: JSON.stringify({ relations: [] }),
      model: provider.settings.model,
      provider: 'mock',
      durationMs: 0,
      finishReason: 'stop',
    };
  }
  if (system.includes('"timeline"')) {
    marker('timeline');
    return {
      text: JSON.stringify({ timeline: [] }),
      model: provider.settings.model,
      provider: 'mock',
      durationMs: 0,
      finishReason: 'stop',
    };
  }
  marker('entities-facts');
  return {
    text: JSON.stringify({ entities: [entity], facts: [fact] }),
    model: provider.settings.model,
    provider: 'mock',
    durationMs: 0,
    finishReason: 'stop',
  };
};
try {
  const stats = await lorebook.extractLore(db, provider, projectId, {
    windowSize: 8,
    concurrency: 1,
    recovery: {
      stageOnly: true,
      policy: { leaseMs: 60000, heartbeatMs: 60000, backoffMs: [1] },
    },
  });
  writeSync(1, 'STATUS ' + (stats.recovery?.status ?? 'none') + '\\n');
} finally {
  db.close();
}
`;
  writeFileSync(childPath, childScript, 'utf8');
  const runChild = (mode: 'crash' | 'resume') =>
    spawnSync(
      process.execPath,
      ['--no-warnings', childPath, path, String(projectId), mode],
      { encoding: 'utf8', timeout: 60000 },
    );

  const crashed = runChild('crash');
  assert.equal(crashed.status, 73, crashed.stderr || crashed.stdout);
  assert.match(crashed.stdout, /CALL entities-facts/);
  assert.doesNotMatch(crashed.stdout, /CALL timeline/);

  const afterCrash = new Db(path);
  const crashedChild = afterCrash.get<{
    id: number;
    parent_id: number;
    work_key: string;
    status: string;
  }>(
    'SELECT id, parent_id, work_key, status FROM extraction_recovery_child WHERE project_id = ? ORDER BY id LIMIT 1',
    projectId,
  )!;
  assert.equal(crashedChild.status, 'running');
  const parent = afterCrash.get<{ status: string; readiness: string }>(
    'SELECT status, readiness FROM extraction_recovery_parent WHERE id = ?',
    crashedChild.parent_id,
  )!;
  assert.equal(parent.readiness, 'staged_only');
  assert.equal(
    afterCrash.get<{ status: string }>(
      "SELECT status FROM extraction_stage_coverage WHERE child_id = ? AND stage = 'entities-facts' ORDER BY id DESC LIMIT 1",
      crashedChild.id,
    )?.status,
    'complete',
  );
  assert.equal(
    afterCrash.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_stage_coverage WHERE child_id = ? AND stage = 'relations'",
      crashedChild.id,
    )?.n,
    0,
    'the crash happens before relation coverage',
  );
  assert.equal(
    afterCrash.get<{ status: string }>(
      "SELECT status FROM extraction_attempt WHERE child_id = ? AND stage = 'relations' ORDER BY id DESC LIMIT 1",
      crashedChild.id,
    )?.status,
    'running',
  );
  const contributionsBefore = afterCrash.all<{
    contribution_uid: string;
    payload_sha256: string;
    disposition: string;
    claim_type: string;
  }>(
    `SELECT contribution_uid, payload_sha256, disposition, claim_type
       FROM extraction_contribution
      WHERE project_id = ?
      ORDER BY contribution_uid`,
    projectId,
  );
  assert.equal(contributionsBefore.length, 2, 'the entity and fact are staged once');
  assert.ok(contributionsBefore.every((row) => row.disposition === 'staged'));
  assert.ok(contributionsBefore.every((row) => row.contribution_uid.startsWith('staged:')));
  const stagedBatchBefore = afterCrash.get<{ payload_json: string }>(
    `SELECT payload_json
       FROM extraction_staged_batch
      WHERE child_id = ? AND stage = 'entities-facts'
      ORDER BY id DESC LIMIT 1`,
    crashedChild.id,
  )!;
  assert.match(stagedBatchBefore.payload_json, /Serena Marsh/);
  assert.match(stagedBatchBefore.payload_json, /rain/);
  for (const table of ['canon_entity', 'canon_fact', 'canon_relation', 'canon_timeline', 'extraction_run']) {
    assert.equal(
      afterCrash.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
        projectId,
      )?.n,
      0,
      `${table} is untouched after the crash`,
    );
  }
  assert.equal(
    afterCrash.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1',
      projectId,
    )?.n,
    0,
  );
  assert.ok(
    (afterCrash.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM extraction_chunk_lease WHERE child_id = ?',
      crashedChild.id,
    )?.n ?? 0) > 0,
    'the crashed child left a lease to expire',
  );
  const past = new Date(Date.now() - 60_000).toISOString();
  afterCrash.run(
    'UPDATE extraction_chunk_lease SET lease_until = ? WHERE child_id = ?',
    past,
    crashedChild.id,
  );
  afterCrash.run(
    "UPDATE extraction_attempt SET lease_until = ? WHERE child_id = ? AND status = 'running'",
    past,
    crashedChild.id,
  );
  afterCrash.close();

  const resumed = runChild('resume');
  assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  assert.match(resumed.stdout, /CALL relations/);
  assert.match(resumed.stdout, /CALL timeline/);
  assert.doesNotMatch(resumed.stdout, /CALL entities-facts/);
  assert.match(resumed.stdout, /STATUS complete/);

  const afterResume = new Db(path);
  const resumedChild = afterResume.get<{
    id: number;
    work_key: string;
    status: string;
  }>(
    'SELECT id, work_key, status FROM extraction_recovery_child WHERE project_id = ? ORDER BY id LIMIT 1',
    projectId,
  )!;
  assert.equal(resumedChild.id, crashedChild.id, 'the same recovery child resumes');
  assert.equal(resumedChild.work_key, crashedChild.work_key, 'the same work identity resumes');
  assert.equal(resumedChild.status, 'complete');
  const contributionsAfter = afterResume.all<{
    contribution_uid: string;
    payload_sha256: string;
    disposition: string;
    claim_type: string;
  }>(
    `SELECT contribution_uid, payload_sha256, disposition, claim_type
       FROM extraction_contribution
      WHERE project_id = ?
      ORDER BY contribution_uid`,
    projectId,
  );
  assert.deepEqual(contributionsAfter, contributionsBefore, 'no staged contribution is duplicated');
  const stagedBatchAfter = afterResume.get<{ payload_json: string }>(
    `SELECT payload_json
       FROM extraction_staged_batch
      WHERE child_id = ? AND stage = 'entities-facts'
      ORDER BY id DESC LIMIT 1`,
    crashedChild.id,
  )!;
  assert.equal(stagedBatchAfter.payload_json, stagedBatchBefore.payload_json);
  assert.equal(
    afterResume.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_staged_batch WHERE child_id = ? AND stage = 'entities-facts'",
      crashedChild.id,
    )?.n,
    1,
    'the committed entities-facts batch is reused, not re-sealed',
  );
  assert.equal(
    afterResume.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM extraction_attempt WHERE child_id = ? AND stage = 'entities-facts'",
      crashedChild.id,
    )?.n,
    1,
    'the resumed child never re-calls entities-facts',
  );
  const latestParent = afterResume.get<{ status: string; readiness: string }>(
    'SELECT status, readiness FROM extraction_recovery_parent WHERE project_id = ? ORDER BY id DESC LIMIT 1',
    projectId,
  )!;
  assert.equal(latestParent.status, 'complete');
  assert.equal(latestParent.readiness, 'staged_only');
  const coverage = new Map(
    afterResume
      .all<{ stage: string; status: string }>(
        'SELECT stage, status FROM extraction_stage_coverage WHERE child_id = ?',
        crashedChild.id,
      )
      .map((row) => [row.stage, row.status]),
  );
  assert.equal(coverage.get('entities-facts'), 'complete');
  assert.equal(coverage.get('relations'), 'empty');
  assert.equal(coverage.get('timeline'), 'empty');
  for (const table of ['canon_entity', 'canon_fact', 'canon_relation', 'canon_timeline', 'extraction_run']) {
    assert.equal(
      afterResume.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`,
        projectId,
      )?.n,
      0,
      `${table} is untouched after the resumed run`,
    );
  }
  assert.equal(
    afterResume.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1',
      projectId,
    )?.n,
    0,
  );
  afterResume.close();
});

/** Drive one child through its only stage to a complete, mined state. */
function completeChild(
  controller: RecoveryController,
  projectId: number,
  childId: number,
  owner = 'owner-a',
  fingerprint = stageFingerprint(),
): number {
  setFingerprint(controller, childId, 'entities-facts', fingerprint, owner);
  const fencing = claim(controller, childId, owner);
  const attempt = controller.beginAttempt(childId, 'entities-facts', owner, fencing, fingerprint);
  controller.stageBatch({
    attemptId: attempt.attemptId!,
    childId,
    projectId,
    stage: 'entities-facts',
    fingerprint,
    payload: { entities: [], facts: [] },
    finishReason: 'stop',
    complete: true,
  });
  controller.applyCoverage({
    childId,
    projectId,
    stage: 'entities-facts',
    fingerprint,
    attemptId: attempt.attemptId!,
    owner,
    fencing,
    status: 'empty',
    apply: () => {},
  });
  assert.equal(controller.finalizeChild(childId, owner, fencing), 'complete');
  return fencing;
}

test('a live lease blocks a complete-child reopen and leaves the child complete', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-reopen-overlap');
  const ids = projectChunks(db, project.id);
  const controller = new RecoveryController(db, { leaseMs: 60_000, heartbeatMs: 60_000, backoffMs: [1] });
  const { childId } = parentChild(controller, project.id, [ids[0]!]);
  completeChild(controller, project.id, childId);
  assert.equal(minedCount(db, project.id), 1);

  // Another child takes a live lease on the same chunk.
  const { childId: otherChild } = parentChild(controller, project.id, [ids[0]!]);
  claim(controller, otherChild, 'owner-b');

  const result = controller.claimChild(childId, 'owner-a', {
    expectedStageFingerprints: { 'entities-facts': 'changed-generation' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'overlap');
  assert.equal(controller.getChild(childId)!.status, 'complete', 'the child is not mutated');
  assert.equal(minedCount(db, project.id), 1, 'the window stays published');
  db.close();
});

test('a legitimate reopen makes its chunks minable again', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-reopen-mined');
  const ids = projectChunks(db, project.id);
  const controller = new RecoveryController(db, { leaseMs: 60_000, heartbeatMs: 60_000, backoffMs: [1] });
  const { childId } = parentChild(controller, project.id, [ids[0]!]);
  completeChild(controller, project.id, childId);
  assert.equal(minedCount(db, project.id), 1);

  const reopened = controller.claimChild(childId, 'owner-a', {
    expectedStageFingerprints: { 'entities-facts': 'changed-generation' },
  });
  assert.equal(reopened.ok, true);
  assert.equal(controller.getChild(childId)!.status, 'running');
  assert.equal(minedCount(db, project.id), 0, 'the reopened window can be read again');
  db.close();
});

test('a fenceless or stale deferral cannot expire a live lease', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'recovery-defer-auth');
  const controller = new RecoveryController(db, { leaseMs: 60_000, heartbeatMs: 60_000, backoffMs: [1] });
  const { childId } = parentChild(controller, project.id, projectChunks(db, project.id));
  const fingerprint = stageFingerprint();
  const fencing = setFingerprint(controller, childId, 'entities-facts', fingerprint);
  assert.throws(
    () =>
      controller.deferStage({
        childId,
        projectId: project.id,
        stage: 'entities-facts',
        fingerprint,
        reason: 'no-ownership',
      } as never),
    /stale-fencing/,
  );
  const before = db.get<{ lease_until: string }>(
    'SELECT lease_until FROM extraction_chunk_lease WHERE child_id = ? LIMIT 1',
    childId,
  )!;
  assert.ok(Date.parse(before.lease_until) > Date.now(), 'the original lease is still live');
  assert.equal(controller.getChild(childId)!.status, 'running');
  assert.throws(
    () =>
      controller.deferStage({
        childId,
        projectId: project.id,
        stage: 'entities-facts',
        fingerprint,
        owner: 'owner-a',
        fencing: fencing + 1,
        reason: 'stale',
      }),
    /stale-fencing/,
  );
  assert.equal(controller.getChild(childId)!.status, 'running');
  db.close();
});

test('the default policy is the approved bounded three-attempt policy', () => {
  assert.equal(DEFAULT_RECOVERY_POLICY.maxAttempts, 3);
  assert.equal(DEFAULT_RECOVERY_POLICY.leaseMs, 300_000);
  assert.deepEqual(DEFAULT_RECOVERY_POLICY.backoffMs, [1_000, 2_000]);
});
