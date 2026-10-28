/**
 * Answer-trails acceptance tests: labeled receipts per passage + the picture
 * command. Mock/fixture only — no Ollama (the CLI spawn runs against fully
 * mined chunks, so retrieval makes zero model calls).
 *
 *   - trail chain with correct labels (seed → relation → entity → passage)
 *   - a passage with no path from the seeds yields empty steps
 *   - the 6-step cap holds on a deliberately long chain
 *   - `lore trails` writes an HTML file with locators, edge labels and SVG
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync } from 'node:fs';
import * as graph from '../../fanfable/src/graph.ts';
import type { Graph, PprResult, TraversalResult } from '../../fanfable/src/graph.ts';
import { seedProject, tempDb } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';
const QUERY = "who is Astra's sibling";

/** Astra -> Bram -> Cora across the first three fixture passages. */
function chainProject(dbName: string) {
  const { db, path } = tempDb();
  const project = seedProject(db, dbName);
  const chunks = db.all<{ id: number; locator: string }>(
    'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    project.id,
  );
  const [c0, c1, c2] = chunks;
  const ids = new Map<string, number>();
  for (const [name, chunk] of [
    ['Astra', c0],
    ['Bram', c1],
    ['Cora', c2],
  ] as [string, { id: number; locator: string }][]) {
    ids.set(
      name,
      db.run(
        'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        project.id,
        'character',
        name,
        `${name} appears here.`,
        JSON.stringify([{ source: 'sample', locator: chunk!.locator, chunk: chunk!.id }]),
        AT,
        AT,
      ).lastInsertRowid,
    );
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
  return { db, path, project, chunks: [c0!, c1!, c2!] as { id: number; locator: string }[] };
}

test('trails carry the labeled chain behind each passage', async () => {
  const { db, project, chunks } = chainProject('trails-chain');
  const [c0, c1, c2] = chunks;
  const ctx = await graph.buildPprGraphContext(db, project.id, {
    query: QUERY,
    focus: ['Astra'],
    hops: 2,
  });
  assert.equal(ctx.stats.seedVia, 'triple', 'the walk seeds from the triple');
  const trails = ctx.trails ?? [];
  // Three passages rank: the fourth fixture chunk is edgeless, scores zero,
  // and never enters the package.
  assert.equal(trails.length, 3, 'every ranked passage gets a receipt');

  const byChunk = new Map(trails.map((t) => [t.chunkId, t]));
  assert.deepEqual(byChunk.get(c1!.id)?.steps, [
    { node: 'Bram', kind: 'canon-entity', via: null },
    { node: c1!.locator, kind: 'canon-passage', via: 'mentions_in' },
  ]);
  assert.deepEqual(byChunk.get(c2!.id)?.steps, [
    { node: 'Bram', kind: 'canon-entity', via: null },
    { node: 'Cora', kind: 'canon-entity', via: 'knows' },
    { node: c2!.locator, kind: 'canon-passage', via: 'mentions_in' },
  ]);
  assert.deepEqual(byChunk.get(c0!.id)?.steps, [
    { node: 'Astra', kind: 'canon-entity', via: null },
    { node: c0!.locator, kind: 'canon-passage', via: 'mentions_in' },
  ]);
  for (const trail of trails) {
    assert.ok(Number.isFinite(trail.score), 'every trail carries its PPR weight');
  }
  db.close();
});

test('a passage with no path from the seeds yields empty steps', () => {
  // A passage no graph node maps to — exactly what a direct-FTS hit looks
  // like when the CLI lists passages beyond the graph trails.
  const g: Graph = { nodes: new Map(), edges: [], adjacency: new Map(), byNumeric: new Map() };
  const empty: TraversalResult = { nodes: new Map(), edges: [], paths: new Map(), depth: new Map(), truncated: false };
  const ppr: PprResult = { scores: new Map(), ranked: [], iterations: 0, converged: true };
  const [trail] = graph.buildPassageTrails(g, empty, [], ppr, [{ chunkId: 7, locator: 'nowhere', text: '' }]);
  assert.ok(trail, 'the passage still gets a receipt');
  assert.deepEqual(trail!.steps, [], 'no path means found by words');
  assert.equal(trail!.score, 0, 'words alone carry no PPR weight');
});

function chainGraph(length: number): { graph: Graph; result: TraversalResult; passageId: string } {
  const g: Graph = { nodes: new Map(), edges: [], adjacency: new Map(), byNumeric: new Map() };
  const addNode = (id: string, kind: 'canon-entity' | 'canon-passage', numericId: number) => {
    g.nodes.set(id, {
      id,
      numericId,
      kind,
      scope: 'canon',
      name: id === 'canon:passage:999' ? 'far passage' : id,
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
  const ids: string[] = ['canon:entity:0'];
  addNode('canon:entity:0', 'canon-entity', 0);
  for (let i = 1; i < length; i++) {
    const id = `canon:entity:${i}`;
    addNode(id, 'canon-entity', i);
    ids.push(id);
  }
  addNode('canon:passage:999', 'canon-passage', 999);
  const edgeIds: string[] = [];
  const link = (index: number, from: string, to: string) => {
    const id = `edge${index}`;
    edgeIds.push(id);
    g.edges.push({
      id,
      from,
      to,
      type: 'linked to',
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
  ids.forEach((id, i) => {
    if (i > 0) link(i, ids[i - 1]!, id);
  });
  link(ids.length, ids[ids.length - 1]!, 'canon:passage:999');
  const paths = new Map<string, string[]>();
  paths.set('canon:entity:0', []);
  paths.set('canon:passage:999', [...edgeIds]);
  return { graph: g, result: { nodes: g.nodes, edges: g.edges, paths, depth: new Map(), truncated: false }, passageId: 'canon:passage:999' };
}

test('the 6-step cap holds on a deliberately long chain', () => {
  // 10 entities + passage = 11 nodes, 10 edges: the receipt keeps 6.
  const { graph: g, result, passageId } = chainGraph(10);
  const ppr: PprResult = { scores: new Map([[passageId, 0.5]]), ranked: [], iterations: 1, converged: true };
  const [trail] = graph.buildPassageTrails(g, result, [], ppr, [{ chunkId: 999, locator: 'far away', text: '' }]);
  assert.ok(trail, 'the far passage gets a trail');
  assert.equal(trail!.steps.length, 6, 'chains truncate to 6 steps');
  assert.equal(trail!.steps[5]!.node, 'far passage', 'the passage end is always kept');
  assert.equal(trail!.steps[0]!.node, 'canon:entity:5', 'the window keeps the passage side');
  assert.ok(trail!.steps.every((s) => s.via === 'linked to'), 'every kept label is truthful');
});

test('lore trails writes a picture page with locators and edge labels', () => {
  const { db, path, project, chunks } = chainProject('trails-cli');
  db.run('UPDATE canon_chunk SET lore_mined = 1 WHERE project_id = ?', project.id);
  const outDir = mkdtempSync(join(tmpdir(), 'trails-cli-'));
  const out = join(outDir, 'trails.html');
  const stdout = execFileSync(
    process.execPath,
    [
      '--no-warnings',
      resolve(import.meta.dirname, '../../fanfable/src/cli.ts'),
      '--db',
      path,
      '--project',
      project.name,
      'lore',
      'trails',
      '--query',
      QUERY,
      '--out',
      out,
    ],
    { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8' },
  );
  assert.match(stdout, /wrote/, 'the command reports its file');
  assert.ok(existsSync(out), 'the picture page exists');
  const html = readFileSync(out, 'utf8');
  assert.ok(html.includes('<svg'), 'the diagram is inline SVG');
  assert.ok(html.includes(chunks[1]!.locator), 'passage locators are drawn');
  assert.ok(html.includes('sister of') || html.includes('mentions_in'), 'edge labels are drawn');
  assert.ok(html.includes('Trails as text'), 'the screen-reader list follows');
  assert.ok(html.includes('(found by words)') || html.includes('--'), 'every trail reads as text');
  db.close();
});
