import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as graph from '../../fanfable/src/graph.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import * as memory from '../../fanfable/src/memory.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';
import { Db } from '../../fanfable/src/db.ts';
import * as controller from '../../fanfable/src/controller.ts';

const CANON_EXTRACTION = {
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
      evidence: '"Two hundred yards," said Kade behind her.',
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
      evidence: 'The ledger lay open on the table between them.',
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
    // Intentionally empty: extract-time gating of thin quotes is covered by
    // the bank-gates, markers, and judged-sheet suites. Graph tests below
    // bank their traversal edges directly via seededProject so they test
    // graph composition, not the gate.
  ],
  facts: [
    {
      topic: 'the bridge signal',
      statement: 'Three lights mean the bridge is held and one light means the wardens are coming.',
      kind: 'rule',
      certainty: 'confirmed',
      subject: 'Serena Marsh',
      chunk_index: 0,
      evidence: 'Three lights meant the bridge was held',
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

async function seededProject(name: string): Promise<{ db: Db; projectId: number }> {
  const { db } = tempDb();
  const project = await seedProject(db, name);
  const llm = mockProvider(() => JSON.stringify(CANON_EXTRACTION));
  await lorebook.extractLore(db, llm, project.id);
  // Bank the traversal edges directly: the mock quotes state no tie, so the
  // strict gate correctly parks them; graph tests need banked edges, and
  // gating is covered by the bank-gates, markers, and judged-sheet suites.
  const edge = (from: string, to: string, kind: string, evidence: string) => {
    const f = db.get<{ id: number }>(`SELECT id FROM canon_entity WHERE project_id = ? AND kind = 'character' AND name = ?`, project.id, from)!.id;
    const t = db.get<{ id: number }>(`SELECT id FROM canon_entity WHERE project_id = ? AND kind = 'character' AND name = ?`, project.id, to)!.id;
    db.run(
      `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, review_status, created_at)
       VALUES (?, ?, ?, ?, ?, '[]', 'accepted', '2026-01-01')`,
      project.id, f, t, kind, evidence,
    );
  };
  edge('Serena Marsh', 'Kade', 'member of', 'Serena Marsh watched it from the ridge with Kade');
  edge('Ilsa Marrow', 'Kade', 'member of', 'Ilsa Marrow had been entered in it three times with Kade');
  return { db, projectId: project.id };
}

const EXTRACTION: memory.StateExtraction = {
  summary: 'Serena takes the lantern and crosses.',
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
      location: 'Ardenne bridge',
      kind: 'adaptation',
      adaptsCanonEventId: null,
      divergenceNote: 'The lantern is taken instead of left behind.',
    },
  ],
  characters: [{ name: 'Serena Marsh', aliases: ['Serena'], profile: 'a watcher of the bridge' }],
  states: [{ character: 'Serena Marsh', location: 'the far bank', condition: 'wet' }],
  knowledge: [{ character: 'Serena Marsh', fact: 'the third lantern was hers', certainty: 'knows' }],
  relationships: [{ a: 'Serena Marsh', b: 'Kade', kind: 'uneasy' }],
  threads: [{ title: 'The third lantern', description: 'why she took it', status: 'open' }],
  facts: [{ kind: 'decision', subject: 'Serena Marsh', content: 'She crossed before dawn' }],
  canonChanges: [],
  motivations: [{ character: 'Serena Marsh', kind: 'motive', statement: 'She wants the village to stop lying' }],
  secrets: [{ title: 'the third lantern', statement: 'the lantern was meant for her', knownBy: ['Serena Marsh'] }],
  links: [],
  threadEvents: [{ thread: 'The third lantern', event: 'Serena takes the third lantern', kind: 'introduced' }],
};

test('the graph connects canon entities, facts and events', async () => {
  const { db, projectId } = await seededProject('graph-basic');
  const g = graph.loadGraph(db, projectId);

  const serena = g.nodes.get(graph.canonEntityId(1));
  assert.ok(serena, 'the canon entity is a node');
  assert.equal(serena?.name, 'Serena Marsh');
  assert.deepEqual(serena?.aliases, ['Serena']);

  const relations = g.edges.filter(
    (e) => e.type === 'member of' && e.from === graph.canonEntityId(1) && e.to === graph.canonEntityId(2),
  );
  assert.equal(relations.length, 1);
  assert.equal(relations[0].from, graph.canonEntityId(1));
  assert.equal(relations[0].to, graph.canonEntityId(2));
  assert.ok(relations[0].evidence.length > 0, 'a relation keeps its evidence');

  const fact = g.nodes.get(graph.canonFactId(1));
  assert.ok(fact, 'the canon fact is a node');
  assert.equal(fact?.summary.includes('Three lights'), true);

  db.close();
});

