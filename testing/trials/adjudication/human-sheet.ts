/**
 * Human labelling sheet (trials only).
 *
 * Freezes the accepted rows, asks verifier A and B for their verdicts, then
 * writes a sheet of 30 rows: half where the two verifiers disagreed (the
 * informative cases), half drawn from the rest. The sheet omits verifier
 * verdicts so the reader judges the source, not the machine.
 *
 * usage: node human-sheet.ts <db...>
 */
import { Db } from '../../../fanfable/src/db.ts';
import { writeFileSync } from 'node:fs';

const dbs = process.argv.slice(2);
if (!dbs.length) {
  console.error('usage: human-sheet.ts <db...>');
  process.exit(2);
}

interface Row {
  id: number;
  pair: string;
  sentence: string;
  kind: string;
  source: string;
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
  for (const r of db.all<{ fn: string; tn: string; evidence: string; kind: string }>(
    `SELECT a.name fn, b.name tn, r.evidence, r.kind FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ? AND r.review_status = 'accepted'`,
    proj.id,
  )) {
    rows.push({ id: nextId++, pair: `${r.fn} / ${r.tn}`, sentence: r.evidence, kind: r.kind, source: path });
  }
  db.close();
}

const ask = async (model: string, system: string, user: string): Promise<Record<string, unknown> | null> => {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      format: 'json',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      options: { temperature: 0, num_ctx: 4096, num_predict: 120 },
    }),
  });
  const data = (await res.json()) as { message?: { content?: string } };
  const raw = data.message?.content ?? '';
  try {
    return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const verdictA = async (row: Row): Promise<boolean | null> => {
  const parsed = await ask(
    'qwen2.5:7b',
    'You judge one sentence from a novel. Reply with JSON only: {"supported": true or false}.',
    `Sentence: ${row.sentence}\nQuestion: does this sentence establish a lasting relationship between ${row.pair.replace(' / ', ' and ')}? ` +
      'A single meeting, gift, order or conversation is not a lasting relationship.',
  );
  return parsed && typeof parsed.supported === 'boolean' ? (parsed.supported as boolean) : null;
};

const verdictB = async (row: Row): Promise<boolean | null> => {
  const parsed = await ask(
    'qwen2.5:7b',
    'You judge one sentence from a novel. Reply with JSON only: {"relation": true or false}.',
    `Sentence: ${row.sentence}\nQuestion: does this sentence establish that ${row.pair.replace(' / ', ' and ')} have a lasting relationship?`,
  );
  return parsed && typeof parsed.relation === 'boolean' ? (parsed.relation as boolean) : null;
};

const scored: { row: Row; a: boolean | null; b: boolean | null }[] = [];
for (const row of rows) {
  const [a, b] = await Promise.all([verdictA(row), verdictB(row)]);
  scored.push({ row, a, b });
}

const disagree = scored.filter((s) => s.a !== null && s.b !== null && s.a !== s.b).map((s) => s.row);
const rest = scored.filter((s) => !disagree.includes(s.row)).map((s) => s.row);
const pick = [...disagree, ...rest].slice(0, 30);

const lines = [
  '# Human labelling sheet',
  '',
  'For each row, judge the **cited sentence only**. Two separate questions:',
  '',
  '1. **Support** — does the sentence establish a relationship between these two specific characters?',
  '   `S` supported (explicit or unambiguous) · `C` context-dependent (needs nearby passages) · `U` unsupported',
  '2. **Kind and direction** — does it establish this exact kind, in this direction?',
  '   `Y` yes · `N` no · `X` symmetric/unclear',
  '',
  'Fill the last two columns. Do not change anything else.',
  '',
  '| id | pair | claimed kind | sentence | support (S/C/U) | kind+direction (Y/N/X) |',
  '|---:|---|---|---|---|---|',
];
for (const row of pick) {
  const sentence = row.sentence.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  lines.push(`| ${row.id} | ${row.pair} | ${row.kind} | ${sentence} |  |  |`);
}
lines.push('');

writeFileSync('testing/trials/adjudication/human-sheet.md', lines.join('\n'));
writeFileSync(
  'testing/trials/adjudication/verifier-key.json',
  JSON.stringify(scored.map((s) => ({ id: s.row.id, a: s.a, b: s.b })), null, 1),
);
console.log(JSON.stringify({ rows: rows.length, disagreements: disagree.length, sheetRows: pick.length }));
