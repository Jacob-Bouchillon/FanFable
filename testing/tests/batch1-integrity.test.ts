import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve, sep, normalize } from 'node:path';
import { Db } from '../../fanfable/src/db.ts';
import * as controller from '../../fanfable/src/controller.ts';
import * as planner from '../../fanfable/src/planner.ts';
import * as lore from '../../fanfable/src/lore.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { retrieve } from '../../fanfable/src/retrieval.ts';
import { tempDb, seedProject, mockProvider } from './helpers.ts';

test('FKs enforced: deleting a source cascades chunks', () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'fk-test');
  const src = db.run(
    `INSERT INTO canon_source (project_id, path, title, format, sha256, byte_size, page_count, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    project.id, 'p.txt', 'T', 'text', 'abc', 10, 1, new Date().toISOString(),
  ).lastInsertRowid;
  db.run(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words) VALUES (?, ?, 0, 'p1', '', 'hello', 0, 5, 1)`,
    src, project.id,
  );
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)?.n, 1);
  db.run('DELETE FROM canon_source WHERE id = ?', src);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)?.n, 0, 'chunks cascade, no orphans');
  const fk = db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys;
  assert.equal(fk, 1, 'foreign_keys pragma is on');
  db.close();
});

test('failed windows stay unmined and are retryable', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'mined-fail');
  const llm = mockProvider(() => { throw new Error('boom'); });
  const stats = await lorebook.extractLore(db, llm, project.id, { windowSize: 8, concurrency: 1 });
  assert.ok(stats.emptyWindows.length > 0, 'failures recorded with reason');
  assert.ok(stats.emptyWindows.every((e) => e.reason === 'error'));
  const mined = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ? AND lore_mined = 1', project.id)?.n ?? -1;
  assert.equal(mined, 0, 'nothing marked mined on total failure');
  db.close();
});

test('mining runs before the strangers verdict', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'mine-first');
  const now = new Date().toISOString();
  const ent = (name: string): number =>
    db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, name, now, now).lastInsertRowid;
  const a = ent('Serena Marsh');
  const b = ent('Kade');
  // Mining mock banks a direct tie between the two on any relations call.
  let minedTie = false;
  const llm = mockProvider((req) => {
    const sys = req.system ?? '';
    if (sys.includes('extract structured story state') || sys.includes('Continuity Checker')) return '{"issues":[]}';
    return JSON.stringify({ entities: [], facts: [], relations: [], timeline: [] });
  });
  // Pre-state: no tie, so old code would call them strangers before mining.
  const before = await retrieve(db, llm, project.id, { query: 'how are Serena Marsh and Kade related', focus: ['Serena Marsh', 'Kade'] });
  assert.deepEqual(before.stats.strangers, { a: 'Serena Marsh', b: 'Kade' });
  // Bank the tie as mining would, then a fresh query must not call them strangers.
  db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, created_at) VALUES (?, ?, ?, ?, ?)', project.id, a, b, 'sibling of', now);
  const after = await retrieve(db, llm, project.id, { query: 'how are Serena Marsh and Kade related', focus: ['Serena Marsh', 'Kade'] });
  assert.equal(after.stats.strangers, undefined, 'direct tie clears stranger verdict');
  assert.equal(minedTie, false);
  db.close();
});

test('failed chapter write leaves no ghost placeholder', async () => {
  const { db } = tempDb();
  const project = controller.createProject(db, 'ghost-test');
  lore.importSource(db, project.id, resolve(import.meta.dirname, 'fixtures/sample-book.txt'));
  const outline = planner.saveOutline(db, project.id, {
    premise: 'p',
    chapters: [{
      number: 1,
      title: 'One',
      goal: 'g',
      synopsis: 's',
      scenes: [],
      characters: [],
      characterArcs: '',
      canonEventIds: [],
      notes: '',
      targetWords: 0,
    }],
  });
  planner.approveOutline(db, project.id, outline.id);
  const llm = mockProvider(() => { throw new Error('writer down'); });
  await assert.rejects(() => controller.writeChapter(db, llm, project.id, { chapterNumber: 1, skipContinuity: true }));
  assert.equal(controller.listChapters(db, project.id).length, 0, 'placeholder cleaned up, numbering does not skip');
  db.close();
});

test('static jail keeps /ui/../ outside the UI dir', () => {
  const UI_DIR = resolve('/tmp/fanfable-ui');
  const reqPath = decodeURIComponent('/../server.ts');
  const cleaned = normalize(reqPath).replace(/^(\.\.[\\/])+/, '');
  const file = resolve(UI_DIR, cleaned);
  const inside = file === UI_DIR || file.startsWith(UI_DIR + sep);
  assert.equal(inside, false, 'traversal escapes and must be rejected with 403');
});
