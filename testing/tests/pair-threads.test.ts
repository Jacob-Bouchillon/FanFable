/**
 * Code-only pair threads: every co-occurring pair gets a thread, no model.
 * Generic names only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject } from '../../fanfable/src/controller.ts';
import { buildPairThreads } from '../../fanfable/src/pair-threads.ts';
import { tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
type Db = ReturnType<typeof tempDb>['db'];

function addEntity(
  db: Db,
  projectId: number,
  name: string,
  opts: { aliases?: string[]; kind?: string; reviewStatus?: string } = {},
): number {
  return Number(
    db.run(
      `INSERT INTO canon_entity
         (project_id, kind, name, aliases, role, status, mentions, evidence, source_refs, review_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', '', 1, '', '[]', ?, ?, ?)`,
      projectId,
      opts.kind ?? 'character',
      name,
      JSON.stringify(opts.aliases ?? []),
      opts.reviewStatus ?? 'accepted',
      AT,
      AT,
    ).lastInsertRowid,
  );
}

function addSource(db: Db, projectId: number): number {
  return Number(
    db.run(
      'INSERT INTO canon_source (project_id, path, title, sha256, imported_at) VALUES (?, ?, ?, ?, ?)',
      projectId,
      '/pair-source',
      'Probe',
      'sha-pair',
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
      `p. ${seq}`,
      '',
      text,
      text.split(/\s+/).length,
    ).lastInsertRowid,
  );
}

function setup(name: string) {
  const { db } = tempDb();
  const project = createProject(db, name);
  const source = addSource(db, project.id);
  // Mara carries a title alias; Wren nests inside Wren Hall; Skiv is quarantined.
  // Mara is inserted first so it holds the lower id and stores as a_entity.
  const mara = addEntity(db, project.id, 'Mara Voss', { aliases: ['Captain Mara'] });
  const corin = addEntity(db, project.id, 'Corin Hale');
  const tor = addEntity(db, project.id, 'Tor');
  const wren = addEntity(db, project.id, 'Wren');
  const wrenHall = addEntity(db, project.id, 'Wren Hall');
  const skiv = addEntity(db, project.id, 'Skiv', { reviewStatus: 'quarantined' });
  addChunk(db, project.id, source, 1, 'Mara Voss met Corin Hale at the gate while Skiv watched.');
  addChunk(db, project.id, source, 2, 'Tor waited alone by the wall.');
  addChunk(db, project.id, source, 3, 'Captain Mara argued with Tor about the keys.');
  addChunk(db, project.id, source, 4, 'Wren Hall waited in the corridor.');
  return { db, project: project.id, source, mara, corin, tor, wren, wrenHall, skiv };
}

function threadNames(db: Db, projectId: number): string[] {
  return db
    .all<{ a: string; b: string }>(
      `SELECT fa.name AS a, fb.name AS b FROM canon_pair_thread t
         JOIN canon_entity fa ON fa.id = t.a_entity
         JOIN canon_entity fb ON fb.id = t.b_entity
        WHERE t.project_id = ? ORDER BY a, b`,
      projectId,
    )
    .map((r) => `${r.a}|${r.b}`);
}

test('threads exist for every qualifying distinct pair only', () => {
  const { db, project } = setup('pair-threads-pairs');
  const result = buildPairThreads(db, project);
  assert.equal(result.people, 5);
  assert.equal(result.cooccurringPairs, 2);
  assert.equal(result.pairsWithRows, 2);
  assert.equal(result.unproposedPairs, 2);
  assert.equal(result.threadsCreated, 2);
  assert.deepEqual(threadNames(db, project), ['Mara Voss|Corin Hale', 'Mara Voss|Tor']);
  db.close();
});

test('quarantined and nested pairs are refused', () => {
  const { db, project, skiv } = setup('pair-threads-refusals');
  buildPairThreads(db, project);
  const names = threadNames(db, project).join('\n');
  assert.ok(!names.includes('Skiv'), 'no thread names the quarantined entity');
  assert.ok(!names.includes('Wren'), 'no thread for the nested pair');
  const skivRows = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM canon_pair_thread WHERE project_id = ? AND (a_entity = ? OR b_entity = ?)',
    project,
    skiv,
    skiv,
  )!.n;
  assert.equal(skivRows, 0);
  db.close();
});

test('a rerun creates no duplicates but updates counts', () => {
  const { db, project, source, mara, corin } = setup('pair-threads-idempotent');
  const first = buildPairThreads(db, project);
  assert.equal(first.threadsCreated, 2);
  const second = buildPairThreads(db, project);
  assert.equal(second.threadsCreated, 0);
  assert.equal(second.threadsUpdated, 0);
  assert.equal(second.pairsWithRows, 2);
  addChunk(db, project, source, 5, 'Mara Voss and Corin Hale left together.');
  const third = buildPairThreads(db, project);
  assert.equal(third.threadsCreated, 0);
  assert.equal(third.threadsUpdated, 1);
  assert.equal(third.pairsWithRows, 2);
  const row = db.get<{ cooccur_count: number; shared_chunks: string }>(
    `SELECT cooccur_count, shared_chunks FROM canon_pair_thread
      WHERE project_id = ? AND a_entity = ? AND b_entity = ?`,
    project,
    mara,
    corin,
  )!;
  assert.equal(row.cooccur_count, 2);
  assert.equal((JSON.parse(row.shared_chunks) as unknown[]).length, 2);
  db.close();
});

test('a banked pair leaves the thread but stops being unproposed', () => {
  const { db, project, mara, corin } = setup('pair-threads-proposed');
  buildPairThreads(db, project);
  db.run(
    `INSERT INTO canon_relation
       (project_id, from_entity, to_entity, kind, description, evidence, source_refs, confidence, review_status, created_at)
     VALUES (?, ?, ?, 'friend of', '', '', '[]', 1.0, 'accepted', ?)`,
    project,
    mara,
    corin,
    AT,
  );
  const result = buildPairThreads(db, project);
  assert.equal(result.pairsWithRows, 2);
  assert.equal(result.unproposedPairs, 1);
  db.close();
});

test('the builder never writes relations, notes or hints', () => {
  const { db, project } = setup('pair-threads-clean');
  buildPairThreads(db, project);
  for (const table of ['canon_relation', 'canon_tie_note', 'canon_tie_hint']) {
    assert.equal(
      db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE project_id = ?`, project)!.n,
      0,
      `${table} untouched`,
    );
  }
  db.close();
});
