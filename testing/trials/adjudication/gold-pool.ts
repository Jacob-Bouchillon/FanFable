/**
 * Gold-set pool (trials only): accepted rows plus scan candidates from every
 * bank given, deduplicated, shuffled, capped. Group and verdicts stay in the
 * key file; the sheet carries only id, pair and sentence.
 *
 * usage: node gold-pool.ts <target> <db...>
 */
import { Db } from '../../../fanfable/src/core/db.ts';
import { scanSentenceCandidates } from '../../../fanfable/src/lorebook.ts';
import { writeFileSync } from 'node:fs';

const target = Number(process.argv[2] ?? 300);
const dbs = process.argv.slice(3);
if (!dbs.length) {
  console.error('usage: gold-pool.ts <target> <db...>');
  process.exit(2);
}

interface Row {
  id: number;
  group: 'accepted' | 'candidate';
  pair: string;
  sentence: string;
  db: string;
}

const pool: Row[] = [];
const seen = new Set<string>();
const add = (group: Row['group'], pair: string, sentence: string, db: string): void => {
  const key = `${group}|${pair}|${sentence.slice(0, 120)}`;
  if (seen.has(key)) return;
  seen.add(key);
  pool.push({ id: 0, group, pair, sentence, db });
};

for (const path of dbs) {
  const db = new Db(path);
  const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
  if (!proj) {
    db.close();
    continue;
  }
  for (const r of db.all<{ fn: string; tn: string; evidence: string }>(
    `SELECT a.name fn, b.name tn, r.evidence FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND r.review_status = 'accepted'`,
    proj.id,
  )) {
    add('accepted', `${r.fn} / ${r.tn}`, r.evidence, path);
  }
  for (const candidate of scanSentenceCandidates(db, proj.id)) {
    add('candidate', `${candidate.fromName} / ${candidate.toName}`, candidate.sentence, path);
  }
  db.close();
}

const shuffle = <T>(list: T[]): T[] => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

const accepted = shuffle(pool.filter((row) => row.group === 'accepted'));
const candidates = shuffle(pool.filter((row) => row.group === 'candidate'));
const rows = shuffle([...accepted, ...candidates]).slice(0, target);
rows.forEach((row, index) => {
  row.id = index + 1;
});

const lines = [
  '# Gold-set pool',
  '',
  'Columns: id, pair, sentence. Nothing else is provided on purpose.',
  '',
  '| id | pair | sentence |',
  '|---:|---|---|',
];
for (const row of rows) {
  const sentence = row.sentence.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  lines.push(`| ${row.id} | ${row.pair} | ${sentence} |`);
}
lines.push('');
writeFileSync('testing/trials/adjudication/gold-sheet.md', lines.join('\n'));
writeFileSync(
  'testing/trials/adjudication/gold-key.json',
  JSON.stringify(rows.map((row) => ({ id: row.id, group: row.group, db: row.db })), null, 1),
);
console.log(
  JSON.stringify({
    pool: pool.length,
    accepted: accepted.length,
    candidates: candidates.length,
    sheet: rows.length,
  }),
);
