/**
 * Flag trust: a full run must not skip text because something else wrote
 * lore_mined, and a window that returned nothing must stay unmined.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { mockProvider, seedProject, tempDb } from './helpers.ts';

const EMPTY = JSON.stringify({ entities: [], relations: [], facts: [], timeline: [] });

function allMined(projectId: number, db: ReturnType<typeof tempDb>['db'], value = 1): void {
  db.run('UPDATE canon_chunk SET lore_mined = ? WHERE project_id = ?', value, projectId);
}

test('a fresh run ignores pre-existing lore_mined flags', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'fresh-flags');
  allMined(project.id, db);
  const messages: string[] = [];
  const stats = await lorebook.extractLore(db, mockProvider(() => EMPTY), project.id, {
    fresh: true,
    maxWindows: 1,
    concurrency: 1,
    onProgress: (m) => messages.push(m),
  });
  assert.equal(stats.windows, 1, 'the window ran despite every flag being set');
  assert.ok(!messages.some((m) => m.includes('skipped')), 'a fresh run skips nothing');
  db.close();
});

test('a non-fresh run skips flagged windows and says so', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'stale-flags');
  allMined(project.id, db);
  const messages: string[] = [];
  const stats = await lorebook.extractLore(db, mockProvider(() => EMPTY), project.id, {
    concurrency: 1,
    onProgress: (m) => messages.push(m),
  });
  assert.equal(stats.windows, 0);
  assert.ok(messages.some((m) => m.startsWith('skipped ')), 'the skip is counted out loud');
  db.close();
});

test('a window whose calls return nothing is not flagged read', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'empty-window');
  const stats = await lorebook.extractLore(db, mockProvider(() => EMPTY), project.id, {
    fresh: true,
    maxWindows: 1,
    concurrency: 1,
  });
  assert.equal(stats.windows, 1);
  const mined = db.get<{ c: number }>(
    'SELECT count(*) c FROM canon_chunk WHERE project_id = ? AND lore_mined = 1',
    project.id,
  )!.c;
  assert.equal(mined, 0, 'an empty-answer window stays unmined for a later retry');
  assert.ok(stats.emptyWindows.some((e) => e.reason === 'empty-answer'), 'and it is recorded as empty');
  db.close();
});
