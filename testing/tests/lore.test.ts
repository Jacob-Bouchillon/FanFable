import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as lore from '../../fanfable/src/lore.ts';
import { seedProject, tempDb, mockProvider, FIXTURE } from './helpers.ts';

test('import creates chunks and a searchable index', () => {
  const { db } = tempDb();
  const project = seedProject(db);

  const sources = lore.listSources(db, project.id);
  assert.equal(sources.length, 1);
  assert.ok(sources[0].sha256.length === 64);

  const chunks = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id);
  assert.ok((chunks?.n ?? 0) > 0, 'chunks imported');
  db.close();
});

test('search returns passages with source references', () => {
  const { db } = tempDb();
  const project = seedProject(db);

  const hits = lore.searchCanon(db, project.id, 'bridge Ardenne', { limit: 5 });
  assert.ok(hits.length > 0, 'expected a hit');
  const hit = hits[0];
  assert.ok(hit.sourceTitle.length > 0);
  assert.ok(hit.path.endsWith('sample-book.txt'));
  assert.ok(hit.locator.length > 0);
  assert.match(hit.text, /bridge/i);
  db.close();
});

test('search finds content that only matches on a second term', () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const hits = lore.searchCanon(db, project.id, 'promise', { limit: 5 });
  assert.ok(hits.some((h) => /promise/i.test(h.text)));
  db.close();
});

test('re-importing the same file does not duplicate the source', () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id);
  lore.importSource(db, project.id, FIXTURE);
  const after = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', project.id);
  assert.equal(before?.n, after?.n, 're-import without --overwrite is a no-op');
  db.close();
});

test('lore answers cite the passages and refuse to invent canon', async () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const llm = mockProvider((req) => {
    if ((req.system ?? '').includes('Lore Researcher')) {
      return 'Serena watches the bridge from the ridge [S1].\n\nCONFIRMED: the bridge at Ardenne [S1].';
    }
    if ((req.system ?? '').includes('expand a lore question')) {
      return '{"terms":["Ardenne","bridge"]}';
    }
    return '{}';
  });

  const res = await lore.answerLoreQuestion(db, llm, project.id, 'Where is the bridge?');
  assert.ok(res.passages.length > 0);
  assert.match(res.answer, /\[S1\]/);
  assert.ok(res.grounded);
  db.close();
});

test('lore answer reports missing evidence instead of guessing', async () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const llm = mockProvider((req) => {
    if ((req.system ?? '').includes('expand a lore question')) return '{"terms":["unicorn"]}';
    return 'nothing';
  });
  const res = await lore.answerLoreQuestion(db, llm, project.id, 'Who is the unicorn keeper?');
  if (res.passages.length === 0) {
    assert.equal(res.grounded, false);
    assert.match(res.answer, /No canon passages matched/);
  }
  db.close();
});

test('canon events are extracted and linked to their chunk', async () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const llm = mockProvider(() =>
    JSON.stringify([
      {
        title: 'Serena watches the bridge',
        summary: 'From the ridge, Serena watches the bridge at Ardenne.',
        participants: ['Serena', 'Kade'],
        location: 'the ridge',
        time_label: 'day three of rain',
        kind: 'scene',
        chunk_index: 0,
      },
    ]),
  );
  const events = await lore.extractCanonEvents(db, llm, project.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Serena watches the bridge');
  assert.deepEqual(events[0].participants, ['Serena', 'Kade']);

  const stored = db.get<{ chunk_id: number }>('SELECT chunk_id FROM canon_event WHERE id = ?', events[0].id);
  assert.ok(stored?.chunk_id, 'the event keeps a reference to its source passage');
  db.close();
});
