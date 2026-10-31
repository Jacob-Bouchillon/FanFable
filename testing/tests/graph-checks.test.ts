import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphContinuityChecks } from '../../fanfable/src/support/graph-checks.ts';
import * as memory from '../../fanfable/src/product/memory.ts';
import { seedProject, tempDb } from './helpers.ts';

interface Ctx {
  db: ReturnType<typeof tempDb>['db'];
  projectId: number;
}

function scenario(name: string, build: (ctx: Ctx) => void): Ctx {
  const { db } = tempDb();
  const project = seedProject(db, name);
  const ctx: Ctx = { db, projectId: project.id };
  build(ctx);
  return ctx;
}

function addChapter(ctx: Ctx, number: number): number {
  ctx.db.run(
    "INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at) VALUES (?, ?, 'One', 'draft', 'text', '2024-01-01', '2024-01-01')",
    ctx.projectId,
    number,
  );
  return ctx.db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = ? AND number = ?', ctx.projectId, number)!.id;
}

function addEvent(ctx: Ctx, title: string, order: number, location = ''): number {
  const r = ctx.db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (?, 1, ?, '', '', ?, '[]', ?, 'event', '', '2024-01-01')`,
    ctx.projectId,
    title,
    order,
    location,
  );
  return r.lastInsertRowid;
}

const input = (body = 'text', order = 1) => ({
  chapterId: 1,
  chapterNumber: 1,
  body,
  storyOrder: order,
});

test('a character who uses a fact before learning it is flagged', () => {
  const ctx = scenario('gc-knowledge', ({ db, projectId }) => {
    const chapterId = addChapter({ db, projectId }, 1);
    const serena = memory.upsertCharacter(db, projectId, 'Serena Marsh');
    const later = addEvent({ db, projectId }, 'Serena learns the truth', 5);
    memory.addKnowledge(db, projectId, {
      characterId: serena,
      fact: 'the Choosing Cap was poisoned by Dain',
      topic: 'the cap',
      certainty: 'knows',
      source: 'au',
      auEventId: later,
    });
    void chapterId;
  });

  const issues = graphContinuityChecks(
    ctx.db,
    ctx.projectId,
    input('Serena turned to Dain and said the Choosing Cap had been poisoned.', 1),
  );
  const found = issues.find((i) => i.category === 'knowledge');
  assert.ok(found, 'the knowledge conflict is found');
  assert.match(found!.message, /before the event/);
  ctx.db.close();
});

test('knowledge learned before the chapter is not flagged', () => {
  const ctx = scenario('gc-knowledge-ok', ({ db, projectId }) => {
    addChapter({ db, projectId }, 1);
    const serena = memory.upsertCharacter(db, projectId, 'Serena Marsh');
    const earlier = addEvent({ db, projectId }, 'Serena learns the truth', 1);
    memory.addKnowledge(db, projectId, {
      characterId: serena,
      fact: 'the Choosing Cap was poisoned by Dain',
      certainty: 'knows',
      source: 'au',
      auEventId: earlier,
    });
  });

  const issues = graphContinuityChecks(
    ctx.db,
    ctx.projectId,
    input('Serena turned to Dain and said the Choosing Cap had been poisoned.', 3),
  );
  assert.ok(!issues.some((i) => i.category === 'knowledge'), 'no false alarm');
  ctx.db.close();
});

test('an event that happens before its cause is flagged', () => {
  const ctx = scenario('gc-order', ({ db, projectId }) => {
    addChapter({ db, projectId }, 1);
    const cause = addEvent({ db, projectId }, 'The potion is drunk', 3);
    const effect = addEvent({ db, projectId }, 'The potion takes effect', 1);
    db.run(
      `INSERT INTO au_event_link (project_id, from_event_id, to_event_id, kind, description, confidence, created_at)
       VALUES (?, ?, ?, 'cause', 'drinking causes the effect', 1.0, '2024-01-01')`,
      projectId,
      cause,
      effect,
    );
  });

  const issues = graphContinuityChecks(ctx.db, ctx.projectId, input());
  const found = issues.find((i) => i.category === 'chronology');
  assert.ok(found, 'the impossible order is found');
  assert.match(found!.message, /cause/);
  ctx.db.close();
});

test('a relationship that changes without a cause is flagged', () => {
  const ctx = scenario('gc-relationship', ({ db, projectId }) => {
    addChapter({ db, projectId }, 1);
    const a = memory.upsertCharacter(db, projectId, 'Serena');
    const b = memory.upsertCharacter(db, projectId, 'Kade');
    db.run(
      `INSERT INTO relationship (project_id, character_a, character_b, kind, description, sentiment, source, chapter_id, closed, updated_at)
       VALUES (?, ?, ?, 'friend', '', '', 'au', NULL, 1, '2024-01-01')`,
      projectId,
      a,
      b,
    );
    db.run(
      `INSERT INTO relationship (project_id, character_a, character_b, kind, description, sentiment, source, chapter_id, closed, updated_at)
       VALUES (?, ?, ?, 'estranged', '', '', 'au', NULL, 0, '2024-01-02')`,
      projectId,
      a,
      b,
    );
  });

  const issues = graphContinuityChecks(ctx.db, ctx.projectId, input());
  const found = issues.find((i) => i.category === 'relationship');
  assert.ok(found, 'the unexplained change is found');
  ctx.db.close();
});

test('a character recorded in the wrong place is flagged', () => {
  const ctx = scenario('gc-location', ({ db, projectId }) => {
    addChapter({ db, projectId }, 1);
    const serena = memory.upsertCharacter(db, projectId, 'Serena');
    const event = addEvent({ db, projectId }, 'The crossing', 1, 'the far bank');
    memory.addCharacterState(db, projectId, serena, {
      location: 'the ridge',
      asOfEventId: event,
      source: 'au',
    });
  });

  const issues = graphContinuityChecks(ctx.db, ctx.projectId, input());
  const found = issues.find((i) => i.category === 'location');
  assert.ok(found, 'the location conflict is found');
  ctx.db.close();
});

test('a divergence that is contradicted by the story is flagged', () => {
  const ctx = scenario('gc-divergence', ({ db, projectId }) => {
    addChapter({ db, projectId }, 1);
    const canonEvent = db.run(
      `INSERT INTO canon_event (project_id, title, summary, locator, participants, location, time_label, kind, quote, created_at)
       VALUES (?, 'The fall of Voldemort', '', '', '[]', '', '', 'event', '', '2024-01-01')`,
      projectId,
    ).lastInsertRowid;
    const au = addEvent({ db, projectId }, 'Voldemort is stopped', 2);
    db.run(
      `INSERT INTO canon_change (project_id, au_event_id, canon_event_id, change_type, description, confirmed, created_at)
       VALUES (?, ?, ?, 'prevented', 'the fall of Voldemort is prevented', 0, '2024-01-01')`,
      projectId,
      au,
      canonEvent,
    );
    // ...but later in the story, the canon event happens anyway.
    const later = addEvent({ db, projectId }, 'Voldemort falls anyway', 4);
    db.run('UPDATE au_event SET adapts_canon_event_id = ? WHERE id = ?', canonEvent, later);
  });

  const issues = graphContinuityChecks(ctx.db, ctx.projectId, input());
  const found = issues.find((i) => i.category === 'canon-mix');
  assert.ok(found, 'the contradiction is found');
  ctx.db.close();
});

test('a thread marked resolved without an event is flagged', () => {
  const ctx = scenario('gc-thread', ({ db, projectId }) => {
    addChapter({ db, projectId }, 1);
    memory.upsertThread(db, projectId, 'The third lantern', 'why she took it', 'resolved');
  });

  const issues = graphContinuityChecks(ctx.db, ctx.projectId, input());
  const found = issues.find((i) => i.category === 'thread');
  assert.ok(found, 'the thread state mismatch is found');
  ctx.db.close();
});

test('a canon change never modifies the canon', () => {
  const ctx = scenario('gc-isolation', ({ db, projectId }) => {
    addChapter({ db, projectId }, 1);
    const canonEvent = db.run(
      `INSERT INTO canon_event (project_id, title, summary, locator, participants, location, time_label, kind, quote, created_at)
       VALUES (?, 'The original event', 'the original summary', '', '[]', '', '', 'event', '', '2024-01-01')`,
      projectId,
    ).lastInsertRowid;
    const au = addEvent({ db, projectId }, 'The changed event', 1);
    db.run(
      `INSERT INTO canon_change (project_id, au_event_id, canon_event_id, change_type, description, confirmed, created_at)
       VALUES (?, ?, ?, 'altered', 'it goes differently', 0, '2024-01-01')`,
      projectId,
      au,
      canonEvent,
    );
  });

  graphContinuityChecks(ctx.db, ctx.projectId, input());
  const canon = ctx.db.get<{ title: string; summary: string }>(
    'SELECT title, summary FROM canon_event WHERE project_id = ?',
    ctx.projectId,
  );
  assert.equal(canon?.title, 'The original event', 'the canon event is untouched');
  assert.equal(canon?.summary, 'the original summary');
  ctx.db.close();
});
