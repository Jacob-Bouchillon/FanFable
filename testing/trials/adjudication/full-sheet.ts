/**
 * Full blind sheet (trials only): every accepted row and every unbanked scan
 * candidate, stripped of group, claimed kind and verdicts.
 *
 * usage: node full-sheet.ts <db...>
 */
import { Db } from '../../../fanfable/src/core/db.ts';
import { scanSentenceCandidates } from '../../../fanfable/src/lorebook.ts';
import { writeFileSync } from 'node:fs';

const dbs = process.argv.slice(2);
if (!dbs.length) {
  console.error('usage: full-sheet.ts <db...>');
  process.exit(2);
}

interface Row {
  id: number;
  group: 'accepted' | 'rejected';
  pair: string;
  sentence: string;
  relationId: number;
  db: string;
}

const rows: Row[] = [];
let nextId = 1;

for (const path of dbs) {
  const db = new Db(path);
  const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
  if (!proj) {
    db.close();
    continue;
  }
  const accepted = db.all<{ id: number; fn: string; tn: string; evidence: string }>(
    `SELECT r.id, a.name fn, b.name tn, r.evidence
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND r.review_status = 'accepted'
      ORDER BY r.id`,
    proj.id,
  );
  for (const row of accepted) {
    rows.push({
      id: nextId++,
      group: 'accepted',
      pair: `${row.fn} / ${row.tn}`,
      sentence: row.evidence,
      relationId: row.id,
      db: path,
    });
  }
  const banked = new Set<string>(
    db
      .all<{ fn: string; tn: string }>(
        `SELECT a.name fn, b.name tn FROM canon_relation r
           JOIN canon_entity a ON a.id = r.from_entity
           JOIN canon_entity b ON b.id = r.to_entity WHERE r.project_id = ?`,
        proj.id,
      )
      .flatMap((row) => [`${row.fn}|${row.tn}`, `${row.tn}|${row.fn}`]),
  );
  for (const candidate of scanSentenceCandidates(db, proj.id)) {
    if (banked.has(`${candidate.fromName}|${candidate.toName}`)) continue;
    rows.push({
      id: nextId++,
      group: 'rejected',
      pair: `${candidate.fromName} / ${candidate.toName}`,
      sentence: candidate.sentence,
      relationId: 0,
      db: path,
    });
  }
  db.close();
}

const lines = [
  '# Blind relationship sheet',
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
writeFileSync('testing/trials/adjudication/full-sheet.md', lines.join('\n'));
writeFileSync(
  'testing/trials/adjudication/full-key.json',
  JSON.stringify(rows.map((row) => ({ id: row.id, group: row.group, relationId: row.relationId, db: row.db })), null, 1),
);
console.log(JSON.stringify({ rows: rows.length, accepted: rows.filter((r) => r.group === 'accepted').length, rejected: rows.filter((r) => r.group === 'rejected').length }));
