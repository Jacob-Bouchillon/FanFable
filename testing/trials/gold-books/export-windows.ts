/**
 * Export sample windows for blind reading (trials only).
 *
 * usage: node export-windows.ts <db> <out.md> [count]
 * Picks windows spread across the book and prints their passages with ids.
 */
import { Db } from '../../../fanfable/src/db.ts';
import { writeFileSync } from 'node:fs';

const dbPath = process.argv[2];
const outPath = process.argv[3];
const count = Number(process.argv[4] ?? 3);
if (!dbPath || !outPath) {
  console.error('usage: export-windows.ts <db> <out.md> [count]');
  process.exit(2);
}

const db = new Db(dbPath);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
if (!proj) {
  console.error('no project ab');
  process.exit(2);
}
const chunks = db.all<{ id: number; seq: number; locator: string; text: string }>(
  'SELECT id, seq, locator, text FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  proj.id,
);
const size = 8;
const windows: { window: number; passages: typeof chunks }[] = [];
for (let i = 0; i + size <= chunks.length; i += size) {
  windows.push({ window: windows.length + 1, passages: chunks.slice(i, i + size) });
}
const picks: number[] = [];
for (let k = 0; k < count; k++) {
  const fraction = (k + 1) / (count + 1);
  picks.push(Math.min(windows.length - 1, Math.floor(fraction * windows.length)));
}

const lines = [`# Sampled windows: ${dbPath}`, ''];
for (const index of picks) {
  const win = windows[index]!;
  lines.push(`## Window ${win.window}`);
  for (const passage of win.passages) {
    lines.push(`[P${passage.seq}] ${passage.text.replace(/\s+/g, ' ').trim()}`);
    lines.push('');
  }
}
writeFileSync(outPath, lines.join('\n'));
console.log(JSON.stringify({ windows: windows.length, picked: picks.length, out: outPath }));
db.close();
