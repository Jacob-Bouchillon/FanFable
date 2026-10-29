/**
 * Random sample claim sheets from a bank, trials scope.
 *
 * Draws K random samples of N banked ties (seeded, reproducible) as judging
 * sheets in the claim-sheet format. Averages across samples estimate
 * precision without judging the whole bank. No model, no writes to the bank.
 *
 * Usage:
 *   node --no-warnings testing/trials/sample-sheet.ts <bank> <n> <k> <seed> <out-prefix>
 */
import { writeFileSync } from 'node:fs';
import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';

const csvCell = (s: string): string => {
  const t = String(s ?? '');
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

// Seeded PRNG (mulberry32) so samples are reproducible.
const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const [bank, nRaw, kRaw, seedRaw, prefix] = process.argv.slice(2);
const N = Number(nRaw ?? 30);
const K = Number(kRaw ?? 3);
const SEED = Number(seedRaw ?? 42);
if (!bank || !prefix || !N || !K) throw new Error('usage: sample-sheet.ts <bank> <n> <k> <seed> <out-prefix>');

const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
try {
  const id = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', bank)?.id;
  if (!id) throw new Error(`no bank named "${bank}"`);
  const rows = db.all<{
    from_name: string; to_name: string; kind: string; evidence: string; locator: string | null; seq: number | null;
  }>(
    `SELECT fe.name AS from_name, te.name AS to_name, r.kind AS kind,
            r.evidence AS evidence, c.locator AS locator, c.seq AS seq
       FROM canon_relation r
       JOIN canon_entity fe ON fe.id = r.from_entity
       JOIN canon_entity te ON te.id = r.to_entity
       LEFT JOIN canon_chunk c ON c.id = (
         SELECT CAST(json_extract(value, '$.chunk') AS INTEGER)
         FROM json_each(r.source_refs) LIMIT 1
       )
      WHERE r.project_id = ? ORDER BY r.id`,
    id,
  );
  const rand = rng(SEED);
  for (let s = 0; s < K; s++) {
    const idx = rows.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [idx[i], idx[j]] = [idx[j]!, idx[i]!];
    }
    const pick = idx.slice(0, Math.min(N, rows.length)).sort((a, b) => a - b);
    const lines = ['id,from_name,to_name,label,quote,place,verdict'];
    pick.forEach((ri, i) => {
      const r = rows[ri]!;
      const place = r.locator ?? (r.seq !== null ? `passage ${r.seq}` : 'unplaced');
      lines.push([String(i + 1), r.from_name, r.to_name, r.kind, r.evidence, place, ''].map(csvCell).join(','));
    });
    const out = `${prefix}-${s + 1}.csv`;
    writeFileSync(out, lines.join('\n') + '\n');
    console.log(JSON.stringify({ sample: s + 1, rows: pick.length, out }));
  }
  console.log(JSON.stringify({ bank, ties: rows.length, samples: K, perSample: N, seed: SEED }));
} finally {
  db.close();
}