test('every edge points at a node that exists', async () => {
  const { db, projectId } = await seededProject('graph-valid');
  const g = graph.loadGraph(db, projectId);
  for (const edge of g.edges) {
    assert.ok(g.nodes.has(edge.from), `dangling edge from ${edge.from}`);
    assert.ok(g.nodes.has(edge.to), `dangling edge to ${edge.to}`);
  }
  db.close();
});

test('traversal walks one or two hops and stops where it should', async () => {
  const { db, projectId } = await seededProject('graph-traverse');
  const g = graph.loadGraph(db, projectId);

  const oneHop = graph.traverse(g, { roots: [graph.canonEntityId(1)], hops: 1 });
  assert.ok(oneHop.nodes.has(graph.canonEntityId(2)), 'one hop reaches Kade');
  assert.ok(!oneHop.nodes.has(graph.canonEntityId(3)), 'one hop does not reach Ilsa');

  const twoHops = graph.traverse(g, { roots: [graph.canonEntityId(1)], hops: 2 });
  assert.ok(twoHops.nodes.has(graph.canonEntityId(3)), 'two hops reaches Ilsa');
  db.close();
});

test('traversal respects edge direction', async () => {
  const { db, projectId } = await seededProject('graph-direction');
  const g = graph.loadGraph(db, projectId);

  const outgoing = graph.traverse(g, { roots: [graph.canonEntityId(1)], hops: 1, direction: 'out' });
  assert.ok(outgoing.nodes.has(graph.canonEntityId(2)), 'Serena reaches Kade');
  assert.ok(!outgoing.nodes.has(graph.canonEntityId(3)), 'and not Ilsa, who is further away');

  const incoming = graph.traverse(g, { roots: [graph.canonEntityId(1)], hops: 1, direction: 'in' });
  assert.ok(!incoming.nodes.has(graph.canonEntityId(2)), 'nothing points at Serena yet');
  db.close();
});

test('traversal is protected against cycles', async () => {
  const { db, projectId } = await seededProject('graph-cycle');
  // Make a cycle: Serena -> Kade -> Ilsa -> Serena
  db.run(
    `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence, source_refs, created_at)
     VALUES (?, 3, 1, 'knows', 'a loop', '', '[]', '2024-01-01')`,
    projectId,
  );
  const g = graph.loadGraph(db, projectId);
  const result = graph.traverse(g, { roots: [graph.canonEntityId(1)], hops: 3 });
  assert.ok(result.nodes.has(graph.canonEntityId(1)));
  assert.ok(result.nodes.size <= 10, 'the walk terminates');
  db.close();
});

test('roots are resolved from names and aliases', async () => {
  const { db, projectId } = await seededProject('graph-roots');
  const g = graph.loadGraph(db, projectId);
  const matches = graph.resolveRoots(g, ['Serena', 'Kade']);
  const names = matches.map((m) => m.node.name);
  assert.ok(names.includes('Serena Marsh'), 'the alias finds the full name');
  assert.ok(names.includes('Kade'));
  db.close();
});

