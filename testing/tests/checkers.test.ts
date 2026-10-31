/**
 * Checker package tests: convergence corroboration + quarantine judge.
 *
 * Mock/fixture only — no Ollama:
 *
 *   - orderCorroborated floats a twice-reached passage above an adjacent
 *     single-seed one, one slot max, chunk-id tie-break
 *   - fixture integration: stats.corroborated values + shared passage ranks
 *   - single seed skips the extra walks (stats absent)
 *   - judge merges with a verifying quote (aliases folded, relations moved)
 *   - judge refuses a same:true with no proving quote
 *   - co-speaker veto overrules a same:true verdict
 *   - model throw leaves every pair pending
 *   - maxPairs caps the batch; dossiers carry both entities' evidence
 *   - migration v10 applies to a copied fixture DB with a quarantine round-trip
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import * as graph from '../../fanfable/src/graph.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { quarantineReport } from '../../fanfable/src/answer/lore-diagnostics.ts';
import { Db } from '../../fanfable/src/db.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const RIDGE_QUOTE = 'Serena Marsh watched it from the ridge';
const KADE_QUOTE = 'said Kade behind her';

test('orderCorroborated floats one slot with chunk-id ties', () => {
  const out = graph.orderCorroborated([
    { chunkId: 1, score: 0.5, seeds: 1 },
    { chunkId: 2, score: 0.49, seeds: 2 },
    { chunkId: 3, score: 0.1, seeds: 1 },
  ]);
  assert.deepEqual(
    out.map((c) => c.chunkId),
    [2, 1, 3],
    'the twice-reached passage rises exactly one slot',
  );
  const tied = graph.orderCorroborated([
    { chunkId: 9, score: 0.2, seeds: 1 },
    { chunkId: 4, score: 0.2, seeds: 1 },
  ]);
  assert.deepEqual(
    tied.map((c) => c.chunkId),
    [4, 9],
    'exact ties break by chunk id',
  );
  const stable = graph.orderCorroborated([
    { chunkId: 1, score: 0.5, seeds: 2 },
    { chunkId: 2, score: 0.4, seeds: 1 },
  ]);
  assert.deepEqual(
    stable.map((c) => c.chunkId),
    [1, 2],
    'no swap when order already holds',
  );
});

/** Alpha + Beta triple seeds; chunk 3 referenced by both. */
function convergenceProject() {
  const { db } = tempDb();
  const project = seedProject(db, 'checkers-convergence');
  const chunks = db.all<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ? ORDER BY seq', project.id);
  const addEntity = (name: string, chunkIds: number[]): number =>
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      project.id,
      'character',
      name,
      name,
      JSON.stringify(chunkIds.map((id) => ({ source: 's', locator: 'l', chunk: id }))),
      AT,
      AT,
    ).lastInsertRowid;
  const a = addEntity('Alpha', [chunks[0]!.id, chunks[2]!.id]);
  const b = addEntity('Beta', [chunks[1]!.id, chunks[2]!.id]);
  db.run(
    'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id,
    a,
    b,
    'sibling of',
    'Beta is the sibling here.',
    AT,
  );
  return { db, project, chunks };
}

test('convergence stats agree with the ranking', async () => {
  const { db, project, chunks } = convergenceProject();
  const ctx = await graph.buildPprGraphContext(db, project.id, {
    query: 'Alpha sibling Beta',
    focus: ['Alpha'],
    hops: 1,
  });
  assert.equal(ctx.stats.seedVia, 'triple', 'two seeds');
  assert.deepEqual(ctx.stats.corroborated, { passages: 1, maxSeeds: 2 });
  assert.deepEqual(
    ctx.passages.map((p) => p.chunkId),
    [chunks[2]!.id, chunks[0]!.id, chunks[1]!.id],
    'the shared passage ranks first',
  );
  db.close();
});

test('a single seed skips the extra walks', async () => {
  const { db, project } = convergenceProject();
  const ctx = await graph.buildPprGraphContext(db, project.id, {
    query: 'Alpha',
    focus: ['Alpha'],
    hops: 1,
  });
  assert.equal(ctx.stats.seedVia, 'entity', 'one seed');
  assert.equal(ctx.stats.corroborated, undefined, 'no convergence to audit');
  db.close();
});

