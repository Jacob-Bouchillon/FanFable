/**
 * Score judged unproposed-pair packets with population weights.
 *
 * Reads sample.csv (id, pair, stratum, pop_weight, locators) and a verdicts
 * CSV (id, verdict, quote, locator, reason). With no verdicts file, or any
 * unfilled verdict, prints PENDING and exits 0. Never invents verdicts.
 *
 * Usage:
 *   node --no-warnings testing/trials/discovery/score-unproposed.ts <sample.csv> [verdicts.csv]
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VERDICTS = new Set(['A', 'B', 'C', 'D']);

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch === '\r') {
      // skip; \n handles the break
    } else {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const head = (rows.shift() ?? []).map((h) => h.trim());
  return rows
    .filter((r) => r.some((c) => c.trim().length > 0))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

/** Wilson 95% interval for a proportion (z = 1.96). */
function wilson(p: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 0 };
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

const [sampleRaw, verdictsRaw] = process.argv.slice(2);
if (!sampleRaw) throw new Error('usage: score-unproposed.ts <sample.csv> [verdicts.csv]');

const sample = parseCsv(readFileSync(resolve(sampleRaw), 'utf8'));
if (!sample.length) throw new Error('sample.csv holds no rows');
const weight = new Map<string, number>();
const pairOf = new Map<string, string>();
for (const row of sample) {
  const id = row.id ?? '';
  const w = Number(row.pop_weight);
  if (!id || !Number.isFinite(w) || w <= 0) throw new Error(`sample.csv: bad row for id "${id}"`);
  weight.set(id, w);
  pairOf.set(id, row.pair ?? id);
}
const totalWeight = [...weight.values()].reduce((a, b) => a + b, 0);

if (!verdictsRaw || !existsSync(resolve(verdictsRaw))) {
  console.log(`PENDING: no verdicts file (${sample.length} pairs await judging)`);
  process.exit(0);
}
const verdictRows = parseCsv(readFileSync(resolve(verdictsRaw), 'utf8'));
const verdictOf = new Map<string, Record<string, string>>();
for (const row of verdictRows) {
  if (row.id) verdictOf.set(row.id, row);
}
const missing = sample.filter((row) => {
  const v = (verdictOf.get(row.id ?? '')?.verdict ?? '').trim().toUpperCase();
  return !VERDICTS.has(v);
});
if (missing.length) {
  console.log(
    `PENDING: ${sample.length - missing.length}/${sample.length} verdicts filled; ` +
      `${missing.length} missing or empty (${missing.slice(0, 10).map((r) => r.id).join(', ')}${missing.length > 10 ? ', …' : ''})`,
  );
  process.exit(0);
}

const counts = { A: 0, B: 0, C: 0, D: 0 };
const wsum = { A: 0, B: 0, C: 0, D: 0 };
for (const row of sample) {
  const v = verdictOf.get(row.id ?? '')!.verdict.trim().toUpperCase() as 'A' | 'B' | 'C' | 'D';
  counts[v]++;
  wsum[v] += weight.get(row.id ?? '')!;
}
const judged = sample.length;
const pct = (v: 'A' | 'B' | 'C' | 'D'): number => (totalWeight ? (wsum[v] / totalWeight) * 100 : 0);
// Weighted A+B share, with the Wilson interval on the judged count.
const pAB = totalWeight ? (wsum.A + wsum.B) / totalWeight : 0;
const ci = wilson(pAB, judged);
const est = (p: number): number => Math.round(p * totalWeight);

console.log(`judged: ${judged}/${sample.length}`);
console.log('counts: ' + (['A', 'B', 'C', 'D'] as const).map((v) => `${v} ${counts[v]}`).join(', '));
console.log('weighted %: ' + (['A', 'B', 'C', 'D'] as const).map((v) => `${v} ${pct(v).toFixed(1)}`).join(', '));
console.log(
  `A+B weighted ${(pAB * 100).toFixed(1)}% (Wilson 95% ${(ci.lo * 100).toFixed(1)}–${(ci.hi * 100).toFixed(1)}; n=${judged})`,
);
console.log(
  `estimated recoverable pairs in population ${totalWeight.toFixed(0)}: ${est(pAB)} (95% ${est(ci.lo)}–${est(ci.hi)})`,
);
const ab = sample.filter((row) => {
  const v = verdictOf.get(row.id ?? '')!.verdict.trim().toUpperCase();
  return v === 'A' || v === 'B';
});
if (ab.length) {
  console.log('');
  console.log('A/B pairs:');
  for (const row of ab) {
    const v = verdictOf.get(row.id ?? '')!;
    console.log(`  ${row.id} [${v.verdict.trim().toUpperCase()}] ${pairOf.get(row.id ?? '')}`);
    if (v.quote) console.log(`    "${v.quote}" [${v.locator || 'no locator'}]`);
    if (v.reason) console.log(`    why: ${v.reason}`);
  }
}
