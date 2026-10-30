/**
 * Regression check: does a bank still hold what we once proved?
 *
 * Loads testing/trials/checks/regression-sheet.json (frozen triple keys with how
 * each was validated) and diffs a bank's triple keys against it. No model,
 * read-only database. Count-only output: still-found, missing, new.
 * Missing rows are a regression signal, never a truth verdict — the sheet
 * is our own validated history, not gold.
 *
 * Usage:
 *   node --no-warnings testing/trials/checks/regression-check.ts <bank-name>
 */
import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import { readFileSync } from 'node:fs';

const norm = (n: string): string[] =>
  n.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter((t) => t.length >= 3);
const key = (a: string, b: string, kind: string): string => {
  const A = norm(a).sort().join('+');
  const B = norm(b).sort().join('+');
  return [A, B].sort().join('|') + '=' + kind.trim().toLowerCase();
};

const bankName = process.argv[2];
if (!bankName) throw new Error('usage: regression-check.ts <bank-name>');
const sheet = JSON.parse(readFileSync('/home/jacob/Documents/FanFable/testing/trials/checks/regression-sheet.json', 'utf8')) as {
  version: number;
  triples: { key: string }[];
};
if (sheet.version !== 1) throw new Error('unknown sheet version');

const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
try {
  const id = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', bankName)!.id;
  const rels = db.all<{ f: string; t: string; kind: string }>(
    `SELECT fe.name AS f, te.name AS t, r.kind FROM canon_relation r
     JOIN canon_entity fe ON fe.id = r.from_entity JOIN canon_entity te ON te.id = r.to_entity
     WHERE r.project_id = ? ORDER BY r.id`,
    id,
  );
  const have = new Set(rels.map((r) => key(r.f, r.t, r.kind)));
  const want = new Set(sheet.triples.map((t) => t.key));
  let found = 0;
  for (const k of want) if (have.has(k)) found++;
  let extra = 0;
  for (const k of have) if (!want.has(k)) extra++;
  console.log(JSON.stringify({
    bank: bankName,
    sheetTriples: want.size,
    bankTriples: have.size,
    stillFound: found,
    missing: want.size - found,
    newUnsheeted: extra,
  }));
} finally {
  db.close();
}
