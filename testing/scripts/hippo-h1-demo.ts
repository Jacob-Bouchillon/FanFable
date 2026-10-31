/**
 * Hippo H1 associativity demo (local-only, no model — counts and locators).
 *
 * A chain Astra -> Bram -> Cora -> Dov where the query matches only the
 * first link. The old 1-hop walk reaches Cora but never Dov's passage; PPR
 * spreads along the mention edges and surfaces it.
 *
 *   node testing/scripts/hippo-h1-demo.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../fanfable/src/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import * as graph from '../../fanfable/src/graph.ts';

const AT = '2026-01-01T00:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'hippo-h1-demo-'));
const db = new Db(join(dir, 'demo.db'));
const project = controller.createProject(db, 'demo');
lore.importSource(db, project.id, 'testing/tests/fixtures/sample-book.txt');
const chunks = db.all<{ id: number; locator: string }>(
  'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  project.id,
);
const [c0, c1, c2, c3] = chunks;

const ids = new Map<string, number>();
for (const [name, chunk] of [
  ['Astra', c0],
  ['Bram', c1],
  ['Cora', c2],
  ['Dov', c3],
] as [string, { id: number; locator: string }][]) {
  ids.set(
    name,
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      project.id,
      'character',
      name,
      `${name} appears here.`,
      JSON.stringify([{ source: 'sample', locator: chunk.locator, chunk: chunk.id }]),
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
relate('Cora', 'Dov', 'knows', 'Cora knows Dov.');

const query = "who is Astra's sibling";
const loaded = graph.loadGraph(db, project.id);
const seed = graph.resolveQuerySeeds(loaded, query, ['Astra']);
console.log(`query: ${query}`);
console.log(`seed triples: via=${seed.via} roots=${seed.roots.join(', ')}`);

const oldCtx = graph.buildGraphContext(db, project.id, { query, focus: ['Astra'], hops: 1, seedMode: 'triple' });
const newCtx = await graph.buildPprGraphContext(db, project.id, { query, focus: ['Astra'], hops: 1 });
console.log(`old 1-hop walk passages: ${oldCtx.passages.map((p) => p.locator).join(' | ')}`);
console.log(`new PPR passages:       ${newCtx.passages.map((p) => p.locator).join(' | ')}`);
console.log(
  `ppr: nodes=${newCtx.stats.ppr?.nodes} iterations=${newCtx.stats.ppr?.iterations} converged=${newCtx.stats.ppr?.converged}`,
);
console.log(`Dov's passage (${c3.locator}) in old: ${oldCtx.passages.some((p) => p.chunkId === c3.id)}`);
console.log(`Dov's passage (${c3.locator}) in new: ${newCtx.passages.some((p) => p.chunkId === c3.id)}`);
db.close();
