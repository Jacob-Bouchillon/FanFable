import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retrieve, retrieveForScene } from '../src/retrieval.ts';
import { checkPremise } from '../src/premise-check.ts';
import * as lorebook from '../src/lorebook.ts';
import * as memory from '../src/memory.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

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
      status: 'dead',
      chunk_index: 0,
      evidence: 'The bridge at Ardenne still stood',
    },
    {
      kind: 'location',
      name: 'the bridge at Ardenne',
      aliases: ['Ardenne bridge'],
      summary: 'A crossing over the river.',
      attributes: {},
      role: '',
      status: '',
      chunk_index: 0,
      evidence: 'the bridge at Ardenne still stood',
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
  timeline: [],
};

async function seeded() {
  const { db } = tempDb();
  const project = await seedProject(db, 'retrieval');
  const llm = mockProvider(() => JSON.stringify(CANON));
  await lorebook.extractLore(db, llm, project.id);
  return { db, projectId: project.id, llm };
}

test('retrieval returns passages and connected context together', async () => {
  const { db, projectId, llm } = await seeded();
  const pkg = await retrieve(db, llm, projectId, {
    query: 'the bridge and the lights',
    focus: ['Serena Marsh'],
    maxWords: 900,
  });

  assert.ok(pkg.passages.length > 0, 'passages come back');
  assert.ok(pkg.graph.nodes.length > 0, 'graph nodes come back');
  assert.ok(pkg.text.includes('CANON EVIDENCE'), 'the package names the evidence');
  assert.ok(pkg.text.includes('CONNECTED CONTEXT'), 'the package names the connections');
  assert.ok(pkg.stats.words <= 1100, `the package is inside its budget (${pkg.stats.words})`);
  db.close();
});

test('retrieval finds the story side, which text search cannot', async () => {
  const { db, projectId, llm } = await seeded();
  db.run(
    "INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at) VALUES (?, 1, 'One', 'approved', 'x', '2024-01-01', '2024-01-01')",
    projectId,
  );
  const chapterId = db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = ?', projectId)!.id;
  memory.applyStateExtraction(
    db,
    projectId,
    chapterId,
    {
      summary: 's',
      events: [],
      characters: [{ name: 'Serena Marsh', aliases: ['Serena'] }],
      states: [],
      knowledge: [{ character: 'Serena Marsh', fact: 'the third lantern was meant for her', certainty: 'knows' }],
      relationships: [],
      threads: [],
      facts: [],
      canonChanges: [],
      motivations: [{ character: 'Serena Marsh', kind: 'motive', statement: 'She wants the village to stop lying' }],
    },
  );

  const pkg = await retrieveForScene(db, llm, projectId, { focus: ['Serena Marsh'] });
  assert.match(pkg.text, /third lantern was meant for her/, 'the story knowledge is in the context');
  assert.match(pkg.text, /stop lying/, 'the motive is in the context');
  db.close();
});

test('the package is de-duplicated and inside its budget', async () => {
  const { db, projectId, llm } = await seeded();
  const pkg = await retrieve(db, llm, projectId, {
    query: 'bridge lights ridge',
    focus: ['Serena Marsh', 'Kade', 'Ilsa Marrow'],
    maxWords: 500,
  });
  const ids = pkg.passages.map((p) => p.chunkId);
  assert.equal(new Set(ids).size, ids.length, 'no passage appears twice');
  assert.ok(pkg.stats.words <= 700, `inside the budget (${pkg.stats.words})`);
  db.close();
});

test('a premise that contradicts the canon is flagged', async () => {
  const { db, projectId } = await seeded();
  // Kade is alive in the source; the premise has him killed.
  const warnings = checkPremise(
    db,
    projectId,
    'Serena kills Kade on the bridge, and the village never knows.',
    '',
  );
  const conflict = warnings.find((w) => w.kind === 'status-conflict');
  assert.ok(conflict, 'the contradiction with the canon is flagged');
  assert.match(conflict!.message, /Kade/);
  db.close();
});

test('a premise that agrees with the canon is not flagged', async () => {
  const { db, projectId } = await seeded();
  const warnings = checkPremise(
    db,
    projectId,
    'Serena watches the bridge with Kade, who counts the lights.',
    'Serena takes the third lantern.',
  );
  assert.ok(!warnings.some((w) => w.kind === 'status-conflict'), 'no false conflict');
  db.close();
});

test('a name that is not in the source is noted', async () => {
  const { db, projectId } = await seeded();
  const warnings = checkPremise(db, projectId, 'Wilhelmina arrives at the bridge.', '');
  const unknown = warnings.find((w) => w.kind === 'unknown-character');
  assert.ok(unknown, 'the unknown name is noted');
  assert.match(unknown!.message, /Wilhelmina/);
  db.close();
});