test('the story side of the graph is written when a chapter is approved', async () => {
  const { db, projectId } = await seededProject('graph-story');
  const chapterId = 1;
  db.run(
    "INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at) VALUES (?, 1, 'One', 'draft', 'text', '2024-01-01', '2024-01-01')",
    projectId,
  );
  const id = db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = ?', projectId)!.id;
  memory.applyStateExtraction(db, projectId, id, EXTRACTION);

  const g = graph.loadGraph(db, projectId);

  // entity resolution: the story character is linked to the canon character
  const character = db.get<{ id: number; canon_entity_id: number | null }>(
    'SELECT id, canon_entity_id FROM character WHERE project_id = ? AND name = ?',
    projectId,
    'Serena Marsh',
  );
  assert.ok(character?.canon_entity_id, 'the story character resolves to a canon entity');
  assert.ok(
    g.edges.some((e) => e.type === 'based_on' && e.from === graph.characterId(character!.id)),
    'the graph has the based_on edge',
  );

  // participation
  const auEvent = db.get<{ id: number }>('SELECT id FROM au_event WHERE project_id = ?', projectId)!;
  assert.ok(
    g.edges.some(
      (e) => e.type === 'participates_in' && e.to === graph.auEventId(auEvent.id) && e.scope === 'story',
    ),
    'the character participates in the story event',
  );

  // knowledge
  assert.ok(
    g.edges.some((e) => e.type === 'knows' && e.scope === 'story'),
    'the character knows the thing',
  );

  // motives
  const motive = db.get<{ id: number }>('SELECT id FROM motivation WHERE project_id = ?', projectId);
  assert.ok(motive, 'the motive was recorded');
  assert.ok(
    g.edges.some((e) => e.type === 'motive' && e.to === graph.motivationId(motive!.id)),
    'the motive hangs off the character',
  );

  // secrets
  const secret = db.get<{ id: number }>('SELECT id FROM secret WHERE project_id = ?', projectId);
  assert.ok(secret, 'the secret was recorded');

  // plot thread development
  assert.ok(
    g.edges.some((e) => e.type === 'introduced_by' && e.scope === 'story'),
    'the thread is linked to the event that introduced it',
  );
  db.close();
});

test('re-approving a chapter leaves no stale graph records', async () => {
  const { db, projectId } = await seededProject('graph-reapprove');
  db.run(
    "INSERT INTO chapter (project_id, number, title, status, body, created_at, updated_at) VALUES (?, 1, 'One', 'draft', 'text', '2024-01-01', '2024-01-01')",
    projectId,
  );
  const id = db.get<{ id: number }>('SELECT id FROM chapter WHERE project_id = ?', projectId)!.id;

  memory.applyStateExtraction(db, projectId, id, EXTRACTION);
  const first = {
    events: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM au_event WHERE project_id = ?', projectId)!.n,
    knowledge: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM character_knowledge WHERE project_id = ?', projectId)!.n,
    motivations: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM motivation WHERE project_id = ?', projectId)!.n,
    secrets: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM secret WHERE project_id = ?', projectId)!.n,
  };

  memory.clearChapterExtraction(db, projectId, id);
  memory.applyStateExtraction(db, projectId, id, EXTRACTION);

  const second = {
    events: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM au_event WHERE project_id = ?', projectId)!.n,
    knowledge: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM character_knowledge WHERE project_id = ?', projectId)!.n,
    motivations: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM motivation WHERE project_id = ?', projectId)!.n,
    secrets: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM secret WHERE project_id = ?', projectId)!.n,
  };
  assert.deepEqual(second, first, 'the same records, not twice as many');
  db.close();
});

test('canon and story stay in separate id spaces', async () => {
  const { db, projectId } = await seededProject('graph-isolation');
  const g = graph.loadGraph(db, projectId);
  const canonNodes = [...g.nodes.values()].filter((n) => n.scope === 'canon');
  const storyNodes = [...g.nodes.values()].filter((n) => n.scope === 'story');
  assert.ok(canonNodes.length > 0);
  for (const n of canonNodes) assert.ok(n.id.startsWith('canon:'), n.id);
  for (const n of storyNodes) assert.ok(n.id.startsWith('story:'), n.id);
  db.close();
});

test('the graph context is bounded and carries evidence', async () => {
  const { db, projectId } = await seededProject('graph-context');
  const ctx = graph.buildGraphContext(db, projectId, {
    focus: ['Serena'],
    hops: 1,
    maxWords: 400,
  });
  assert.ok(ctx.nodes.length > 0, 'the context found nodes');
  assert.ok(ctx.text.length > 0);
  assert.ok(ctx.stats.words <= 500, `the context respects its budget (${ctx.stats.words} words)`);
  db.close();
});

test('the graph survives a restart', async () => {
  const { db, path } = tempDb();
  const project = await seedProject(db, 'graph-restart');
  const llm = mockProvider(() => JSON.stringify(CANON_EXTRACTION));
  await lorebook.extractLore(db, llm, project.id);
  const before = graph.loadGraph(db, project.id).nodes.size;
  db.close();

  const reopened = new Db(path);
  const after = graph.loadGraph(reopened, project.id).nodes.size;
  assert.equal(after, before, 'the graph is rebuilt from the database');
  reopened.close();
});

