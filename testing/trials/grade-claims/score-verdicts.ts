/**
 * Score blind grading verdicts against the exporter's key.
 *
 * Reads key.csv (id,pair,relation_ids,signal) and the model's verdicts CSV
 * (id,verdict,quote,locator,reason). Prints overall precision, the same
 * precision split by the signal that was hidden from the judge, and every C
 * pair for demotion. Read-only; writes nothing.
 *
 * Usage:
 *   node --no-warnings testing/trials/grade-claims/score-verdicts.ts <key.csv> <verdicts.csv>
 */
import { readFileSync } from 'node:fs';

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
    } else if (ch !== '\r') {
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

function wilson(p: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 0 };
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

const [keyRaw, verdictsRaw] = process.argv.slice(2);
if (!keyRaw || !verdictsRaw) throw new Error('usage: score-verdicts.ts <key.csv> <verdicts.csv>');

/** Models often wrap the CSV in prose or a fence; start at the header and drop fences. */
function cleanVerdicts(raw: string): string {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*id\s*,\s*verdict/i.test(line));
  return (start >= 0 ? lines.slice(start) : lines)
    .filter((line) => !/^\s*```/.test(line))
    .join('\n');
}

const key = parseCsv(readFileSync(keyRaw, 'utf8'));
const verdicts = new Map(
  parseCsv(cleanVerdicts(readFileSync(verdictsRaw, 'utf8'))).map((row) => [row.id ?? '', row]),
);
const VERDICTS = new Set(['A', 'B', 'C', 'D']);

const missing = key.filter((row) => !VERDICTS.has((verdicts.get(row.id ?? '')?.verdict ?? '').toUpperCase()));
if (missing.length) {
  console.log(
    `PENDING: ${key.length - missing.length}/${key.length} verdicts filled; ` +
      `${missing.length} missing or empty (${missing.slice(0, 8).map((r) => r.id).join(', ')})`,
  );
  process.exit(0);
}

const counts = { A: 0, B: 0, C: 0, D: 0 };
const bySignal = new Map<string, { A: number; B: number; C: number; D: number }>();
const cRows: { id: string; pair: string; reason: string }[] = [];
for (const row of key) {
  const verdict = (verdicts.get(row.id ?? '')?.verdict ?? '').toUpperCase() as 'A' | 'B' | 'C' | 'D';
  counts[verdict]++;
  const signal = row.signal || 'none';
  const bucket = bySignal.get(signal) ?? { A: 0, B: 0, C: 0, D: 0 };
  bucket[verdict]++;
  bySignal.set(signal, bucket);
  if (verdict === 'C') cRows.push({ id: row.id!, pair: row.pair ?? '', reason: verdicts.get(row.id ?? '')?.reason ?? '' });
}

const n = key.length;
const precision = (counts.A + counts.B) / n;
const interval = wilson(precision, n);
console.log(`graded ${n}`);
console.log(`A ${counts.A}, B ${counts.B}, C ${counts.C}, D ${counts.D}`);
console.log(
  `precision (A+B) ${counts.A + counts.B}/${n} = ${(precision * 100).toFixed(1)}% ` +
    `(Wilson 95% ${(interval.lo * 100).toFixed(1)}–${(interval.hi * 100).toFixed(1)})`,
);
for (const [signal, bucket] of [...bySignal.entries()].sort()) {
  const total = bucket.A + bucket.B + bucket.C + bucket.D;
  const share = total ? ((bucket.A + bucket.B) / total) * 100 : 0;
  console.log(`  ${signal.padEnd(16)} n=${total}  A/B ${bucket.A + bucket.B} (${share.toFixed(1)}%)  C ${bucket.C}  D ${bucket.D}`);
}
if (cRows.length) {
  console.log('\nnot established (C):');
  for (const row of cRows) console.log(`  ${row.id} ${row.pair} — ${row.reason || 'no reason'}`);
}
