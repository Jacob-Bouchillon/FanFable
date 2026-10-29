/**
 * Reason-check experiment (trials, no model calls).
 *
 * usage: node reason-check.ts <results.json> <verdicts.txt> [out.json]
 *
 * The model's verdict can be true in the fiction while its stated reason rests
 * on facts the passage does not contain. This compares the reason's content
 * words against the passage mechanically — no word lists of relationship terms,
 * only ordinary stopwords — and reports how often it flags a wrong verdict
 * versus a right one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/db.ts';
import { canonicalName } from '../../../fanfable/src/names.ts';

const resultsPath = process.argv[2];
const verdictsPath = process.argv[3] ?? 'testing/trials/adjudication/gold-verdicts-v2.txt';
const outPath = process.argv[4] ?? 'testing/trials/claim-confidence/reason-check.json';
if (!resultsPath) {
  console.error('usage: reason-check.ts <results.json> <verdicts.txt> [out.json]');
  process.exit(2);
}

const verdicts = new Map<number, string>();
for (const line of readFileSync(verdictsPath, 'utf8').split('\n')) {
  for (const part of line.split(',')) {
    if (!part.includes(':')) continue;
    const [k, v] = part.split(':');
    verdicts.set(Number(k), v.trim());
  }
}
const goldMap = JSON.parse(readFileSync('testing/trials/adjudication/gold-map.json', 'utf8')) as {
  gold: number;
  db: string;
  relId: number;
}[];
const results = JSON.parse(readFileSync(resultsPath, 'utf8')) as {
  rows: { gold: number; verdict: string; relationship: string; why: string }[];
};

const STOP = new Set(
  ('the a an and or but if then than that this these those is are was were be been being am do does did not no ' +
    'of to in on at by for with from as it its he she they them him her his hers their theirs we us our i me my ' +
    'you your yours who whom which what when where why how there here all any both each few more most other some ' +
    'such only own same so too very can will just should now also into over under about between through during ' +
    'before after above below up down out off again further once because while both same just').split(' '),
);

const check = (why: string, passage: string, names: string[]): { flagged: boolean; missing: string[] } => {
  const hay = canonicalName(passage);
  const words = canonicalName(why).split(' ').filter(Boolean);
  const nameTokens = new Set(names.flatMap((n) => canonicalName(n).split(' ').filter(Boolean)));
  const content = [...new Set(words.filter((w) => w.length >= 4 && !STOP.has(w) && !nameTokens.has(w)))];
  const missing = content.filter((w) => {
    if (hay.includes(w)) return false;
    if (hay.includes(w.replace(/s$/, ''))) return false;
    if (hay.includes(`${w}s`)) return false;
    if (hay.includes(`${w}d`)) return false;
    if (hay.includes(w.replace(/e$/, 'ing'))) return false;
    return true;
  });
  return { flagged: content.length > 0 && missing.length / content.length >= 0.5, missing };
};

const cache = new Map<string, Db>();
const rows: { gold: number; actual: string; predicted: string; flagged: boolean; missing: string[] }[] = [];

for (const r of results.rows) {
  const g = goldMap.find((x) => x.gold === r.gold);
  if (!g) continue;
  const path = `testing/trials/model-ab/${g.db}.db`;
  let db = cache.get(path);
  if (!db) {
    db = new Db(path);
    cache.set(path, db);
  }
  const row = db.get<{ a: string; b: string; refs: string }>(
    `SELECT a.name AS a, b.name AS b, coalesce(r.source_refs,'[]') AS refs
       FROM canon_relation r JOIN canon_entity a ON a.id=r.from_entity JOIN canon_entity b ON b.id=r.to_entity
      WHERE r.id = ?`,
    g.relId,
  );
  let passage = '';
  if (row) {
    try {
      const refs = JSON.parse(row.refs) as { chunk?: unknown }[];
      if (typeof refs[0]?.chunk === 'number') {
        passage = db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', refs[0]!.chunk as number)?.text ?? '';
      }
    } catch {
      /* no refs */
    }
  }
  if (!row || !passage) continue;
  const { flagged, missing } = check(r.why, passage, [row.a, row.b]);
  rows.push({
    gold: r.gold,
    actual: verdicts.get(r.gold) === 'S' ? 'supported' : 'unsupported',
    predicted: r.relationship === 'lasting' ? 'lasting' : 'not',
    flagged,
    missing,
  });
}

const cell = (actual: string, predicted: string) => rows.filter((r) => r.actual === actual && r.predicted === predicted);
const table = {
  tp: { n: cell('supported', 'lasting').length, flagged: cell('supported', 'lasting').filter((r) => r.flagged).length },
  fp: { n: cell('unsupported', 'lasting').length, flagged: cell('unsupported', 'lasting').filter((r) => r.flagged).length },
  tn: { n: cell('unsupported', 'not').length, flagged: cell('unsupported', 'not').filter((r) => r.flagged).length },
  fn: { n: cell('supported', 'not').length, flagged: cell('supported', 'not').filter((r) => r.flagged).length },
};
const kept = rows.filter((r) => !r.flagged && r.predicted === 'lasting');
const keptTp = kept.filter((r) => r.actual === 'supported').length;

writeFileSync(outPath, JSON.stringify({ table, rows }, null, 1));
console.log(
  JSON.stringify(
    {
      ...table,
      flaggedFalsePositiveRate: table.fp.n ? Number((table.fp.flagged / table.fp.n).toFixed(2)) : null,
      flaggedTruePositiveRate: table.tp.n ? Number((table.tp.flagged / table.tp.n).toFixed(2)) : null,
      adjustedPrecision: kept.length ? Number((keptTp / kept.length).toFixed(2)) : null,
      out: outPath,
    },
    null,
    1,
  ),
);
