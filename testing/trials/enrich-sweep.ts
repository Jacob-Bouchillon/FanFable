/**
 * Handoff sweep: enrich the top thin names with vs without handoff.
 *
 * Reuses the isolated temp copies (book-enrich-a = plain order,
 * book-enrich-b = handoff first). Same names, same 12-passage cap,
 * sequential, one model job. Count-only output per name plus totals.
 * No passage prose, no gold keys.
 */
import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import * as loreDiag from '/home/jacob/Documents/FanFable/fanfable/src/lore-diagnostics.ts';
import { readHandoff } from './chain-handoff.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';

const DB = '/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db';
const SRC = 'book-coord-no-notes';
const HANDOFF = '/home/jacob/Documents/FanFable/testing/trials/handoff-test.json';
const NAMES = 5;

const db = new Db(DB);
const t0 = Date.now();
try {
  const off = readHandoff(HANDOFF);
  const srcRow = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', SRC)!;
  const texts = db.all<{ text: string }>(
    'SELECT text FROM canon_chunk WHERE project_id = ? ORDER BY seq', srcRow.id,
  );
  const ranked = off.thin
    .map((t) => ({
      n: texts.filter((c) => c.text.toLowerCase().includes(t.name.toLowerCase())).length,
    }))
    .map((r, i) => ({ ...r, name: off.thin[i]!.name }))
    .filter((r) => r.n > 4)
    .sort((a, b) => b.n - a.n)
    .slice(0, NAMES);
  console.log(`sweep names: ${ranked.length} (matched: ${ranked.map((r) => r.n).join('/')})`);
  if (!ranked.length) throw new Error('no thin names over 4 matches');

  const llm = baselineClient();
  const aId = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'book-enrich-a')!.id;
  const bId = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'book-enrich-b')!.id;
  const counts = (pid: number): { rel: number; fact: number } => ({
    rel: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', pid)!.n,
    fact: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', pid)!.n,
  });

  let aRel = 0, aFact = 0, bRel = 0, bFact = 0;
  let i = 0;
  for (const t of ranked) {
    i++;
    const b0 = counts(aId);
    const r0 = await loreDiag.enrichEntity(db, llm, aId, t.name, { maxPassages: 12 });
    const d0 = counts(aId);
    aRel += d0.rel - b0.rel;
    aFact += d0.fact - b0.fact;
    const b1 = counts(bId);
    const r1 = await loreDiag.enrichEntity(db, llm, bId, t.name, { maxPassages: 12, handoffPath: HANDOFF });
    const d1 = counts(bId);
    bRel += d1.rel - b1.rel;
    bFact += d1.fact - b1.fact;
    console.log(`name${i}: plain +${d0.rel - b0.rel}r/+${d0.fact - b0.fact}f (${r0.passages}p) vs handoff +${d1.rel - b1.rel}r/+${d1.fact - b1.fact}f (${r1.passages}p)`);
  }
  console.log(`SWEEP DONE in ${((Date.now() - t0) / 60000).toFixed(1)} min: plain +${aRel}r/+${aFact}f vs handoff +${bRel}r/+${bFact}f`);
} finally {
  db.close();
}
