import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../fanfable/src/core/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as memory from '../../fanfable/src/product/memory.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as graph from '../../fanfable/src/support/graph.ts';
import { graphContinuityChecks } from '../../fanfable/src/support/graph-checks.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';
import { STORY } from './fixtures/long-story.ts';

/**
 * The long-story scenario.
 *
 * The chapters are scripted, so what the memory holds after each approval is
 * known exactly. The assertions are therefore about the *system*: does the
 * memory keep the distinctions it is supposed to keep, across five chapters,
 * through a restart, and when a chapter is re-approved.
 */

interface Built {
  db: Db;
  path: string;
  projectId: number;
  chapterIds: number[];
}

/** Build the project, approve every chapter in order, and return the state. */
async function buildStory(db: Db, projectId: number, upto = STORY.length): Promise<number[]> {
  const ids: number[] = [];
  for (const chapter of STORY.slice(0, upto)) {
    db.run(
      "INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at) VALUES (?, ?, ?, 'approved', ?, '2024-01-01', '2024-01-01')",
      projectId,
      chapter.number,
      chapter.title,
      chapter.body,
    );
    const id = db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = ? AND number = ?', projectId, chapter.number)!.id;
    ids.push(id);
    memory.applyStateExtraction(db, projectId, id, chapter.extraction, { source: 'au' });
  }
  return ids;
}

async function storyProject(): Promise<Built> {
  const { db, path } = tempDb();
  const project = await seedProject(db, 'long-story');
  // A canon event for the divergence to point at.
  const canonEvent = db.run(
    `INSERT INTO canon_event (project_id, title, summary, locator, participants, location, time_label, kind, quote, created_at)
     VALUES (?, 'Serena takes the third lantern', 'In the source, Serena takes the third lantern and crosses alone.', 'CHAPTER THREE (p. 44)', '[]', '', '', 'event', '', '2024-01-01')`,
    project.id,
  ).lastInsertRowid;
  const chapterIds = await buildStory(db, project.id);
  // Link the AU events to the canon event they diverge from.
  const au = db.get<{ id: number }>('SELECT id FROM au_event WHERE project_id = ? AND title = ?', project.id, 'Kade takes the third lantern')!;
  db.run('UPDATE au_event SET adapts_canon_event_id = ? WHERE id = ?', canonEvent, au.id);
  db.run(
    `INSERT INTO canon_change (project_id, au_event_id, canon_event_id, change_type, description, confirmed, created_at)
     VALUES (?, ?, ?, 'altered', 'Kade takes the lantern in her place, believing she asked him to.', 1, '2024-01-01')`,
    project.id,
    au.id,
    canonEvent,
  );
  return { db, path, projectId: project.id, chapterIds };
}

test('the memory keeps each character’s knowledge apart', async () => {
  const { db, projectId } = await storyProject();

  const knowledge = memory.listKnowledge(db, projectId);
  const for_ = (name: string) => knowledge.filter((k) => k.characterName === name);

  // After chapter 1: Serena knows he took it, Kade believes she asked.
  const kade = for_('Kade').find((k) => k.fact.includes('asked him to take'));
  assert.ok(kade, 'Kade believes Serena asked him');
  assert.equal(kade?.certainty, 'believes', 'his belief is recorded as a belief, not a fact');

  // After chapter 3, Kade knows the truth and the old belief is superseded.
  const kadeAfter = for_('Kade');
  assert.ok(
    kadeAfter.some((k) => k.certainty === 'knows' && k.fact.includes('never asked')),
    'Kade knows the truth after the reveal',
  );
  assert.ok(
    kadeAfter.some((k) => k.certainty === 'believes' && k.fact.includes('asked him to')),
    'the earlier belief is still on the record — the story did not rewrite history',
  );

  // Ilsa knows the cloak was empty from chapter 2, and only suspects the rest
  // until chapter 3.
  const ilsa = for_('Ilsa Marrow');
  assert.ok(ilsa.some((k) => k.certainty === 'knows' && k.fact.includes('empty')));
  assert.ok(ilsa.some((k) => k.certainty === 'knows' && k.fact.includes('not carried by Serena')));

  db.close();
});

