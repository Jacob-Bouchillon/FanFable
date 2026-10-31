import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../../fanfable/src/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as planner from '../../fanfable/src/plan/planner.ts';
import * as memory from '../../fanfable/src/memory.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

const OUTLINE_JSON = {
  premise: 'Serena crosses the bridge at Ardenne before dawn and changes the story of the village.',
  divergence: 'Serena takes the third lantern instead of leaving it in the tower.',
  divergence_ref: 'canon event 1',
  canon_refs: [1],
  structure: ['The crossing', 'The reckoning'],
  chapters: [
    {
      number: 1,
      title: 'The Third Lantern',
      goal: 'Serena crosses the bridge',
      synopsis: 'Serena takes the third lantern and crosses at dawn.',
      scenes: [
        {
          title: 'The ridge',
          summary: 'Serena watches the bridge and takes the lantern.',
          pov: 'Serena',
          location: 'the ridge',
          canon_event_ids: [1],
          adaptations: 'In canon the lantern is left behind; here she takes it.',
        },
      ],
      characters: ['Serena Marsh', 'Kade'],
      character_arcs: 'Serena moves from watching to acting.',
      canon_event_ids: [1],
      notes: 'check what the wardens know',
      target_words: 400,
    },
  ],
  preferences: { tone: 'cold and wet', pov: 'third person limited' },
};

const STATE_JSON = {
  summary: 'Serena took the third lantern and crossed the bridge before dawn.',
  events: [
    {
      title: 'Serena takes the third lantern',
      summary: 'She crosses at dawn with the lantern.',
      story_time: 'day three, before dawn',
      story_order: 1,
      participants: ['Serena Marsh'],
      location: 'Ardenne bridge',
      kind: 'adaptation',
      adapts_canon_event_id: 1,
      divergence_note: 'The lantern is taken instead of left behind.',
    },
  ],
  characters: [{ name: 'Serena Marsh', aliases: ['Serena'], profile: 'a watcher of the bridge', traits: ['observant'] }],
  states: [{ character: 'Serena Marsh', location: 'the far bank', condition: 'wet', emotional: 'resolved' }],
  knowledge: [{ character: 'Serena Marsh', fact: 'Kade was watching from the ridge', certainty: 'knows' }],
  relationships: [{ a: 'Serena Marsh', b: 'Kade', kind: 'uneasy', description: 'he resents her' }],
  threads: [{ title: 'The third lantern', description: 'why she took it', status: 'open' }],
  facts: [{ kind: 'decision', subject: 'Serena Marsh', content: 'She crossed before dawn' }],
  canonChanges: [{ canon_event_id: 1, change_type: 'altered', description: 'The lantern is taken instead of left behind.' }],
};

function scriptedProvider() {
  let writerCalls = 0;
  const llm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('Story Planner') && system.includes('Reply with JSON only')) {
      return JSON.stringify(OUTLINE_JSON);
    }
    if (system.includes('extract structured story state')) {
      return JSON.stringify(STATE_JSON);
    }
    if (system.includes('Continuity Checker')) {
      return '{"issues":[]}';
    }
    if (system.includes('expand a lore question')) {
      return '{"terms":["bridge","Ardenne"]}';
    }
    if (system.includes('Story Writer')) {
      writerCalls++;
      if (writerCalls === 1) {
        return `The rain had not stopped for three days.

[[CONTEXT]]
{"kind":"lore","query":"the bridge at Ardenne"}
[[END]]`;
      }
      return `The rain had not stopped for three days, and the bridge at Ardenne still stood.
Serena took the third lantern and crossed before dawn.

[[META]]
{"events":[{"title":"Serena takes the third lantern","summary":"She crosses at dawn.","participants":["Serena Marsh"],"location":"Ardenne bridge","kind":"adaptation","adapts_canon_event_id":1,"divergence_note":"The lantern is taken."}]}
[[END]]`;
    }
    return '{}';
  });
  return llm;
}

