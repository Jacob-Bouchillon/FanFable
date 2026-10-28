/**
 * Similarity-web acceptance tests: alias, resemblance and co-occurrence
 * edges in the graph view, plus the PPR normalization check.
 *
 * Direct SQL + stored vectors only — no Ollama, no embedder calls:
 *
 *   - an alias pair shares weight 1.0 both ways
 *   - a vetoed (quarantined) pair gets weight 0.5
 *   - resemblance respects the threshold, the top-3 cap, and skips cleanly
 *     with no vectors stored
 *   - a single-window co-mention creates nothing; the hub guard excludes the
 *     ubiquitous entity; a repeated pair links at min(0.5, 0.15 x windows)
 *   - PPR on a diamond-with-alias graph still ranks the shared passage first
 *   - PPR already normalizes per edge (hub spreads thinly, scores sum to 1)
 *   - the same input loads the same edges, and web edges stay out of text
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as graph from '../../fanfable/src/graph.ts';
import {
  ALIAS_WEIGHT,
  QUARANTINE_WEIGHT,
  RESEMBLANCE_THRESHOLD,
  RESEMBLANCE_TOPK,
} from '../../fanfable/src/graph.ts';
import { DEFAULT_EMBED_MODEL } from '../../fanfable/src/embeddings.ts';
import { seedProject, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

function addEntity(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  name: string,
  refs: { locator: string; chunk: number }[] = [],
): number {
  return db.run(
    'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    projectId,
    'character',
    name,
    `${name} appears here.`,
    JSON.stringify(refs.map((r) => ({ source: 'sample', locator: r.locator, chunk: r.chunk }))),
    AT,
    AT,
  ).lastInsertRowid;
}

function addVector(
  db: ReturnType<typeof tempDb>['db'],
  projectId: number,
  ref: string,
  vec: number[],
): void {
  db.run(
    'INSERT INTO embedding (project_id, kind, ref, model, dims, vec, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    projectId,
    'entity',
    ref,
    DEFAULT_EMBED_MODEL,
    vec.length,
    JSON.stringify(vec),
    AT,
  );
}

/** Alias/quarantine project: Corwin(s), co-speaking Ashas, one chunk extra. */
function aliasProject() {
  const { db } = tempDb();
  const project = seedProject(db, 'web-alias');
  const source = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ?', project.id)!;
  db.run(
    'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words) VALUES (?, ?, 99, ?, ?, ?, 0, 60, 10)',
    source.id,
    project.id,
    'test scene',
    '',
    'Asha said hello first. Then Asha Corwin asked why.',
  );
  const ids = new Map<string, number>();
  for (const name of ['Corwin', 'Corwins', 'Asha', 'Asha Corwin']) {
    ids.set(name, addEntity(db, project.id, name));
  }
  return { db, project, ids };
}

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

test('an alias pair shares weight 1.0 both ways', () => {
  const { db, project, ids } = aliasProject();
  const g = graph.loadGraph(db, project.id);
  const edge = g.edges.find((e) => e.type === 'alias_of' && e.id === `canon:alias:${ids.get('Corwin')}:${ids.get('Corwins')}`);
  assert.ok(edge, 'the plural pair links');
  assert.equal(edge!.extra?.weight, ALIAS_WEIGHT, 'a certain alias weighs 1.0');

  // Both ways: seeding either endpoint reaches the other.
  const forward = graph.personalizedPageRank(g, { [edge!.from]: 1 });
  assert.ok((forward.scores.get(edge!.to) ?? 0) > 0, 'forward spread');
  const backward = graph.personalizedPageRank(g, { [edge!.to]: 1 });
  assert.ok((backward.scores.get(edge!.from) ?? 0) > 0, 'backward spread');
  db.close();
});

test('a vetoed pair links at quarantine weight', () => {
  const { db, project, ids } = aliasProject();
  const g = graph.loadGraph(db, project.id);
  const [x, y] = ids.get('Asha')! < ids.get('Asha Corwin')!
    ? [ids.get('Asha')!, ids.get('Asha Corwin')!]
    : [ids.get('Asha Corwin')!, ids.get('Asha')!];
  const edge = g.edges.find((e) => e.type === 'alias_of' && e.id === `canon:alias:${x}:${y}`);
  assert.ok(edge, 'co-speakers stay linked, not merged');
  assert.equal(edge!.extra?.weight, QUARANTINE_WEIGHT, 'a probable alias weighs 0.5');
  const names = [graph.loadGraph(db, project.id).nodes.get(edge!.from)?.name, graph.loadGraph(db, project.id).nodes.get(edge!.to)?.name].sort();
  assert.deepEqual(names, ['Asha', 'Asha Corwin'], 'both people survive as nodes');
  db.close();
});