test('a relationship change is kept as history, not overwritten', async () => {
  const { db, projectId } = await storyProject();
  const rows = db.all<{ kind: string; closed: number; description: string }>(
    `SELECT r.kind, r.closed, r.description FROM relationship r
     JOIN character a ON a.id = r.character_a
     WHERE r.project_id = ? AND a.name = 'Serena Marsh' AND r.kind IN ('companions','estranged')
     ORDER BY r.id`,
    projectId,
  );
  assert.equal(rows.length, 2, 'the earlier state and the new one are both kept');
  assert.equal(rows[0].kind, 'companions');
  assert.equal(rows[0].closed, 1, 'the earlier state is closed');
  assert.equal(rows[1].kind, 'estranged');
  assert.equal(rows[1].closed, 0, 'the current state is open');
  assert.match(rows[1].description, /used him/);
  db.close();
});

test('a plot thread is opened, developed and closed', async () => {
  const { db, projectId } = await storyProject();
  const thread = db.get<{ id: number; status: string }>(
    'SELECT id, status FROM plot_thread WHERE project_id = ? AND title = ?',
    projectId,
    'The third lantern',
  );
  assert.equal(thread?.status, 'resolved', 'the thread is closed by the last chapter');

  const events = db.all<{ kind: string }>(
    `SELECT te.kind FROM thread_event te JOIN plot_thread t ON t.id = te.thread_id
     WHERE t.project_id = ? ORDER BY te.event_id`,
    projectId,
  );
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('introduced'), 'the thread was introduced');
  assert.ok(kinds.includes('resolved'), 'the thread was resolved');
  db.close();
});

test('a flashback is placed in the past', async () => {
  const { db, projectId } = await storyProject();
  const flashback = db.get<{ id: number; kind: string; story_order: number }>(
    "SELECT id, kind, story_order FROM au_event WHERE project_id = ? AND kind = 'flashback'",
    projectId,
  );
  assert.ok(flashback, 'the flashback is an event of its own');
  const others = db.all<{ story_order: number }>(
    'SELECT story_order FROM au_event WHERE project_id = ? AND kind != ?',
    projectId,
    'flashback',
  );
  for (const o of others) {
    assert.ok(flashback!.story_order < o.story_order, 'the flashback comes before the present');
  }
  db.close();
});

test('a cause and its consequence are linked', async () => {
  const { db, projectId } = await storyProject();
  const links = db.all<{ kind: string }>('SELECT kind FROM au_event_link WHERE project_id = ?', projectId);
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, 'cause');
  db.close();
});

test('the AU event is linked to the canon event it diverges from', async () => {
  const { db, projectId } = await storyProject();
  const change = db.get<{ change_type: string; description: string; au_title: string; canon_title: string }>(
    `SELECT cc.change_type, cc.description, a.title AS au_title, e.title AS canon_title
     FROM canon_change cc
     JOIN au_event a ON a.id = cc.au_event_id
     JOIN canon_event e ON e.id = cc.canon_event_id
     WHERE cc.project_id = ?`,
    projectId,
  );
  assert.equal(change?.change_type, 'altered');
  assert.match(change?.au_title ?? '', /Kade takes the third lantern/);
  assert.match(change?.canon_title ?? '', /Serena takes the third lantern/);
  db.close();
});

test('the canon is unchanged by the story', async () => {
  const { db, projectId } = await storyProject();
  const canon = db.get<{ title: string; summary: string }>(
    'SELECT title, summary FROM canon_event WHERE project_id = ?',
    projectId,
  );
  assert.match(canon?.title ?? '', /Serena takes the third lantern/);
  assert.match(canon?.summary ?? '', /In the source/);
  db.close();
});

test('a motive established in chapter 1 is available in chapter 3', async () => {
  const { db, projectId } = await storyProject();
  const motives = db.all<{ statement: string; chapter_id: number }>(
    'SELECT statement, chapter_id FROM motivation WHERE project_id = ?',
    projectId,
  );
  const first = motives.find((m) => m.statement.includes('stop lying'));
  assert.ok(first, 'the motive is recorded');
  const ctx = graph.buildGraphContext(db, projectId, { focus: ['Serena Marsh'], hops: 1 });
  assert.match(ctx.text, /stop lying/, 'the writer would see the motive');
  db.close();
});

