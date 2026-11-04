/**
 * Re-running canon-event extraction over the same passage must not duplicate
 * an event. The schema has no unique index in this phase, so the guard is in
 * code: (project, source, chunk, title) identifies one narrated happening.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedProject, tempDb, mockProvider } from './helpers.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';

test('a second extractCanonEvents run adds zero events', async () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const llm = mockProvider(() =>
    JSON.stringify([
      {
        title: 'The same event',
        summary: 'one happening',
        participants: [],
        location: '',
        time_label: '',
        kind: 'event',
        chunk_index: 0,
      },
    ]),
  );

  const first = await lore.extractCanonEvents(db, llm as never, project.id, { windowSize: 8 });
  assert.ok(first.length > 0, 'the first run indexes events');
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_event WHERE project_id = ?', project.id)!.n;

  const second = await lore.extractCanonEvents(db, llm as never, project.id, { windowSize: 8 });
  assert.equal(second.length, 0, 'the second run creates nothing');
  const after = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_event WHERE project_id = ?', project.id)!.n;
  assert.equal(after, before, 'no duplicate rows');
  db.close();
});
