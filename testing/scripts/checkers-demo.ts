/**
 * Checker package demo (local-only, mock llm — no Ollama, no network).
 *
 * (a) Convergence: Alpha + Beta triple seeds share chunk 3. The shared
 *     passage ranks first with stats.corroborated to prove the audit ran.
 * (b) Quarantine judge over three fixture pairs: Bram/Bram Vale merges with
 *     a proving quote, Cade/Cade Marl is refused for no quote, Dain/Dain
 *     Vale is vetoed despite same:true (they share a speaker scene).
 *
 *   node testing/scripts/checkers-demo.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../fanfable/src/db.ts';
import * as controller from '../../fanfable/src/controller.ts';
import * as lore from '../../fanfable/src/lore.ts';
import * as graph from '../../fanfable/src/graph.ts';
import * as lorebook from '../../fanfable/src/lorebook.ts';
import { MockProvider } from '../../fanfable/src/llm.ts';

const AT = '2026-01-01T00:00:00.000Z';
const RIDGE_QUOTE = 'Serena Marsh watched it from the ridge';

const dir = mkdtempSync(join(tmpdir(), 'checkers-demo-'));
const db = new Db(join(dir, 'demo.db'));
const project = controller.createProject(db, 'demo');
lore.importSource(db, project.id, 'testing/tests/fixtures/sample-book.txt');
const chunks = db.all<{ id: number; locator: string }>(
  'SELECT id, locator FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  project.id,
);
const [c0, c1, c2] = chunks;

const addEntity = (name: string, evidence: string, chunkIds: number[]): number =>
  db.run(
    'INSERT INTO canon_entity (project_id, kind, name, evidence, source_refs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    project.id,
    'character',
    name,
    evidence,
    JSON.stringify(chunkIds.map((id) => ({ source: 's', locator: 'l', chunk: id }))),
    AT,
    AT,
  ).lastInsertRowid;

// --- (a) convergence fixture: Alpha + Beta, chunk 3 shared ---
const alpha = addEntity('Alpha', 'Alpha appears here.', [c0!.id, c2!.id]);
const beta = addEntity('Beta', 'Beta appears here.', [c1!.id, c2!.id]);
db.run(
  'INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  project.id,
  alpha,
  beta,
  'sibling of',
  'Beta is the sibling here.',
  AT,
);

const ctx = await graph.buildPprGraphContext(db, project.id, {
  query: 'Alpha sibling Beta',
  focus: ['Alpha'],
  hops: 1,
});
console.log('(a) passages:', ctx.passages.map((p) => p.chunkId).join(','));
console.log('(a) corroborated:', JSON.stringify(ctx.stats.corroborated));

// --- (b) three quarantine pairs ---
const source = db.get<{ id: number }>('SELECT id FROM canon_source WHERE project_id = ?', project.id)!;
db.run(
  'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words) VALUES (?, ?, 99, ?, ?, ?, 0, 60, 10)',
  source.id,
  project.id,
  'test scene',
  '',
  'Dain said hello first. Then Dain Vale asked why.',
);
for (const [name, evidence] of [
  ['Bram', RIDGE_QUOTE],
  ['Bram Vale', RIDGE_QUOTE],
  ['Cade', 'Cade keeps the bridge.'],
  ['Cade Marl', 'Cade Marl keeps the far bank.'],
  ['Dain', 'Dain crossed at dawn.'],
  ['Dain Vale', 'Dain Vale crossed at dusk.'],
] as [string, string][]) {
  addEntity(name, evidence, [c0!.id]);
}
lorebook.persistQuarantine(db, project.id, [
  { name: 'Bram', candidate: 'Bram Vale', reason: 'demo' },
  { name: 'Cade', candidate: 'Cade Marl', reason: 'demo' },
  { name: 'Dain', candidate: 'Dain Vale', reason: 'demo' },
]);

const judge = new MockProvider();
judge.handler = (req) => {
  const user = req.messages.map((m) => m.content).join('\n');
  const ids = [...user.matchAll(/Pair: ([^/]+) \//g)].map((m) => m[1]!.trim());
  return JSON.stringify({
    rulings: ids.map((id) => {
      const name = id;
      if (name === 'Bram') return { name, candidate: 'Bram Vale', same: true, quote: RIDGE_QUOTE };
      if (name === 'Cade') return { name, candidate: 'Cade Marl', same: true, quote: 'a dragon never seen anywhere' };
      return { name, candidate: 'Dain Vale', same: true, quote: 'Dain crossed at dawn.' };
    }),
  });
};

const { rulings, checked } = await lorebook.judgeQuarantine(judge, db, project.id, {});
console.log(`(b) ${checked} pair(s) judged in one call:`);
for (const r of rulings) {
  console.log(`  ${r.verdict} ${r.name} / ${r.candidate} — ${r.reason}${r.quote ? ` — "${r.quote.slice(0, 60)}"` : ''}`);
}
db.close();