test('resemblance respects the threshold', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'web-resemble');
  const vega = addEntity(db, project.id, 'Vega');
  const mira = addEntity(db, project.id, 'Mira');
  const altair = addEntity(db, project.id, 'Altair');
  addVector(db, project.id, `canon:entity:${vega}`, [1, 0]);
  addVector(db, project.id, `canon:entity:${mira}`, [1, 0.1]);
  addVector(db, project.id, `canon:entity:${altair}`, [0, 1]);

  const g = graph.loadGraph(db, project.id);
  const resembling = g.edges.filter((e) => e.type === 'resembles');
  assert.equal(resembling.length, 1, 'only the above-threshold pair links');
  const expected = 1 / Math.sqrt(1.01);
  assert.ok(approx(resembling[0]!.extra?.weight as number, expected), 'weight is the similarity');
  assert.ok((resembling[0]!.extra?.weight as number) >= RESEMBLANCE_THRESHOLD, 'at least the threshold');
  db.close();
});

test('resemblance caps at three edges per node and skips clean graphs', () => {
  const { db } = tempDb();
  const project = seedProject(db, 'web-resemble-cap');
  const names = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
  for (const [i, name] of names.entries()) {
    const id = addEntity(db, project.id, name);
    addVector(db, project.id, `canon:entity:${id}`, [1, 0]);
    void i;
  }
  const g = graph.loadGraph(db, project.id);
  const resembling = g.edges.filter((e) => e.type === 'resembles');
  assert.ok(resembling.length > 0, 'identical vectors link');
  const degree = new Map<string, number>();
  for (const e of resembling) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  for (const [node, deg] of degree) {
    assert.ok(deg <= RESEMBLANCE_TOPK, `${node} holds at most ${RESEMBLANCE_TOPK} resemblance edges`);
  }

  const { db: db2 } = tempDb();
  const project2 = seedProject(db2, 'web-resemble-none');
  addEntity(db2, project2.id, 'Vega');
  const g2 = graph.loadGraph(db2, project2.id);
  assert.ok(!g2.edges.some((e) => e.type === 'resembles'), 'no vectors means no resemblance edges');
  db.close();
  db2.close();
});

test('co-occurrence needs repeats and respects the hub guard', () => {
  // Pure helper first: exact numbers, no database.
  assert.deepEqual(
    graph.cooccurrenceLinks(
      new Map([
        [1, new Set([0])],
        [2, new Set([0])],
      ]),
      2,
    ),
    [],
    'one shared window is noise',
  );
  assert.deepEqual(
    graph.cooccurrenceLinks(
      new Map([
        [1, new Set([0, 1])],
        [9, new Set([0, 1, 2, 3])],
      ]),
      4,
    ),
    [],
    'the ubiquitous entity disqualifies its pairs',
  );
  const [link] = graph.cooccurrenceLinks(
    new Map([
      [1, new Set([0, 1])],
      [2, new Set([0, 1])],
    ]),
    5,
  )!;
  assert.equal(link!.windows, 2, 'two shared windows');
  assert.ok(approx(link!.weight, 0.3), 'weight is 0.15 per window');
  const [capped] = graph.cooccurrenceLinks(
    new Map([
      [1, new Set([0, 1, 2, 3])],
      [2, new Set([0, 1, 2, 3])],
    ]),
    8,
  )!;
  assert.equal(capped!.weight, 0.5, 'weight caps at 0.5');

  // Wiring: 36 passages in 5 windows; Ashford+Beamley share two, Halloran is everywhere.
  const { db } = tempDb();
  const project = seedProject(db, 'web-cooccur');
  const source = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ?', project.id)!;
  const at = (seq: number): number =>
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words) VALUES (?, ?, ?, ?, ?, ?, 0, 10, 2)',
      source.id,
      project.id,
      seq,
      `passage ${seq}`,
      '',
      'filler words here',
    ).lastInsertRowid;
  const ids: number[] = [];
  for (let seq = 4; seq < 36; seq++) ids.push(at(seq));
  const bySeq = new Map<number, number>();
  db.all<{ id: number; seq: number }>('SELECT id, seq FROM canon_chunk WHERE project_id = ? ORDER BY seq', project.id).forEach(
    (r) => bySeq.set(r.seq, r.id),
  );
  const ref = (seqs: number[]) =>
    JSON.stringify(seqs.map((seq) => ({ source: 'sample', locator: `passage ${seq}`, chunk: bySeq.get(seq)! })));
  const w = (name: string, seqs: number[]): number =>
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      project.id,
      'character',
      name,
      `${name} appears here.`,
      ref(seqs),
      AT,
      AT,
    ).lastInsertRowid;
  const ashford = w('Ashford', [0, 8]);
  const bramley = w('Bramley', [1, 9]);
  const halloran = w('Halloran', [0, 8, 16, 24, 32]);
  void ashford;
  void bramley;
  void halloran;

  const g = graph.loadGraph(db, project.id);
  const co = g.edges.filter((e) => e.type === 'appears_with');
  assert.equal(co.length, 1, 'only the repeated non-hub pair links');
  assert.ok(approx(co[0]!.extra?.weight as number, 0.3), 'two shared windows weigh 0.3');
  db.close();
});