test('character resolution does not link unrelated characters', async () => {
  const { db, projectId } = await seededProject('graph-resolution');
  const id = memory.upsertCharacter(db, projectId, 'Wilhelmina Ashbottom');
  const linked = memory.linkCharacterToCanon(db, projectId, id);
  assert.equal(linked, undefined, 'no canon entity means no link');
  db.close();
});

test('a compound relation kind is split into separate relations', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'graph-kinds');
  const llm = mockProvider(() =>
    JSON.stringify({
      entities: [
        { kind: 'character', name: 'Serena Marsh', aliases: [], summary: 'A woman on the ridge', attributes: {}, role: '', status: '', chunk_index: 0, evidence: 'Serena Marsh watched it from the ridge' },
        { kind: 'character', name: 'Kade', aliases: [], summary: 'A frightened man', attributes: {}, role: '', status: '', chunk_index: 0, evidence: 'said Kade behind her' },
      ],
      relations: [
        { from: 'Serena Marsh', to: 'Kade', kind: 'lives with | travels with', description: 'x', chunk_index: 0, evidence: 'Serena Marsh watched it from the ridge' },
      ],
      facts: [],
      timeline: [],
    }),
  );
  const { db: db2 } = { db };
  void db2;
  return import( '../../fanfable/src/lorebook.ts').then(async (lorebook) => {
    await lorebook.extractLore(db, llm, project.id);
    const kinds = db
      .all<{ kind: string }>('SELECT kind FROM canon_relation WHERE project_id = ?', project.id)
      .map((r) => r.kind);
    assert.deepEqual(kinds.sort(), ['lives with', 'travels with']);
    db.close();
  });
});

test('a kind that is really the prompt example list is not stored', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'graph-kinds-list');
  const llm = mockProvider(() =>
    JSON.stringify({
      entities: [
        { kind: 'character', name: 'A', aliases: [], summary: '', attributes: {}, role: '', status: '', chunk_index: 0, evidence: 'A' },
        { kind: 'character', name: 'B', aliases: [], summary: '', attributes: {}, role: '', status: '', chunk_index: 0, evidence: 'B' },
      ],
      relations: [
        { from: 'A', to: 'B', kind: 'sibling of | serves | suspects | owes | married to | leads', description: 'x', chunk_index: 0, evidence: 'A' },
      ],
      facts: [],
      timeline: [],
    }),
  );
  return import( '../../fanfable/src/lorebook.ts').then(async (lorebook) => {
    await lorebook.extractLore(db, llm, project.id);
    const rows = db.all<{ kind: string }>('SELECT kind FROM canon_relation WHERE project_id = ?', project.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'related to');
    db.close();
  });
});

test('temporal filters hide what has not happened yet', async () => {
  const { db, projectId } = await seededProject('graph-temporal');
  // Two story events: the first is where the character is, the second is later.
  const first = db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (?, 1, 'The crossing', '', 'dawn', 1, '[]', 'the far bank', 'event', '', '2024-01-01')`,
    projectId,
  ).lastInsertRowid;
  const later = db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (?, 2, 'The reckoning', '', 'noon', 2, '[]', 'the village', 'event', '', '2024-01-01')`,
    projectId,
  ).lastInsertRowid;

  // The character takes part in both events.
  const characterId = memory.upsertCharacter(db, projectId, 'Serena Marsh');
  for (const eventId of [first, later]) {
    db.run(
      `INSERT OR IGNORE INTO au_event_participant (au_event_id, character_id, role) VALUES (?, ?, 'participant')`,
      eventId,
      characterId,
    );
  }

  const g = graph.loadGraph(db, projectId);
  const upToFirst = graph.traverse(g, {
    roots: [graph.characterId(characterId)],
    hops: 1,
    beforeOrder: 1,
    temporal: true,
  });
  assert.ok(!upToFirst.nodes.has(graph.auEventId(later)), 'a later event is hidden');
  assert.ok(upToFirst.nodes.has(graph.auEventId(first)), 'the current event is visible');

  const everything = graph.traverse(g, { roots: [graph.characterId(characterId)], hops: 1 });
  assert.ok(everything.nodes.has(graph.auEventId(later)), 'without the filter both are visible');
  db.close();
});

