/**
 * Three-way blind sheet for the 42 labelled rows (trials).
 *
 * usage: node three-way-sheet.ts [sheet.md] [key.json]
 *
 * Builds a sheet with no model output, no original verdict and no gold id in
 * view. Items are shuffled deterministically and numbered T01..T42; the key is
 * written separately so predictions stay hidden until the labels are locked.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Db } from '../../../fanfable/src/db.ts';

const sheetPath = process.argv[2] ?? 'testing/trials/adjudication/gold-three-way-sheet.md';
const keyPath = process.argv[3] ?? 'testing/trials/adjudication/gold-three-way-key.json';

const goldMap = JSON.parse(readFileSync('testing/trials/adjudication/gold-map.json', 'utf8')) as {
  gold: number;
  db: string;
  relId: number;
  kind: string;
}[];

const cache = new Map<string, Db>();
const items: { gold: number; from: string; to: string; kind: string; passage: string }[] = [];

for (const entry of goldMap) {
  const path = `testing/trials/model-ab/${entry.db}.db`;
  let db = cache.get(path);
  if (!db) {
    db = new Db(path);
    cache.set(path, db);
  }
  const row = db.get<{ a: string; b: string; evidence: string; refs: string }>(
    `SELECT a.name AS a, b.name AS b, r.evidence, coalesce(r.source_refs,'[]') AS refs
       FROM canon_relation r JOIN canon_entity a ON a.id=r.from_entity JOIN canon_entity b ON b.id=r.to_entity
      WHERE r.id = ?`,
    entry.relId,
  );
  if (!row) continue;
  let passage = row.evidence.trim();
  try {
    const refs = JSON.parse(row.refs) as { chunk?: unknown }[];
    const chunkId = typeof refs[0]?.chunk === 'number' ? (refs[0]!.chunk as number) : null;
    if (chunkId !== null) {
      const text = db.get<{ text: string }>('SELECT text FROM canon_chunk WHERE id = ?', chunkId)?.text;
      if (text) {
        const sentences = text.split(/(?<=[.!?])\s+/);
        const at = sentences.findIndex((s) => s.includes(row.evidence.trim().slice(0, 80)));
        if (at >= 0) {
          passage = sentences
            .slice(Math.max(0, at - 1), Math.min(sentences.length, at + 2))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        }
      }
    }
  } catch {
    /* keep the quote alone */
  }
  items.push({ gold: entry.gold, from: row.a, to: row.b, kind: entry.kind, passage });
}

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
items.sort((a, b) => hash(`${a.gold}`) - hash(`${b.gold}`));

const lines: string[] = [
  '# Gold set — three-way blind adjudication',
  '',
  'For each item decide what the passage does about the relationship between the two named people. Do not use outside knowledge.',
  '',
  '**establishes** — the passage itself provides the evidence from which the relationship can be identified. A reader who knew nothing else could take the relationship from this passage.',
  '',
  '**reinforces** — the passage presupposes a relationship already established elsewhere ("their partnership", "his wife", "the brothers"). It refers to the relationship rather than setting it out.',
  '',
  '**mentions** — both people appear, but the passage neither states nor presupposes a relationship between them.',
  '',
  '**unclear** — the passage is too damaged or ambiguous to decide.',
  '',
  'Write the label and one short reason. The model\'s answers are not on this sheet, and the original verdicts are not shown.',
  '',
  '---',
  '',
];

items.forEach((item, i) => {
  lines.push(`## T${String(i + 1).padStart(2, '0')} · ${item.from} — ${item.kind} — ${item.to}`);
  lines.push('');
  lines.push(`> ${item.passage}`);
  lines.push('');
  lines.push('```');
  lines.push('label  :');
  lines.push('reason :');
  lines.push('```');
  lines.push('');
});

writeFileSync(sheetPath, `${lines.join('\n')}\n`);
writeFileSync(
  keyPath,
  JSON.stringify(items.map((item, i) => ({ sheet: `T${String(i + 1).padStart(2, '0')}`, gold: item.gold })), null, 1),
);
console.log(JSON.stringify({ items: items.length, sheet: sheetPath, key: keyPath }, null, 1));
