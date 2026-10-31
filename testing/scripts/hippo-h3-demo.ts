/**
 * Hippo H3 demo (local-only, mock llm — no Ollama, no network).
 *
 * A lookalike query: "sibling" resembles the "brother" triples behind Bram
 * and Cora, but only Cora's passage supports a sibling reading. Unfiltered
 * PPR ranks Bram's passage top-2; filtered PPR drops Bram's seed and does
 * not. Also prints the per-route model-call budget.
 *
 *   node testing/scripts/hippo-h3-demo.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../fanfable/src/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import * as graph from '../../fanfable/src/graph.ts';
import * as embeddings from '../../fanfable/src/embeddings.ts';
import { MockProvider } from '../../fanfable/src/llm.ts';

const AT = '2026-01-01T00:00:00.000Z';
const MODEL = 'demo-fake';

const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => {
    const lower = t.toLowerCase();
    if (lower.includes('sibling') || lower.includes('brother')) return [1, 0, 0];
    return [0, 0, 1];
  });

const dir = mkdtempSync(join(tmpdir(), 'hippo-h3-demo-'));
const db = new Db(join(dir, 'demo.db'));
const project = controller.createProject(db, 'demo');
lore.importSource(db, project.id, 'testing/tests/fixtures/sample-book.txt');
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

await embeddings.embedBackfill(db, project.id, { baseUrl: 'x', model: MODEL, embedFn: fakeEmbed });

// The judge: Bram's "brother" is resemblance only; Cora's is supported.
let filterCalls = 0;
const judge = new MockProvider();
judge.handler = (req) => {
  filterCalls++;
  const user = req.messages.map((m) => m.content).join('\n');
  const found = [...user.matchAll(/\[id: ([^\]]+)\]/g)].map((m) => m[1]!);
  return JSON.stringify({
    results: found.map((id) => ({ id, supported: id !== 'canon:entity:2' })),
  });
};

const query = "who is Astra's sibling";
const g = graph.loadGraph(db, project.id);
const dense = await graph.resolveDenseSeeds(db, project.id, g, query, { embedFn: fakeEmbed, model: MODEL });
console.log(`query: ${query}`);
console.log(`dense-only seeds: ${dense.seeds.map((s) => `${s.id}@${s.w}`).join(', ')}`);

const plain = await graph.buildPprGraphContext(db, project.id, {
  query,
  focus: ['Astra'],
  hops: 1,
  embed: { embedFn: fakeEmbed, model: MODEL },
});
const show = (label: string, ctx: graph.GraphContext) =>
  console.log(
    `${label}: ${ctx.passages
      .slice(0, 3)
      .map((p) => `chunk ${p.chunkId}`)
      .join(' | ')}`,
  );
show('unfiltered top-3     ', plain);

const filtered = await graph.buildPprGraphContext(db, project.id, {
  query,
  focus: ['Astra'],
  hops: 1,
  embed: { embedFn: fakeEmbed, model: MODEL },
  recognize: { llm: judge, enabled: true },
});
show('filtered top-3       ', filtered);
console.log(
  `dropped: ${(filtered.stats.recognition?.dropped ?? 0) === 1 ? 'canon:entity:2 (unsupported)' : '(unexpected)'}`,
);
console.log(`recognition stats: ${JSON.stringify(filtered.stats.recognition)}`);
console.log(`Bram's passage (chunk ${c1!.id}) in unfiltered top-2: ${plain.passages.slice(0, 2).some((p) => p.chunkId === c1!.id)}`);
console.log(`Bram's passage (chunk ${c1!.id}) in filtered top-2:   ${filtered.passages.slice(0, 2).some((p) => p.chunkId === c1!.id)}`);

console.log(`\nfilter model calls this demo: ${filterCalls} (one batched call)`);
console.log('per-route budget: lookup 0 (filter-free) | relational without dense seeds 0 | relational with dense-only seeds 1');
console.log('embed cost is not a model call: 1 query embed per retrieval, backfill batched offline');
db.close();