/** Bram / Bram Vale pair with evidence, quarantined and pending. */
function quarantineProject(dbName: string, speakerScene: boolean) {
  const { db } = tempDb();
  const project = seedProject(db, dbName);
  const source = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ?', project.id)!;
  if (speakerScene) {
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words) VALUES (?, ?, 99, ?, ?, ?, 0, 60, 10)',
      source.id,
      project.id,
      'test scene',
      '',
      'Bram said hello first. Then Bram Vale asked why.',
    );
  }
  const addEntity = (name: string, evidence: string): number =>
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      project.id,
      'character',
      name,
      evidence,
      JSON.stringify([{ source: 'sample', locator: 'ch1', chunk: 1 }]),
      AT,
      AT,
    ).lastInsertRowid;
  const bram = addEntity('Bram', RIDGE_QUOTE);
  const vale = addEntity('Bram Vale', KADE_QUOTE);
  const cade = addEntity('Cade', 'Cade keeps the bridge.');
  db.run(
    'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    project.id,
    vale,
    cade,
    'knows',
    'Bram Vale knows Cade.',
    AT,
  );
  const persisted = lorebook.persistQuarantine(db, project.id, [
    { name: 'Bram', candidate: 'Bram Vale', reason: 'test pair' },
  ]);
  assert.equal(persisted.written, 1, 'pair persisted');
  return { db, project, bram, vale, cade };
}


test('judge merges with a verifying quote', async () => {
  const { db, project, bram, vale, cade } = quarantineProject('checkers-merge', false);
  const seen: string[] = [];
  // NOTE: mock keys are prompt ids; the mock answers same:true for Bram Vale.
  const llm = mockProvider((req) => {
    seen.push(req.messages.map((m) => m.content).join('\n'));
    return JSON.stringify({
      rulings: [{ name: 'Bram', candidate: 'Bram Vale', same: true, quote: RIDGE_QUOTE }],
    });
  });
  const { rulings, checked } = await lorebook.judgeQuarantine(llm, db, project.id, {});
  assert.equal(checked, 1, 'one pair judged in one call');
  assert.deepEqual(
    rulings.map((r) => [r.name, r.candidate, r.verdict]),
    [['Bram', 'Bram Vale', 'merged']],
  );
  assert.ok(rulings[0]!.quote.includes('ridge'), 'the proof quote is logged');
  // Bram Vale (longer) keeps; Bram folds in.
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND name = ?', project.id, 'Bram')
      ?.n,
    0,
    'loser deleted',
  );
  const winner = db.get<{ aliases: string }>('SELECT aliases FROM canon_entity WHERE project_id = ? AND name = ?', project.id, 'Bram Vale')!;
  assert.ok(JSON.parse(winner.aliases).includes('Bram'), 'alias folded');
  const moved = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ? AND (from_entity = ? OR to_entity = ?)',
    project.id,
    db.get<{ id: number }>('SELECT id FROM canon_entity WHERE project_id = ? AND name = ?', project.id, 'Bram Vale')!.id,
    db.get<{ id: number }>('SELECT id FROM canon_entity WHERE project_id = ? AND name = ?', project.id, 'Bram Vale')!.id,
  )?.n;
  assert.equal(moved, 1, 'relation moved to the winner');
  const row = db.get<{ status: string; ruling: string }>(
    'SELECT status, ruling FROM quarantine_alias WHERE project_id = ? AND name = ?',
    project.id,
    'Bram',
  )!;
  assert.equal(row.status, 'merged', 'row marked merged');
  const report = quarantineReport(db, project.id);
  assert.ok(report.some((r) => r.name === 'Bram' && r.status === 'merged'), 'diagnostics list the ruling');
  assert.ok(seen[0]!.includes(RIDGE_QUOTE), 'dossier carries evidence');
  db.close();
});

test('judge refuses a verdict with no proving quote', async () => {
  const { db, project } = quarantineProject('checkers-refuse', false);
  const llm = mockProvider(() =>
    JSON.stringify({
      rulings: [{ name: 'Bram', candidate: 'Bram Vale', same: true, quote: 'a dragon never seen anywhere' }],
    }),
  );
  const { rulings } = await lorebook.judgeQuarantine(llm, db, project.id, {});
  assert.deepEqual(
    rulings.map((r) => [r.verdict, r.reason]),
    [['skipped', 'unproven']],
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', project.id)?.n,
    3,
    'nothing merged, nothing deleted',
  );
  assert.equal(
    db.get<{ status: string }>('SELECT status FROM quarantine_alias WHERE project_id = ?', project.id)?.status,
    'skipped',
    'row marked skipped',
  );
  db.close();
});

