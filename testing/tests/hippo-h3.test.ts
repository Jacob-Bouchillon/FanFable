/**
 * Hippo H3 acceptance tests: recognition filter for dense-only seeds.
 *
 * Mock provider only — no Ollama:
 *
 *   - lookalike dropped (contradicted seed removed, PPR re-ranks without it)
 *   - supported kept (verbatim-supporting seed survives)
 *   - lexical immunity (a lexical id is auto-kept, never sent to the model)
 *   - fail-open (throwing mock keeps everything with filter-error)
 *   - cap (12 dense-only seeds, maxSeeds 10 → exactly 10 checked)
 *   - lookup path pays zero filter calls
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as graph from '../../fanfable/src/graph.ts';
import * as embeddings from '../../fanfable/src/embeddings.ts';
import type { EmbedFn } from '../../fanfable/src/embeddings.ts';
import { filterDenseSeeds } from '../../fanfable/src/product/recognition.ts';
import { retrieve } from '../../fanfable/src/answer/retrieval.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { seedProject, tempDb, mockProvider } from './helpers.ts';

const AT = '2026-01-01T00:00:00.000Z';

/** Toy vectors by keyword: "sibling" matches text saying only "brother". */
function keywordEmbed(): EmbedFn {
  return async (texts: string[]) =>
    texts.map((t) => {
      const lower = t.toLowerCase();
      if (lower.includes('sibling') || lower.includes('brother')) return [1, 0, 0];
      if (lower.includes('bridge')) return [0, 1, 0];
      return [0, 0, 1];
    });
}

/** Astra -> Bram -> Cora chains off chunk 0/1/2; both triples say "brother". */
function chainProject(dbName: string) {
  const { db } = tempDb();
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
  const relate = (from: string, to: string, description: string) => {
    db.run(
      'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      project.id,
      ids.get(from)!,
      ids.get(to)!,
      'sister of',
      description,
      AT,
    );
  };
  relate('Astra', 'Bram', 'Bram is the brother here.');
  relate('Astra', 'Cora', 'Cora is the brother here.');
  return { db, project, chunks: [c0!, c1!, c2!] as { id: number; locator: string }[] };
}

async function backfilled(dbName: string) {
  const ctx = chainProject(dbName);
  const counts = await embeddings.embedBackfill(ctx.db, ctx.project.id, {
    baseUrl: 'http://127.0.0.1:9',
    model: 'fake',
    embedFn: keywordEmbed(),
  });
  assert.ok(counts.embedded > 0, 'the fake backfills rows');
  return ctx;
}

/** A recognition mock with scripted verdicts; records prompts and call params. */
function mockFilter(
  verdicts: Record<string, boolean>,
  seen: { ids: string[]; temperature?: number; maxTokens?: number }[] = [],
) {
  return mockProvider((req) => {
    const user = req.messages.map((m) => m.content).join('\n');
    const ids = [...user.matchAll(/\[id: ([^\]]+)\]/g)].map((m) => m[1]!);
    const params = req as unknown as { temperature?: number; maxTokens?: number };
    seen.push({ ids, temperature: params.temperature, maxTokens: params.maxTokens });
    return JSON.stringify({ results: ids.map((id) => ({ id, supported: verdicts[id] ?? true })) });
  });
}

const QUERY = "who is Astra's sibling";

test('a lookalike seed is dropped and PPR re-ranks without it', async () => {
  const { db, project, chunks } = await backfilled('h3-drop');
  const [c1, c2] = [chunks[1]!, chunks[2]!];
  const seen: { ids: string[]; temperature?: number; maxTokens?: number }[] = [];
  const llm = mockFilter({ 'canon:entity:2': false }, seen);

  const filtered = await graph.buildPprGraphContext(db, project.id, {
    query: QUERY,
    focus: ['Astra'],
    hops: 1,
    embed: { embedFn: keywordEmbed(), model: 'fake' },
    recognize: { llm, enabled: true },
  });
  assert.deepEqual(filtered.stats.recognition, { checked: 2, kept: 1, dropped: 1 });
  assert.equal(seen.length, 1, 'one filter call per retrieval');
  assert.equal(seen[0]!.temperature, 0.0, 'the judgment call is deterministic');
  assert.equal(seen[0]!.maxTokens, 400, 'the judgment call is capped');

  // Chunk ids, not locators: the first two passages share one locator.
  const order = filtered.passages.map((p) => p.chunkId);
  assert.ok(
    order.indexOf(c2.id) !== -1 && order.indexOf(c1.id) !== -1 && order.indexOf(c2.id) < order.indexOf(c1.id),
    'the kept seed outranks the dropped one',
  );

  const unfiltered = await graph.buildPprGraphContext(db, project.id, {
    query: QUERY,
    focus: ['Astra'],
    hops: 1,
    embed: { embedFn: keywordEmbed(), model: 'fake' },
  });
  assert.equal(unfiltered.stats.recognition, undefined, 'no filter, no stats');
  assert.ok(unfiltered.passages.some((p) => p.chunkId === c1.id), 'both rank unfiltered');
  assert.ok(unfiltered.passages.some((p) => p.chunkId === c2.id), 'both rank unfiltered');
  db.close();
});