test('a scene is given the story as it stands at that point', async () => {
  const { db, projectId } = await seededProject('graph-at-event');
  const earlier = db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (?, 1, 'Before', '', 'dawn', 1, '[]', 'the ridge', 'event', '', '2024-01-01')`,
    projectId,
  ).lastInsertRowid;
  const later = db.run(
    `INSERT INTO au_event (project_id, seq, title, summary, story_time, story_order, participants, location, kind, divergence_note, created_at)
     VALUES (?, 2, 'After', '', 'noon', 2, '[]', 'the village', 'event', '', '2024-01-01')`,
    projectId,
  ).lastInsertRowid;

  const characterId = memory.upsertCharacter(db, projectId, 'Serena Marsh');
  for (const eventId of [earlier, later]) {
    db.run(
      `INSERT OR IGNORE INTO au_event_participant (au_event_id, character_id, role) VALUES (?, ?, 'participant')`,
      eventId,
      characterId,
    );
  }

  const ctx = graph.buildGraphContext(db, projectId, {
    focus: ['Serena Marsh'],
    atEventId: earlier,
    hops: 1,
  });
  assert.ok(ctx.text.includes('Before'), 'the earlier event is in the context');
  assert.ok(!ctx.text.includes('After'), 'the later event is not yet true');
  void later;
  db.close();
});

test('a family tie composes through one middle person', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'graph-compose');
  const now = '2026-01-01T00:00:00.000Z';
  const ent = (name: string): number =>
    db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, name, now, now).lastInsertRowid;
  const bram = ent('Bram');
  const mira = ent('Mrs Corwin');
  const asha = ent('Asha');
  const rel = (f: number, t: number, kind: string, review = 'accepted') =>
    db.run(
      'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, created_at, review_status) VALUES (?, ?, ?, ?, ?, ?)',
      project.id, f, t, kind, now, review,
    );
  rel(bram, mira, 'son of');
  rel(mira, asha, 'aunt of');
  const outsider = ent('Outsider');
  const otherside = ent('Otherside');
  rel(outsider, otherside, 'son of');
  rel(otherside, outsider, 'mother of');
  const hit = graph.findComposedPath(db, project.id, bram, asha);
  assert.deepEqual(hit, { via: 'Mrs Corwin', label: 'cousin of' }, "the user's example composes");
  assert.deepEqual(
    graph.findComposedPath(db, project.id, asha, bram),
    { via: 'Mrs Corwin', label: 'cousin of' },
    'the symmetric answer reads back just as well',
  );
  assert.equal(graph.findComposedPath(db, project.id, bram, bram), null, 'nobody relates to themselves');
  assert.equal(graph.findComposedPath(db, project.id, asha, ent('Stranger')), null, 'no path, no answer');
  assert.equal(graph.findComposedPath(db, project.id, outsider, asha), null, 'rows touching neither endpoint never count');
  db.close();
});

test('only undisputed rows feed a composed answer', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'graph-compose-quarantine');
  const now = '2026-01-01T00:00:00.000Z';
  const ent = (name: string): number =>
    db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, name, now, now).lastInsertRowid;
  const a = ent('A');
  const b = ent('B');
  const c = ent('C');
  const rel = (f: number, t: number, kind: string, review = 'accepted') =>
    db.run(
      'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, created_at, review_status) VALUES (?, ?, ?, ?, ?, ?)',
      project.id, f, t, kind, now, review,
    );
  rel(a, b, 'son of');
  rel(b, c, 'aunt of', 'needs_review');
  assert.equal(graph.findComposedPath(db, project.id, a, c), null, 'a flagged middle never answers');
  db.close();
});

test('a child of a sibling composes to a relative', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'graph-compose-nephew');
  const now = '2026-01-01T00:00:00.000Z';
  const ent = (name: string): number =>
    db.run('INSERT INTO canon_entity (project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)', project.id, name, now, now).lastInsertRowid;
  const bram = ent('Bram');
  const mira = ent('Mira');
  const lena = ent('Lena');
  const rel = (f: number, t: number, kind: string, review = 'accepted') =>
    db.run(
      'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, created_at, review_status) VALUES (?, ?, ?, ?, ?, ?)',
      project.id, f, t, kind, now, review,
    );
  rel(mira, bram, 'mother of');
  rel(mira, lena, 'sister of');
  assert.deepEqual(
    graph.findComposedPath(db, project.id, bram, lena),
    { via: 'Mira', label: 'relative of' },
    'your example, first hop: the bank implies the nephew link',
  );
  db.close();
});