test('co-speaker veto overrules a same:true verdict', async () => {
  const { db, project } = quarantineProject('checkers-veto', true);
  const llm = mockProvider(() =>
    JSON.stringify({
      rulings: [{ name: 'Bram', candidate: 'Bram Vale', same: true, quote: RIDGE_QUOTE }],
    }),
  );
  const { rulings } = await lorebook.judgeQuarantine(llm, db, project.id, {});
  assert.deepEqual(
    rulings.map((r) => [r.verdict, r.reason]),
    [['skipped', 'vetoed']],
  );
  assert.equal(
    db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', project.id)?.n,
    3,
    'vetoed pair stays two people',
  );
  db.close();
});

test('model throw leaves every pair pending', async () => {
  const { db, project } = quarantineProject('checkers-throw', false);
  const llm = mockProvider(() => {
    throw new Error('model is down');
  });
  const { rulings, checked } = await lorebook.judgeQuarantine(llm, db, project.id, {});
  assert.deepEqual(rulings, [], 'no rulings recorded');
  assert.equal(checked, 0, 'nothing judged');
  assert.equal(
    db.get<{ status: string }>('SELECT status FROM quarantine_alias WHERE project_id = ?', project.id)?.status,
    'pending',
    'pair stays pending',
  );
  db.close();
});

test('maxPairs caps the batch and dossiers carry evidence', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'checkers-cap');
  for (const [name, candidate] of [
    ['Bram', 'Bram Vale'],
    ['Cade', 'Cade Marl'],
    ['Dain', 'Dain Vale'],
  ]) {
    for (const n of [name, candidate]) {
      db.run(
        'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        project.id,
        'character',
        n,
        `${n} appears here.`,
        JSON.stringify([]),
        AT,
        AT,
      );
    }
  }
  const persisted = lorebook.persistQuarantine(db, project.id, [
    { name: 'Bram', candidate: 'Bram Vale', reason: 't' },
    { name: 'Cade', candidate: 'Cade Marl', reason: 't' },
    { name: 'Dain', candidate: 'Dain Vale', reason: 't' },
  ]);
  assert.equal(persisted.written, 3, 'three pairs pending');
  const seen: string[] = [];
  const llm = mockProvider((req) => {
    seen.push(req.messages.map((m) => m.content).join('\n'));
    return JSON.stringify({ rulings: [] });
  });
  const { checked } = await lorebook.judgeQuarantine(llm, db, project.id, { maxPairs: 2 });
  assert.equal(checked, 2, 'two pairs judged');
  assert.equal(seen.length, 1, 'still one model call');
  assert.equal((seen[0]!.match(/Pair: /g) ?? []).length, 2, 'exactly two pairs in the prompt');
  assert.ok(seen[0]!.includes('Bram Vale appears here.'), 'dossier carries evidence');
  const pending = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM quarantine_alias WHERE project_id = ? AND status = 'pending'",
    project.id,
  )?.n;
  assert.equal(pending, 3, 'empty verdicts fail open — all stay pending');
  db.close();
});

test('migration v10 applies to a copied fixture DB with a quarantine round-trip', () => {
  const { db, path } = tempDb();
  const project = seedProject(db, 'checkers-migrate');
  db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const name = db.get<{ name: string }>('SELECT name FROM project WHERE id = ?', project.id)?.name;
  db.close();

  const copyPath = join(path, '..', 'old-copy.db');
  copyFileSync(path, copyPath);
  const old = new Db(copyPath);
  old.raw.exec('DROP TABLE quarantine_alias');
  old.raw.exec('PRAGMA user_version = 9');
  old.close();

  const migrated = new Db(copyPath);
  try {
    const version = migrated.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.ok(version.user_version >= 10, 'version advances past the downgrade');
    assert.equal(
      migrated.get<{ name: string }>('SELECT name FROM project WHERE id = ?', project.id)?.name,
      name,
      'project survives',
    );
    const written = migrated.run(
      "INSERT INTO quarantine_alias (project_id, name, candidate, reason, status, created_at) VALUES (?, 'A', 'B', 't', 'pending', ?)",
      project.id,
      AT,
    );
    assert.equal(written.changes, 1, 'row persists');
    migrated.run("UPDATE quarantine_alias SET status = 'merged', ruling = 'same', ruled_at = ? WHERE project_id = ?", AT, project.id);
    assert.equal(
      migrated.get<{ status: string }>('SELECT status FROM quarantine_alias WHERE project_id = ?', project.id)?.status,
      'merged',
      'status transitions persist',
    );
  } finally {
    migrated.close();
  }
});
