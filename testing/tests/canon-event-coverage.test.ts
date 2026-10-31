/**
 * The canon event index must cover the whole source unless a caller asks for
 * less. The old implicit ceiling of 200 passages read a 527-chunk book only to
 * passage 200 and stopped before the Sorting, which silently made every later
 * event invisible to planning and continuity.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { seedProject, tempDb, mockProvider } from './helpers.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';

/** Add `n` extra passages after the fixture's own, with known seqs. */
function addChunks(db: ReturnType<typeof tempDb>['db'], projectId: number, n: number, startSeq: number): void {
  const source = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ? LIMIT 1', projectId);
  assert.ok(source, 'fixture import must create a source');
  const now = new Date().toISOString();
  for (let i = 0; i < n; i++) {
    const seq = startSeq + i;
    db.run(
      `INSERT INTO canon_chunk (project_id, source_id, seq, locator, heading, text, char_start, char_end, words, lore_mined)
       VALUES (?, ?, ?, ?, '', ?, 0, 0, 5, 0)`,
      projectId,
      source.id,
      seq,
      `PASSAGE ${seq}`,
      `Passage number ${seq} mentions a traveller and a river.`,
    );
  }
  void now;
}

/** Answer with one event per window, attached to the last passage offered. */
const lastPassage = (req: { messages: { content: string }[] }): number => {
  const body = req.messages.map((m) => m.content).join('\n');
  const hits = [...body.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
  return hits.length ? Math.max(...hits) : 0;
};

test('the event index reads past passage 200 when no limit is given', async () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const fixtureChunks = db.get<{ n: number }>('SELECT count(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)!;
  addChunks(db, project.id, 250, fixtureChunks.n);

  const llm = mockProvider((req) => {
    const idx = lastPassage(req as { messages: { content: string }[] });
    return JSON.stringify([
      { title: `Event at ${idx}`, summary: 'a passage', participants: [], location: '', time_label: '', kind: 'event', chunk_index: idx },
    ]);
  });

  const created = await lore.extractCanonEvents(db, llm as never, project.id, { windowSize: 8 });
  assert.ok(created.length > 0, 'events are extracted');
  const maxSeq = db.get<{ m: number }>(
    `SELECT max(c.seq) AS m FROM canon_event e JOIN canon_chunk c ON c.id = e.chunk_id WHERE e.project_id = ?`,
    project.id,
  )!.m;
  assert.ok(maxSeq > 200, `expected coverage past passage 200, max event passage was ${maxSeq}`);
});

test('an explicit chunkLimit still bounds the index', async () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const fixtureChunks = db.get<{ n: number }>('SELECT count(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)!;
  addChunks(db, project.id, 250, fixtureChunks.n);

  const llm = mockProvider((req) => {
    const idx = lastPassage(req as { messages: { content: string }[] });
    return JSON.stringify([
      { title: `Event at ${idx}`, summary: 'a passage', participants: [], location: '', time_label: '', kind: 'event', chunk_index: idx },
    ]);
  });

  await lore.extractCanonEvents(db, llm as never, project.id, { windowSize: 8, chunkLimit: 12 });
  const maxSeq = db.get<{ m: number }>(
    `SELECT max(c.seq) AS m FROM canon_event e JOIN canon_chunk c ON c.id = e.chunk_id WHERE e.project_id = ?`,
    project.id,
  )!.m;
  assert.ok(maxSeq < 12, `expected the limit to hold, max event passage was ${maxSeq}`);
});

test('the event index is not capped at 200 events', async () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const fixtureChunks = db.get<{ n: number }>('SELECT count(*) AS n FROM canon_chunk WHERE project_id = ?', project.id)!;
  addChunks(db, project.id, 250, fixtureChunks.n);

  // One event for every passage offered, so the run produces far more than
  // the old 200-event ceiling.
  const llm = mockProvider((req) => {
    const body = (req as { messages: { content: string }[] }).messages.map((m) => m.content).join('\n');
    const hits = [...body.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
    return JSON.stringify(
      [...new Set(hits)].map((idx) => ({
        title: `Event at ${idx}`,
        summary: 'a passage',
        participants: [],
        location: '',
        time_label: '',
        kind: 'event',
        chunk_index: idx,
      })),
    );
  });

  const created = await lore.extractCanonEvents(db, llm as never, project.id, { windowSize: 8 });
  assert.ok(created.length > 200, `expected more than 200 events, got ${created.length}`);
  const maxSeq = db.get<{ m: number }>(
    `SELECT max(c.seq) AS m FROM canon_event e JOIN canon_chunk c ON c.id = e.chunk_id WHERE e.project_id = ?`,
    project.id,
  )!.m;
  assert.ok(maxSeq > 200, `expected events past passage 200, max was ${maxSeq}`);
});

test('a chapter heading is not indexed as an event', async () => {
  const { db } = tempDb();
  const project = seedProject(db);
  const llm = mockProvider(() =>
    JSON.stringify([
      { title: 'Chapter One', summary: 'a heading', participants: [], location: '', time_label: '', kind: 'scene', chunk_index: 0 },
      { title: 'A Real Event', summary: 'something happens', participants: [], location: '', time_label: '', kind: 'scene', chunk_index: 0 },
    ]),
  );
  await lore.extractCanonEvents(db, llm as never, project.id, { windowSize: 8 });
  const titles = db.all<{ title: string }>('SELECT title FROM canon_event WHERE project_id = ?', project.id).map((r) => r.title);
  assert.ok(titles.includes('A Real Event'), 'the real event is kept');
  assert.ok(!titles.some((t) => /chapter/i.test(t)), `heading was indexed: ${titles.join(', ')}`);
});