test('full workflow: plan, approve, write, approve, remember', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'workflow');
  const llm = scriptedProvider();

  // 1. Canon event index so the AU can link to it.
  const events = await lore.extractCanonEvents(
    db,
    mockProvider(() =>
      JSON.stringify([
        {
          title: 'Serena watches the bridge',
          summary: 'Serena watches the bridge from the ridge.',
          participants: ['Serena'],
          location: 'the ridge',
          time_label: 'day three',
          kind: 'scene',
          chunk_index: 0,
        },
      ]),
    ),
    project.id,
  );
  assert.equal(events.length, 1);

  // 2. Plan.
  const data = await planner.draftOutline(llm, { premise: OUTLINE_JSON.premise, chapterCount: 1 });
  const draft = planner.saveOutline(db, project.id, { ...data, status: 'draft' });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.chapters.length, 1);

  // 3. Approve the outline.
  const approved = planner.approveOutline(db, project.id, draft.id);
  assert.equal(approved.status, 'approved');
  assert.equal(planner.approvedOutline(db, project.id)?.id, approved.id);

  // 4. Write the chapter.
  const result = await controller.writeChapter(db, llm, project.id, { chapterNumber: 1 });
  assert.ok(result.chapter.body.includes('Ardenne'));
  assert.ok(!result.chapter.body.includes('[[CONTEXT]]'), 'protocol blocks are not saved as prose');
  assert.equal(result.chapter.status, 'draft', 'a written chapter starts as a draft');
  assert.ok(result.trace.length >= 1, 'the writer requested context during writing');

  // 5. Approve the chapter: memory is updated.
  const { chapter, issues } = await controller.approveChapter(db, llm, project.id, 1);
  assert.equal(chapter.status, 'approved');
  assert.ok(chapter.summary.length > 0, 'a summary is stored');

  const chars = memory.listCharacters(db, project.id);
  assert.ok(chars.some((c) => c.name === 'Serena Marsh'));
  const states = memory.currentStates(db, project.id);
  assert.equal(states.find((s) => s.characterName === 'Serena Marsh')?.location, 'the far bank');
  const knowledge = memory.listKnowledge(db, project.id);
  assert.ok(knowledge.some((k) => k.fact.includes('Kade')));
  const auEvents = memory.listAuEvents(db, project.id);
  assert.equal(auEvents.length, 1);
  assert.equal(auEvents[0].adaptsCanonEventId, events[0].id, 'the AU event links to its canon event');
  const threads = memory.listThreads(db, project.id);
  assert.equal(threads[0].title, 'The third lantern');
  assert.ok(Array.isArray(issues));

  // 6. Canon was not modified by any of this.
  const canonEvents = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_event WHERE project_id = ?', project.id);
  assert.equal(canonEvents?.n, 1);
  const changes = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_change WHERE project_id = ?', project.id);
  assert.ok((changes?.n ?? 0) >= 1, 'the difference from canon is recorded separately');

  db.close();
});

test('the project can be reopened and keeps its state', async () => {
  const { db, path } = tempDb();
  const project = seedProject(db, 'persist');
  const llm = scriptedProvider();
  const data = await planner.draftOutline(llm, { premise: 'p', chapterCount: 1 });
  planner.approveOutline(db, project.id, planner.saveOutline(db, project.id, { ...data }).id);
  await controller.writeChapter(db, llm, project.id, { chapterNumber: 1 });
  await controller.approveChapter(db, llm, project.id, 1);
  db.close();

  const reopened = new Db(path);
  const chapters = controller.listChapters(reopened, project.id);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].status, 'approved');
  assert.ok(chapters[0].body.length > 0);
  const outline = planner.approvedOutline(reopened, project.id);
  assert.ok(outline, 'the approved outline survived the restart');
  reopened.close();
});

