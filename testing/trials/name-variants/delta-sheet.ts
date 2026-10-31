/**
 * Blind sheet for the rows the name-variant index newly admits (trials only).
 *
 * usage: node delta-sheet.ts <db> <differential.json> [sheet] [key]
 *
 * Deduplicated by source sentence + resolved person pair, so the same sentence
 * judged twice under two relation labels does not double the denominator.
 * The sheet carries no run label, no model kind, no direction and no statement
 * of which mechanism admitted the row.
 */
import { Db } from '../../../fanfable/src/core/db.ts';
import { readFileSync, writeFileSync } from 'node:fs';

const dbPath = process.argv[2];
const diffPath = process.argv[3];
const sheetPath = process.argv[4] ?? 'testing/trials/name-variants/delta-sheet.md';
const keyPath = process.argv[5] ?? 'testing/trials/name-variants/delta-key.json';
if (!dbPath || !diffPath) {
  console.error('usage: delta-sheet.ts <db> <differential.json> [sheet] [key]');
  process.exit(2);
}

interface Delta {
  sentence: string;
  chunkId: number;
  fromId: number;
  toId: number;
  fromName: string;
  toName: string;
  kind: string;
}
const diff = JSON.parse(readFileSync(diffPath, 'utf8')) as { deltas: Delta[] };

const db = new Db(dbPath);
const proj = db.get<{ id: number }>("SELECT id FROM project WHERE name = 'ab'")!;
const chunks = db.all<{ id: number; text: string }>(
  'SELECT id, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  proj.id,
);
db.close();

const split = (text: string) => text.split(/(?<=[.!?])\s+/);
const windows = new Map<string, string>();
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']+/g, ' ').replace(/\s+/g, ' ').trim();
for (const chunk of chunks) {
  const sentences = split(chunk.text);
  for (let i = 0; i < sentences.length; i++) {
    const window = sentences
      .slice(Math.max(0, i - 1), Math.min(sentences.length - 1, i + 1) + 1)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ');
    windows.set(norm(sentences[i]!.trim()), window);
  }
}

// Deduplicate by sentence + person pair, keeping every kind seen for the key.
const keyOf = (d: Delta) => `${norm(d.sentence)}|${Math.min(d.fromId, d.toId)}|${Math.max(d.fromId, d.toId)}`;
const grouped = new Map<string, Delta[]>();
for (const d of diff.deltas) grouped.set(keyOf(d), [...(grouped.get(keyOf(d)) ?? []), d]);

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
const items = [...grouped.entries()].sort((a, b) => hash(a[0]) - hash(b[0]));

const lines: string[] = [
  '# Newly admitted rows — blind adjudication',
  '',
  'Each item names two people and shows a verbatim excerpt with one sentence of context either side. Judge only the excerpt.',
  '',
  '**identity** — `ok` both names clearly refer to two distinct people here; `unclear` one of them cannot be pinned down; `wrong` the excerpt shows the name refers to something other than that person.',
  '',
  '**connection** — `yes` the excerpt connects these two people; `no` they are merely both present, or not both present.',
  '',
  '**lasting** — `yes` the excerpt states a lasting relationship (family, marriage, lasting role, lasting friendship or enmity); `no` it states only an action, a scene, or a one-off.',
  '',
  '**kind** — the relationship in a few words, or `none`.',
  '',
  '**direction** — `A` when the first-named person is the one the kind describes, `B` when it is the second, `both` when symmetric, `none` when not stated.',
  '',
  '---',
  '',
];

const keyItems: object[] = [];
items.forEach(([key, group], i) => {
  const id = `D${String(i + 1).padStart(2, '0')}`;
  const d = group[0]!;
  const excerpt = windows.get(norm(d.sentence.trim())) ?? d.sentence.trim().replace(/\s+/g, ' ');
  lines.push(`## ${id} · ${d.fromName} — ${d.toName}`);
  lines.push('');
  lines.push(`> ${excerpt}`);
  lines.push('');
  lines.push('```');
  lines.push('identity   :');
  lines.push('connection :');
  lines.push('lasting    :');
  lines.push('kind       :');
  lines.push('direction  :');
  lines.push('note       :');
  lines.push('```');
  lines.push('');
  keyItems.push({
    id,
    pair: [d.fromName, d.toName],
    kinds: [...new Set(group.map((g) => g.kind))],
    rows: group.length,
    sentence: key,
  });
});

writeFileSync(sheetPath, `${lines.join('\n')}\n`);
writeFileSync(keyPath, JSON.stringify({ from: diffPath, items: keyItems }, null, 1));
console.log(
  JSON.stringify(
    {
      admittedRows: diff.deltas.length,
      uniqueItems: items.length,
      rowsCollapsedByDedupe: diff.deltas.length - items.length,
      sheet: sheetPath,
      key: keyPath,
    },
    null,
    1,
  ),
);
