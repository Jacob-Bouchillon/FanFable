/**
 * Universal claim-sheet builder, trials scope.
 *
 * Builds a human judging sheet from ANY bank: one row per banked tie with
 * the model's label, its exact quote, and its place, plus an empty verdict
 * column for the judge. No book-specific names, lists, or thresholds in
 * here — bank name and output path come from argv. No model calls, no
 * database writes; the only write is the sheet file itself.
 *
 * Sheet columns (CSV): id, from_name, to_name, label, quote, place, verdict
 * The judge fills `verdict` per row (e.g. true / false / unclear) and
 * reports totals only, so tuning stays blind to individual answers.
 *
 * Usage:
 *   node --no-warnings testing/trials/sheets/prep-sheet.ts <bank-name> <out.csv>
 */
import { writeFileSync } from 'node:fs';
import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';

const csvCell = (v: string): string => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const bank = process.argv[2];
const out = process.argv[3];
if (!bank || !out) throw new Error('usage: prep-sheet.ts <bank-name> <out.csv>');

const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
try {
  const id = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', bank)?.id;
  if (!id) throw new Error(`no bank named "${bank}"`);
  const rows = db.all<{
    from_name: string;
    to_name: string;
    kind: string;
    description: string;
    evidence: string;
    locator: string | null;
    seq: number | null;
  }>(
    `SELECT fe.name AS from_name, te.name AS to_name, r.kind AS kind,
            r.description AS description, r.evidence AS evidence,
            c.locator AS locator, c.seq AS seq
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
  const lines = ['id,from_name,to_name,label,quote,place,verdict'];
  rows.forEach((r, i) => {
    const place = r.locator ?? (r.seq !== null ? `passage ${r.seq}` : 'unplaced');
    lines.push(
      [String(i + 1), r.from_name, r.to_name, r.kind, r.evidence, place, '']
        .map(csvCell)
        .join(','),
    );
  });
  writeFileSync(out, lines.join('\n') + '\n');
  console.log(JSON.stringify({ bank, rows: rows.length, out }));
} finally {
  db.close();
}
