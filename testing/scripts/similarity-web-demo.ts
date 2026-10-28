/**
 * Similarity-web demo (local-only, no model — counts and locators).
 *
 * The answer needs an alias hop: the query matches only the Ash–Bram link,
 * Bram Vale shares only a quarantined alias edge with Bram, and only Bram
 * Vale's passage answers. The 1-hop walk reaches Bram but never Bram Vale;
 * PPR spreads along the alias edge and surfaces the passage.
 *
 *   node testing/scripts/similarity-web-demo.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../fanfable/src/db.ts';
import * as controller from '../../fanfable/src/controller.ts';
import * as lore from '../../fanfable/src/lore.ts';
import * as graph from '../../fanfable/src/graph.ts';

const AT = '2026-01-01T00:00:00.000Z';
const dir = mkdtempSync(join(tmpdir(), 'similarity-web-demo-'));
const db = new Db(join(dir, 'demo.db'));
const project = controller.createProject(db, 'demo');
lore.importSource(db, project.id, 'testing/tests/fixtures/sample-book.txt');
const chunks = db.all<{ id: number; locator: string }>(
  'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  project.id,
);
const [c0, c1, c2] = chunks;
// Bram and Bram Vale speak in one passage, so the merge rules veto them:
// probable alias (0.5), never merged.
const source = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ?', project.id)!;
db.run(
  'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words) VALUES (?, ?, 99, ?, ?, ?, 0, 60, 10)',
  source.id,
  project.id,
  'test scene',
  '',
  'Bram said hello first. Then Bram Vale asked why.',
);

// One event naming only Ash: the query seeds here, a single root, so the
// 1-hop walk reaches Ash but never the far side of the alias edge.
db.run(
  'INSERT INTO canon_event (project_id, source_id, chunk_id, locator, title, summary, participants, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  project.id,
  source.id,
  c0!.id,
  c0!.locator,
  'The ridge watch',
  'Ash keeps the ridge watch at dawn.',
  JSON.stringify(['Ash']),
  AT,
);

const ids = new Map<string, number>();
for (const [name, chunk] of [
  ['Ash', c0],
  ['Bram', c1],
  ['Bram Vale', c2],
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
db.run(
  'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  project.id,
  ids.get('Ash')!,
  ids.get('Bram')!,
  'sister of',
  'Bram stands with Ash.',
  AT,
);

const query = 'what happened at the ridge watch';
const g = graph.loadGraph(db, project.id);
const web = graph.countWebEdges(g);
console.log(`query: ${query}`);
console.log('path used: event --participates--> Ash --sister of--> Bram --alias_of--> Bram Vale --mentions_in--> passage');
console.log(`web edges: alias=${web.aliasEdges} resemblance=${web.resemblanceEdges} cooccurrence=${web.cooccurrenceEdges}`);

const oldCtx = graph.buildGraphContext(db, project.id, { query, focus: ['Ash'], hops: 1, seedMode: 'triple' });
const newCtx = await graph.buildPprGraphContext(db, project.id, { query, focus: ['Ash'], hops: 1 });
const show = (label: string, ctx: graph.GraphContext) =>
  console.log(`${label}: ${ctx.passages.map((p) => `chunk ${p.chunkId}`).join(' | ') || '(none)'}`);
show('old 1-hop walk passages', oldCtx);
show('new PPR passages      ', newCtx);
console.log(`web stats on the package: ${JSON.stringify(newCtx.stats.web)}`);
console.log(`ppr: nodes=${newCtx.stats.ppr?.nodes} iterations=${newCtx.stats.ppr?.iterations} converged=${newCtx.stats.ppr?.converged}`);

const missedBefore = !oldCtx.passages.some((p) => p.chunkId === c2!.id);
const foundAfter = newCtx.passages.some((p) => p.chunkId === c2!.id);
console.log(`Bram Vale's passage (chunk ${c2!.id}) missed before: ${missedBefore}, found after: ${foundAfter}`);
db.close();
if (!missedBefore || !foundAfter) process.exitCode = 1;