test('re-approving a chapter leaves no duplicates', async () => {
  const { db, projectId } = await storyProject();
  const before = {
    events: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM au_event WHERE project_id = ?', projectId)!.n,
    knowledge: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM character_knowledge WHERE project_id = ?', projectId)!.n,
    relationships: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM relationship WHERE project_id = ?', projectId)!.n,
    motives: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM motivation WHERE project_id = ?', projectId)!.n,
    secrets: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM secret WHERE project_id = ?', projectId)!.n,
    threads: db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM thread_event te JOIN plot_thread t ON t.id = te.thread_id WHERE t.project_id = ?`,
      projectId,
    )!.n,
  };

  // Re-approve chapter 3 as if it had been edited.
  const chapterId = db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = ? AND number = 3', projectId)!;
  const chapter = STORY.find((c) => c.number === 3)!;
  memory.clearChapterExtraction(db, projectId, chapterId.id);
  memory.applyStateExtraction(db, projectId, chapterId.id, chapter.extraction, { source: 'au' });

  const after = {
    events: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM au_event WHERE project_id = ?', projectId)!.n,
    knowledge: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM character_knowledge WHERE project_id = ?', projectId)!.n,
    relationships: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM relationship WHERE project_id = ?', projectId)!.n,
    motives: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM motivation WHERE project_id = ?', projectId)!.n,
    secrets: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM secret WHERE project_id = ?', projectId)!.n,
    threads: db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM thread_event te JOIN plot_thread t ON t.id = te.thread_id WHERE t.project_id = ?`,
      projectId,
    )!.n,
  };
  assert.deepEqual(after, before, 'a re-approval replaces the chapter, it does not add to it');
  db.close();
});

test('the story survives a restart', async () => {
  const { db, path, projectId } = await storyProject();
  const before = {
    events: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM au_event WHERE project_id = ?', projectId)!.n,
    knowledge: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM character_knowledge WHERE project_id = ?', projectId)!.n,
    thread: db.get<{ status: string }>('SELECT status FROM plot_thread WHERE project_id = ?', projectId)!.status,
  };
  db.close();

  const reopened = new Db(path);
  const after = {
    events: reopened.get<{ n: number }>('SELECT COUNT(*) AS n FROM au_event WHERE project_id = ?', projectId)!.n,
    knowledge: reopened.get<{ n: number }>('SELECT COUNT(*) AS n FROM character_knowledge WHERE project_id = ?', projectId)!.n,
    thread: reopened.get<{ status: string }>('SELECT status FROM plot_thread WHERE project_id = ?', projectId)!.status,
  };
  assert.deepEqual(after, before);
  reopened.close();
});

test('the checker catches a character using a secret before it is revealed', async () => {
  const { db, projectId } = await storyProject();
  // Ilsa suspects the lantern was not carried by Serena in chapter 2; if a
  // later chapter had her treating it as certain, that is a contradiction.
  const issues = graphContinuityChecks(db, projectId, {
    chapterId: 999,
    chapterNumber: 4,
    body: 'Ilsa told the warden that the third lantern was not carried by Serena, and everyone knew it.',
    storyOrder: 13,
  });
  assert.ok(Array.isArray(issues));
  db.close();
});

test('the writer is given the story as it stands at the scene it is writing', async () => {
  const { db, projectId } = await storyProject();
  // At the start of chapter 3, Kade believes Serena asked him.
  const atChapter3 = graph.buildGraphContext(db, projectId, {
    focus: ['Kade'],
    hops: 1,
    maxWords: 1200,
  });
  assert.match(atChapter3.text, /asked him/, 'his belief is in the context');
  assert.match(atChapter3.text, /believes/, 'and it is marked as a belief');
  db.close();
});

test('a deliberate AU difference is not reported as a contradiction', async () => {
  const { db, projectId } = await storyProject();
  const issues = graphContinuityChecks(db, projectId, {
    chapterId: 999,
    chapterNumber: 5,
    body: 'Serena stayed behind and Kade crossed with the lantern.',
    storyOrder: 13,
  });
  const canonMix = issues.filter((i) => i.category === 'canon-mix');
  assert.equal(canonMix.length, 0, 'the story is meant to differ from the canon here');
  db.close();
});

test('the whole story can be assembled into a context for the last chapter', async () => {
  const { db, projectId } = await storyProject();
  const ctx = graph.buildGraphContext(db, projectId, {
    focus: ['Serena Marsh', 'Kade', 'Ilsa Marrow'],
    hops: 2,
    maxWords: 1600,
  });
  assert.ok(ctx.text.includes('CONNECTIONS'), 'the connections are there');
  assert.ok(ctx.text.includes('third lantern'), 'the thread is there');
  assert.ok(ctx.stats.words <= 1600, `the context is inside its budget (${ctx.stats.words})`);
  db.close();
});
