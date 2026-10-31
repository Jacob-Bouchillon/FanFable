/**
 * Hippo H2 demos (local-only, fake embedder — no Ollama, no network).
 *
 * 1. Semantic seeds: the query says "sibling", nothing stored says
 *    "sibling" (only "brother"). FTS5 and triple-seeding miss; dense hits.
 *    Shows query, lexical seeds, dense seeds, PPR passages before/after.
 * 2. Degradation: a dead embedder returns locator lists identical to the
 *    lexical run.
 *
 *   node testing/scripts/hippo-h2-demo.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../fanfable/src/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as lore from '../../fanfable/src/answer/lore.ts';
import * as graph from '../../fanfable/src/graph.ts';
import * as embeddings from '../../fanfable/src/embeddings.ts';
import type { EmbedFn } from '../../fanfable/src/embeddings.ts';

const AT = '2026-01-01T00:00:00.000Z';
const MODEL = 'demo-fake';

const fake: EmbedFn = async (texts: string[]) =>
  texts.map((t) => {
    const lower = t.toLowerCase();
    if (lower.includes('sibling') || lower.includes('brother')) return [1, 0, 0];
    if (lower.includes('bridge')) return [0, 1, 0];
    return [0, 0, 1];
  });

const dir = mkdtempSync(join(tmpdir(), 'hippo-h2-demo-'));
const db = new Db(join(dir, 'demo.db'));
const project = controller.createProject(db, 'demo');
lore.importSource(db, project.id, 'testing/tests/fixtures/sample-book.txt');
const chunks = db.all<{ id: number; locator: string }>(
  'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  project.id,
);
const [c0] = chunks;
const aids = new Map<string, number>();
for (const name of ['Astra', 'Bram']) {
  aids.set(
    name,
    db.run(
      'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      project.id,
      'character',
      name,
      `${name} appears here.`,
      JSON.stringify([{ source: 'sample', locator: c0!.locator, chunk: c0!.id }]),
      AT,
      AT,
    ).lastInsertRowid,
  );
}
db.run(
  'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  project.id,
  aids.get('Astra')!,
  aids.get('Bram')!,
  'sister of',
  'Bram is the brother here.',
  AT,
);

const backfill = await embeddings.embedBackfill(db, project.id, {
  baseUrl: 'http://127.0.0.1:9',
  model: MODEL,
  embedFn: fake,
});
console.log(`backfill: embedded=${backfill.embedded} skipped=${backfill.skipped} model=${backfill.model} dims=${backfill.dims}`);

const query = "who is Astra's sibling";
const fts = lore.searchCanon(db, project.id, 'sibling', { limit: 6 });
console.log(`\nquery: ${query}`);
console.log(`FTS5 hits for "sibling": ${fts.length}`);

const g = graph.loadGraph(db, project.id);
const lexical = graph.resolveQuerySeeds(g, query, ['Astra']);
console.log(`lexical seeds: via=${lexical.via} roots=${lexical.roots.join(', ') || '(none)'}`);

const dense = await graph.resolveDenseSeeds(db, project.id, g, query, { embedFn: fake, model: MODEL });
console.log(`dense seeds: ${dense.seeds.map((s) => `${s.id}@${s.w}`).join(', ') || '(none)'}`);
console.log(`dense passages: ${dense.passages.map((p) => `chunk ${p.chunkId} (${p.score.toFixed(2)})`).join(', ') || '(none)'}`);

const before = await graph.buildPprGraphContext(db, project.id, { query, focus: ['Astra'], hops: 1 });
const after = await graph.buildPprGraphContext(db, project.id, {
  query,
  focus: ['Astra'],
  hops: 1,
  embed: { embedFn: fake, model: MODEL },
});
console.log(`PPR passages before: ${before.passages.map((p) => p.locator).join(' | ') || '(none)'}`);
console.log(`PPR passages after:  ${after.passages.map((p) => p.locator).join(' | ') || '(none)'}`);

const query2 = 'who is the sibling here';
const before2 = await graph.buildPprGraphContext(db, project.id, { query: query2, focus: ['Nobody'], hops: 1 });
const after2 = await graph.buildPprGraphContext(db, project.id, {
  query: query2,
  focus: ['Nobody'],
  hops: 1,
  embed: { embedFn: fake, model: MODEL },
});
console.log(`\nquery: ${query2} (no entity is named, so lexical seeding is empty)`);
console.log(`PPR passages before: ${before2.passages.map((p) => p.locator).join(' | ') || '(none)'}`);
console.log(`PPR passages after:  ${after2.passages.map((p) => p.locator).join(' | ') || '(none)'}`);
console.log(`pprFallback: ${after2.stats.pprFallback === true} (false is correct here — dense seeds let PPR itself rank; the flag is for PPR-empty, covered in tests)`);

const dead = await graph.buildPprGraphContext(db, project.id, {
  query,
  focus: ['Astra'],
  hops: 1,
  embed: { embedFn: async () => undefined, model: MODEL },
});
const same =
  JSON.stringify(dead.passages.map((p) => p.locator)) === JSON.stringify(before.passages.map((p) => p.locator));
console.log(`\ndegradation: dead-embedder locators identical to lexical: ${same}`);
db.close();
if (!same) process.exitCode = 1;