function diamondWithAlias(): graph.Graph {
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
  const addEdge = (id: string, from: string, to: string, type = 'related_to', weight?: number) => {
    g.edges.push({
      id,
      from,
      to,
      type,
      scope: 'canon',
      description: '',
      evidence: '',
      confidence: 1,
      reviewStatus: 'accepted',
      ...(weight === undefined ? {} : { extra: { weight } }),
    });
    for (const end of [from, to]) {
      const list = g.adjacency.get(end);
      if (list) list.push(id);
      else g.adjacency.set(end, [id]);
    }
  };
  for (const id of ['s', 'a', 'b']) addNode(id, 'canon-entity');
  addNode('s2', 'canon-entity');
  for (const id of ['p', 'q']) addNode(id, 'canon-passage');
  addEdge('e1', 's', 'a');
  addEdge('e2', 's', 'b');
  addEdge('e3', 'a', 'p');
  addEdge('e4', 'b', 'p');
  addEdge('e5', 'a', 'q');
  addEdge('al', 's', 's2', 'alias_of', ALIAS_WEIGHT);
  return g;
}

test('PPR on a diamond-with-alias graph still ranks the shared passage first', () => {
  const result = graph.personalizedPageRank(diamondWithAlias(), { s: 1 });
  assert.ok(result.ranked.length > 0, 'passages are ranked');
  assert.equal(result.ranked[0]!.id, 'p', 'the shared passage still comes first');
  assert.ok(result.converged, 'the webbed diamond still settles');
});

test('PPR already normalizes: hubs spread thinly and scores sum to one', () => {
  // A hub with 10 unit-weight leaves: each leaf must carry a thin slice, and
  // the distribution must stay whole. This is the degree-normalization check:
  // per-edge share is w/sum(w), which is 1/degree for unit weights, so
  // mega-connected nodes cannot dominate through any single edge.
  const g: graph.Graph = { nodes: new Map(), edges: [], adjacency: new Map(), byNumeric: new Map() };
  const addNode = (id: string) => {
    g.nodes.set(id, {
      id,
      numericId: 0,
      kind: 'canon-entity',
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
  addNode('hub');
  const leaves: string[] = [];
  for (let i = 0; i < 10; i++) {
    const id = `leaf${i}`;
    addNode(id);
    leaves.push(id);
    g.edges.push({
      id: `e${i}`,
      from: 'hub',
      to: id,
      type: 'related_to',
      scope: 'canon',
      description: '',
      evidence: '',
      confidence: 1,
      reviewStatus: 'accepted',
    });
    for (const end of ['hub', id]) {
      const list = g.adjacency.get(end);
      if (list) list.push(`e${i}`);
      else g.adjacency.set(end, [`e${i}`]);
    }
  }
  const result = graph.personalizedPageRank(g, { hub: 1 }, { targetKinds: ['canon-entity'] });
  const hubScore = result.scores.get('hub')!;
  for (const leaf of leaves) {
    assert.ok((result.scores.get(leaf) ?? 0) < hubScore, `${leaf} carries a thin slice`);
  }
  const total = [...result.scores.values()].reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, `the distribution stays whole (${total})`);
});

test('the same input loads the same web, hidden from text', async () => {
  const { db, project } = aliasProject();
  const snap = (g: graph.Graph) =>
    g.edges.map((e) => [e.id, e.type, (e.extra?.weight as number) ?? 1] as const);
  const first = snap(graph.loadGraph(db, project.id));
  const second = snap(graph.loadGraph(db, project.id));
  assert.deepEqual(second, first, 'edge order, kinds and weights are deterministic');

  const ctx = await graph.buildPprGraphContext(db, project.id, { query: 'Asha', focus: ['Asha'], hops: 1 });
  assert.ok(!ctx.text.includes('alias_of'), 'web edges never render as claims');
  assert.ok(!ctx.text.includes('resembles'), 'web edges never render as claims');
  assert.ok(!ctx.text.includes('appears_with'), 'web edges never render as claims');
  assert.deepEqual(ctx.stats.web, graph.countWebEdges(graph.loadGraph(db, project.id)), 'stats report the loaded web');
  db.close();
});