test('a supported seed survives the filter', async () => {
  const { db, project, chunks } = await backfilled('h3-keep');
  const llm = mockFilter({});
  const ctx = await graph.buildPprGraphContext(db, project.id, {
    query: QUERY,
    focus: ['Astra'],
    hops: 1,
    embed: { embedFn: keywordEmbed(), model: 'fake' },
    recognize: { llm, enabled: true },
  });
  assert.deepEqual(ctx.stats.recognition, { checked: 2, kept: 2, dropped: 0 });
  const ids = ctx.passages.map((p) => p.chunkId);
  assert.ok(ids.includes(chunks[1]!.id), 'Bram still ranks');
  assert.ok(ids.includes(chunks[2]!.id), 'Cora still ranks');
  db.close();
});

test('a lexical id is never sent to the model', async () => {
  const { db, project } = await backfilled('h3-lexical');
  const g = graph.loadGraph(db, project.id);
  const seen: { ids: string[] }[] = [];
  const llm = mockFilter({}, seen);
  const result = await filterDenseSeeds(
    llm,
    [
      { id: 'canon:entity:1', w: 0.8 },
      { id: 'canon:entity:2', w: 0.8 },
    ],
    g,
    db,
    project.id,
    { query: QUERY, lexicalIds: new Set(['canon:entity:1']) },
  );
  assert.deepEqual(seen[0]!.ids, ['canon:entity:2'], 'the lexical id never reaches the prompt');
  assert.ok(result.kept.some((k) => k.id === 'canon:entity:1' && k.reason === 'lexical'));
  assert.equal(result.checked, 1, 'only the dense-only seed counts as checked');
  db.close();
});

test('a failing filter keeps everything', async () => {
  const { db, project } = await backfilled('h3-failopen');
  const g = graph.loadGraph(db, project.id);
  const llm = mockProvider(() => {
    throw new Error('model is down');
  });
  const result = await filterDenseSeeds(
    llm,
    [
      { id: 'canon:entity:1', w: 0.8 },
      { id: 'canon:entity:2', w: 0.8 },
    ],
    g,
    db,
    project.id,
    { query: QUERY },
  );
  assert.equal(result.kept.length, 2, 'every seed stays');
  assert.equal(result.dropped.length, 0, 'nothing drops on error');
  assert.ok(result.kept.every((k) => k.reason === 'filter-error'));
  assert.equal(result.checked, 0, 'no judgment happened');
  db.close();
});

test('only the first maxSeeds dense-only seeds are checked', async () => {
  const { db, project } = await backfilled('h3-cap');
  const g = graph.loadGraph(db, project.id);
  const seen: { ids: string[] }[] = [];
  const llm = mockFilter({}, seen);
  const seeds = Array.from({ length: 12 }, (_, i) => ({ id: `canon:entity:9${i}`, w: 0.8 }));
  const result = await filterDenseSeeds(llm, seeds, g, db, project.id, { query: QUERY, maxSeeds: 10 });
  assert.equal(seen[0]!.ids.length, 10, 'exactly 10 reach the single call');
  assert.equal(result.checked, 10, 'checked counts the call, not the list');
  assert.equal(result.kept.length, 12, 'the over-cap pair stays kept');
  assert.ok(result.kept.some((k) => k.reason === 'over-cap'), 'over-cap has its reason');
  db.close();
});

test('the lookup path pays zero filter calls', async () => {
  const { db } = tempDb();
  const project = seedProject(db, 'h3-lookup');
  const extractLlm = mockProvider((req) => {
    const system = req.system ?? '';
    if (system.includes('KNOWN ENTITIES')) return JSON.stringify({ relations: [] });
    if (system.includes('"timeline"')) return JSON.stringify({ timeline: [] });
    return JSON.stringify({
      entities: [
        {
          kind: 'character',
          name: 'Serena Marsh',
          aliases: [],
          summary: 'A woman on the ridge.',
          attributes: {},
          role: '',
          status: '',
          chunk_index: 0,
          evidence: 'Serena Marsh watched it from the ridge',
        },
      ],
      facts: [],
    });
  });
  await lorebook.extractLore(db, extractLlm, project.id);

  const systems: string[] = [];
  const llm = mockProvider((req) => {
    systems.push(req.system ?? '');
    return JSON.stringify({ terms: [] });
  });
  const pkg = await retrieve(db, llm, project.id, { query: '"Two hundred yards," said Kade' });
  assert.equal(pkg.stats.route, 'lookup');
  assert.deepEqual(systems, [], 'a quote lookup makes no model call at all');
  assert.equal(pkg.stats.recognition, undefined, 'no filter stats on the lookup path');
  db.close();
});