test('a draft outline is not treated as established', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'draft-only');
  const data = planner.saveOutline(db, project.id, {
    premise: 'a premise',
    chapters: [
      {
        number: 1,
        title: 'One',
        goal: '',
        synopsis: '',
        scenes: [],
        characters: [],
        characterArcs: '',
        canonEventIds: [],
        notes: '',
        targetWords: 1000,
      },
    ],
    status: 'draft',
  });
  assert.equal(planner.approvedOutline(db, project.id), undefined);
  assert.equal(planner.latestOutline(db, project.id)?.id, data.id);
  db.close();
});

test('revising an outline keeps untouched chapters', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'revise');
  const outline = planner.saveOutline(db, project.id, {
    premise: 'p',
    divergence: 'd',
    chapters: [
      {
        number: 1,
        title: 'One',
        goal: 'g1',
        synopsis: 's1',
        scenes: [],
        characters: ['A'],
        characterArcs: '',
        canonEventIds: [],
        notes: '',
        targetWords: 1000,
      },
      {
        number: 2,
        title: 'Two',
        goal: 'g2',
        synopsis: 's2',
        scenes: [],
        characters: ['B'],
        characterArcs: '',
        canonEventIds: [],
        notes: '',
        targetWords: 1000,
      },
    ],
    status: 'approved',
  });
  const llm = mockProvider(() =>
    JSON.stringify({
      premise: 'p',
      divergence: 'd',
      structure: [],
      chapters: [
        {
          number: 2,
          title: 'Two revised',
          goal: 'g2 revised',
          synopsis: 's2 revised',
          scenes: [],
          characters: ['B'],
          character_arcs: '',
          canon_event_ids: [],
          notes: '',
          target_words: 1000,
        },
      ],
    }),
  );
  const revised = await planner.reviseOutline(llm, outline, 'make chapter two darker', { chapterNumber: 2 });
  assert.equal(revised.chapters[0].title, 'One', 'chapter one is untouched');
  assert.equal(revised.chapters[0].goal, 'g1');
  assert.equal(revised.chapters[1].title, 'Two revised');
  db.close();
});

test('writing without an approved outline is refused', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'no-outline');
  const llm = mockProvider(() => '{}');
  await assert.rejects(
    () => controller.writeChapter(db, llm, project.id, { chapterNumber: 1 }),
    /approved outline/,
  );
  db.close();
});

test('re-approving an edited chapter does not duplicate memory records', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'reapprove');
  const llm = scriptedProvider();
  const data = await planner.draftOutline(llm, { premise: 'p', chapterCount: 1 });
  planner.approveOutline(db, project.id, planner.saveOutline(db, project.id, { ...data }).id);

  await controller.writeChapter(db, llm, project.id, { chapterNumber: 1 });
  await controller.approveChapter(db, llm, project.id, 1);
  const eventsAfterFirst = memory.listAuEvents(db, project.id).length;
  const summariesAfterFirst = memory.listSummaries(db, project.id).length;

  controller.setChapterBody(db, project.id, 1, 'Serena crossed the bridge and took the lantern.');
  await controller.approveChapter(db, llm, project.id, 1);

  assert.equal(memory.listAuEvents(db, project.id).length, eventsAfterFirst, 'events are replaced, not duplicated');
  assert.equal(memory.listSummaries(db, project.id).length, summariesAfterFirst);
  db.close();
});

test('context requests are logged so the author can see them', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'requests');
  const llm = scriptedProvider();
  const data = await planner.draftOutline(llm, { premise: 'p', chapterCount: 1 });
  planner.approveOutline(db, project.id, planner.saveOutline(db, project.id, { ...data }).id);
  await controller.writeChapter(db, llm, project.id, { chapterNumber: 1 });
  const rows = db.all<{ kind: string; query: string }>(
    'SELECT kind, query FROM context_request WHERE project_id = ?',
    project.id,
  );
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].kind, 'lore');
  db.close();
});
