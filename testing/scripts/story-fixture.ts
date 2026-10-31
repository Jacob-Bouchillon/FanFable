/**
 * A small project with a story in it, for evaluating the graph on the story
 * side: what characters know, what they want, and how they are connected.
 *
 * The canon is the sample book; the story is written on top of it.
 */
import { Db } from '../../fanfable/src/db.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as memory from '../../fanfable/src/memory.ts';
import { MockProvider } from '../../fanfable/src/llm.ts';
import { join } from 'node:path';

const CANON = {
  entities: [
    {
      kind: 'character',
      name: 'Serena Marsh',
      aliases: ['Serena'],
      summary: 'A woman who watches the bridge from the ridge.',
      attributes: {},
      role: 'protagonist',
      status: 'alive',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
    {
      kind: 'character',
      name: 'Kade',
      aliases: [],
      summary: 'A frightened man who counts the lights.',
      attributes: {},
      role: 'companion',
      status: 'alive',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
    {
      kind: 'character',
      name: 'Ilsa Marrow',
      aliases: [],
      summary: 'A woman with a ledger of debts.',
      attributes: {},
      role: 'debt holder',
      status: 'alive',
      chunk_index: 0,
      evidence: 'The bridge at Ardenne still stood',
    },
    {
      kind: 'item',
      name: 'the ledger',
      aliases: [],
      summary: 'A book kept by the warden to record debts.',
      attributes: {},
      role: '',
      status: '',
      chunk_index: 0,
      evidence: 'The bridge at Ardenne still stood',
    },
  ],
  relations: [
    {
      from: 'Serena Marsh',
      to: 'Kade',
      kind: 'accompanied by',
      description: 'Kade stands behind her on the ridge.',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
    {
      from: 'Ilsa Marrow',
      to: 'Kade',
      kind: 'owes',
      description: 'Ilsa owes Kade a promise.',
      chunk_index: 0,
      evidence: 'The bridge at Ardenne still stood',
    },
  ],
  facts: [
    {
      topic: 'the bridge signal',
      statement: 'Three lights mean the bridge is held and one light means the wardens are coming.',
      kind: 'rule',
      certainty: 'confirmed',
      subject: 'Serena Marsh',
      chunk_index: 0,
      evidence: 'The bridge at Ardenne still stood',
    },
  ],
  timeline: [
    {
      title: 'Serena watches the bridge',
      summary: 'She counts the lights from the ridge.',
      when: 'three days of rain',
      participants: ['Serena Marsh', 'Kade'],
      location: 'the ridge',
      chunk_index: 0,
      evidence: 'Serena Marsh watched it from the ridge',
    },
  ],
};

const EXTRACTION: memory.StateExtraction = {
  summary: 'Serena takes the third lantern and crosses before dawn.',
  events: [
    {
      id: 0,
      chapterId: null,
      chapterNumber: null,
      title: 'Serena takes the third lantern',
      summary: 'She crosses at dawn with the lantern.',
      storyTime: 'day three, before dawn',
      storyOrder: 1,
      participants: ['Serena Marsh', 'Kade'],
      location: 'the ridge',
      kind: 'event',
      adaptsCanonEventId: null,
      divergenceNote: '',
    },
    {
      id: 0,
      chapterId: null,
      chapterNumber: null,
      title: 'Serena crosses the bridge',
      summary: 'She crosses alone and loses the folded paper.',
      storyTime: 'day three, dawn',
      storyOrder: 2,
      participants: ['Serena Marsh'],
      location: 'the bridge at Ardenne',
      kind: 'event',
      adaptsCanonEventId: null,
      divergenceNote: '',
    },
  ],
  characters: [
    { name: 'Serena Marsh', aliases: ['Serena'], profile: 'a watcher of the bridge' },
    { name: 'Kade', aliases: [], profile: 'a frightened man who counts the lights' },
  ],
  states: [
    { character: 'Serena Marsh', location: 'the far bank', condition: 'wet', emotional: 'resolved' },
    { character: 'Kade', location: 'the ridge', condition: 'frustrated', emotional: 'worried' },
  ],
  knowledge: [
    { character: 'Serena Marsh', fact: 'the third lantern was meant for her', certainty: 'knows' },
    { character: 'Kade', fact: 'the third lantern was meant for her', certainty: 'suspects' },
  ],
  relationships: [{ a: 'Serena Marsh', b: 'Kade', kind: 'uneasy allies', description: 'he resents her' }],
  threads: [{ title: 'The third lantern', description: 'why she took it', status: 'open' }],
  facts: [{ kind: 'decision', subject: 'Serena Marsh', content: 'She crossed before dawn' }],
  canonChanges: [],
  motivations: [
    { character: 'Serena Marsh', kind: 'motive', statement: 'She wants the village to stop lying about that night' },
  ],
  secrets: [
    { title: 'the third lantern', statement: 'the lantern was meant for her', knownBy: ['Serena Marsh'] },
  ],
  links: [{ from: 'Serena takes the third lantern', to: 'Serena crosses the bridge', kind: 'cause', description: 'taking it is what let her cross' }],
  threadEvents: [{ thread: 'The third lantern', event: 'Serena takes the third lantern', kind: 'introduced' }],
};

/** Build the evaluation project and return its id. */
export async function buildStoryProject(db: Db, fixturePath: string): Promise<number> {
  const project = (
    await import( '../../fanfable/src/plan/controller.ts')
  ).createProject(db, 'story-eval');
  lore.importSource(db, project.id, fixturePath);

  const llm = new MockProvider();
  llm.handler = () => JSON.stringify(CANON);
  await lorebook.extractLore(db, llm, project.id);

  db.run(
    "INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at) VALUES (?, 1, 'One', 'approved', 'text', '2024-01-01', '2024-01-01')",
    project.id,
  );
  const chapterId = db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = ?', project.id)!.id;
  memory.applyStateExtraction(db, project.id, chapterId, EXTRACTION);
  return project.id;
}

export const STORY_QUESTIONS = [
  {
    q: 'What does Serena know about the third lantern?',
    focus: ['Serena Marsh'],
    expect: [['third lantern', 'meant for her']],
    story: true,
  },
  {
    q: 'Why did Serena take the lantern?',
    focus: ['Serena Marsh'],
    expect: [['stop lying', 'motive', 'wants', 'village']],
    story: true,
  },
  {
    q: 'What is the secret in this story?',
    focus: ['Serena Marsh'],
    expect: [['meant for her', 'secret', 'third lantern']],
    story: true,
  },
  {
    q: 'What is the open plot thread?',
    focus: ['Serena Marsh'],
    expect: [['third lantern', 'why she took it', 'thread']],
    story: true,
  },
  {
    q: 'What caused Serena to cross the bridge?',
    focus: ['Serena Marsh'],
    expect: [['taking', 'cross', 'cause', 'consequence']],
    story: true,
  },
  {
    q: 'How do Serena and Kade relate?',
    focus: ['Serena Marsh', 'Kade'],
    expect: [['uneasy', 'resent', 'allies', 'accompanied']],
    story: true,
  },
];

export { join };
