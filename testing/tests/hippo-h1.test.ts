/**
 * Hippo H1 acceptance tests: passages as first-class graph nodes + PPR ranking.
 *
 *   - passage nodes load with mention edges (entity/event/timeline -> chunk)
 *   - PPR on a diamond graph ranks the shared passage first
 *   - PPR converges below the iteration cap with scores summing to ~1
 *   - the relational path returns PPR-ranked passages; the lookup path does
 *     no PPR work at all
 *   - a 2-hop query (entity -> relation -> entity -> relation -> passage)
 *     surfaces a passage the 1-hop walk misses
 *
 * Mock provider and direct SQL only; no Ollama.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as graph from '../../fanfable/src/graph.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { retrieve } from '../../fanfable/src/answer/retrieval.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

const SERENA_QUOTE = 'Serena Marsh watched it from the ridge';
const KADE_QUOTE = 'said Kade behind her';
const AT = '2026-01-01T00:00:00.000Z';

/** A mock that answers each of the three split extraction calls. */
function splitMock(parts: {
  entities?: Record<string, unknown>[];
  relations?: Record<string, unknown>[];
}) {
  return mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) {
      return JSON.stringify({ relations: parts.relations ?? [] });
    }
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({ entities: parts.entities ?? [], facts: [] });
  });
}

function entityRow(name: string, evidence: string) {
  return {
    kind: 'character',
    name,
    aliases: [],
    summary: `${name} in the sample book.`,
    attributes: {},
    role: '',
    status: '',
    chunk_index: 0,
    evidence,
  };
}

test('passage nodes load with mention edges', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'hippo-passages');
  const llm = splitMock({
    entities: [entityRow('Serena Marsh', SERENA_QUOTE), entityRow('Kade', KADE_QUOTE)],
    relations: [
      {
        from: 'Serena Marsh',
        to: 'Kade',
        kind: 'accompanied by',
        description: 'Kade stands behind her on the ridge.',
        chunk_index: 0,
        evidence: SERENA_QUOTE,
      },
    ],
  });
  await lorebook.extractLore(db, llm, project.id);

  const chunks = db.all<{ id: number }>('SELECT id FROM canon_chunk WHERE project_id = ?', project.id);
  const g = graph.loadGraph(db, project.id);
  const passages = [...g.nodes.values()].filter((n) => n.kind === 'canon-passage');
  assert.equal(passages.length, chunks.length, 'every chunk becomes a passage node');
  for (const p of passages) {
    assert.match(p.id, /^canon:passage:\d+$/, 'passage ids are stable chunk addresses');
  }

  const serena = g.nodes.get('canon:entity:1');
  assert.ok(serena, 'the first entity loads');
  const mentions = g.edges.filter((e) => e.from === serena!.id && e.type === 'mentions_in');
  assert.ok(mentions.length > 0, 'the entity points at its passages');
  assert.equal(mentions[0].extra?.weight, 1, 'mention edges carry weight 1');
  for (const e of mentions) {
    assert.ok(g.nodes.has(e.to), 'every mention edge lands on a passage node');
  }
  db.close();
});

function diamondGraph(): graph.Graph {
  const g: graph.Graph = { nodes: new Map(), edges: [], adjacency: new Map(), byNumeric: new Map() };
  const addNode = (id: string, kind: graph.NodeKind) => {
    g.nodes.set(id, {
      id,
      numericId: 0,
      kind,
      scope: 'canon',
      name: id,
      summary: '',
      aliases: [],
      confidence: 1,
      reviewStatus: 'accepted',
      evidence: '',
      sourceRefs: [],
      order: 0,
      extra: {},
    });
  };
  const addEdge = (id: string, from: string, to: string) => {
    g.edges.push({
      id,
      from,
      to,
      type: 'related_to',
      scope: 'canon',
      description: '',
      evidence: '',
      confidence: 1,
      reviewStatus: 'accepted',
    });
    for (const end of [from, to]) {
      const list = g.adjacency.get(end);
      if (list) list.push(id);
      else g.adjacency.set(end, [id]);
    }
  };
  // Seed S reaches A and B; both mention the shared passage P, while only A
  // mentions Q. P must outrank Q.
  for (const id of ['s', 'a', 'b']) addNode(id, 'canon-entity');
  for (const id of ['p', 'q']) addNode(id, 'canon-passage');
  addEdge('e1', 's', 'a');
  addEdge('e2', 's', 'b');
  addEdge('e3', 'a', 'p');
  addEdge('e4', 'b', 'p');
  addEdge('e5', 'a', 'q');
  return g;
}

test('PPR on a diamond ranks the shared passage first', () => {
  const result = graph.personalizedPageRank(diamondGraph(), { s: 1 });
  assert.ok(result.ranked.length > 0, 'passages are ranked');
  assert.equal(result.ranked[0].id, 'p', 'the passage mentioned twice comes first');
  assert.equal(result.ranked[1].id, 'q', 'the passage mentioned once comes second');
});

test('PPR converges with scores summing to ~1', () => {
  const result = graph.personalizedPageRank(diamondGraph(), { s: 1 });
  assert.ok(result.converged, 'the diamond settles');
  assert.ok(result.iterations < 100, `settles before the cap (${result.iterations})`);
  const total = [...result.scores.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `scores are a distribution (${total})`);

  const none = graph.personalizedPageRank(diamondGraph(), {});
  assert.deepEqual(none.ranked, [], 'no seeds means no ranking');
  assert.ok(none.converged, 'the empty case still reports converged');
});

test('the relational path ranks by PPR while lookup does no PPR work', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'hippo-retrieval');
  const llm = splitMock({
    entities: [entityRow('Serena Marsh', SERENA_QUOTE), entityRow('Kade', KADE_QUOTE)],
    relations: [
      {
        from: 'Serena Marsh',
        to: 'Kade',
        kind: 'sibling of',
        description: 'Kade is the brother of Serena Marsh.',
        chunk_index: 0,
        evidence: SERENA_QUOTE,
      },
    ],
  });
  await lorebook.extractLore(db, llm, project.id);

  const relational = await retrieve(db, llm, project.id, {
    query: "who is Serena Marsh's sibling",
    focus: ['Serena Marsh'],
  });
  assert.equal(relational.stats.route, 'relational');
  assert.ok(relational.stats.ppr, 'the relational path reports PPR diagnostics');
  assert.ok(relational.stats.ppr!.nodes > 0, 'PPR ran over a non-empty graph');
  assert.ok(relational.stats.ppr!.iterations > 0, 'PPR iterated');
  assert.ok(relational.graph.passages.length > 0, 'PPR-ranked passages come back');

  const lookup = await retrieve(db, llm, project.id, { query: '"Two hundred yards," said Kade' });
  assert.equal(lookup.stats.route, 'lookup');
  assert.equal(lookup.stats.ppr, undefined, 'a quote lookup does no PPR work');
  assert.equal(lookup.graph.nodes.length, 0, 'a quote lookup walks no graph');
  db.close();
});

test('a 2-hop passage surfaces through PPR that the 1-hop walk misses', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'hippo-assoc');
  const chunks = db.all<{ id: number; locator: string }>(
    'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    project.id,
  );
  assert.ok(chunks.length >= 4, 'the chain needs four passages');
  const [c0, c1, c2, c3] = chunks;

  // Astra -> Bram -> Cora -> Dov: the query matches only the first link, so a
  // 1-hop walk from its endpoints reaches Cora but never Dov's passage.
  const names: [string, { id: number; locator: string }][] = [
    ['Astra', c0!],
    ['Bram', c1!],
    ['Cora', c2!],
    ['Dov', c3!],
  ];
  const ids = new Map<string, number>();
  for (const [name, chunk] of names) {
    const id = db.run(
      'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      project.id,
      'character',
      name,
      `${name} appears here.`,
      JSON.stringify([{ source: 'sample', locator: chunk.locator, chunk: chunk.id }]),
      AT,
      AT,
    ).lastInsertRowid;
    ids.set(name, id);
  }
  const relate = (from: string, to: string, kind: string, description: string) => {
    db.run(
      'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      project.id,
      ids.get(from)!,
      ids.get(to)!,
      kind,
      description,
      AT,
    );
  };
  relate('Astra', 'Bram', 'sister of', 'Bram is the sibling Astra asked about.');
  relate('Bram', 'Cora', 'knows', 'Bram knows Cora.');
  relate('Cora', 'Dov', 'knows', 'Cora knows Dov.');

  const query = "who is Astra's sibling";
  const oldCtx = graph.buildGraphContext(db, project.id, {
    query,
    focus: ['Astra'],
    hops: 1,
    seedMode: 'triple',
  });
  const newCtx = await graph.buildPprGraphContext(db, project.id, { query, focus: ['Astra'], hops: 1 });
  assert.equal(newCtx.stats.seedVia, 'triple', 'both paths seed from the same triple');

  const oldLocators = oldCtx.passages.map((p) => p.locator);
  const newLocators = newCtx.passages.map((p) => p.locator);
  assert.ok(!oldLocators.includes(c3!.locator), 'the 1-hop walk never reaches Dov');
  assert.ok(newLocators.includes(c3!.locator), 'PPR surfaces Dov through the chain');
  assert.ok(
    newLocators.includes(c0!.locator),
    'the directly-seeded passage stays in the package',
  );
  db.close();
});
