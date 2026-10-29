// Selects the frozen duel set: top-32 windows by scoreWindow + the Tarkin window.
// Reads testing/trials/nuextract-duel/plagueis-duel.db, writes duel-windows.json.
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Db } from '../../../fanfable/src/db.ts';
import { buildNameDocFreq, scoreWindow } from '../../../fanfable/src/lorebook.ts';

const dir = fileURLToPath(new URL('./', import.meta.url));
const db = new Db(dir + 'plagueis-duel.db');
const project = db.get<{ id: number }>(`SELECT id FROM project WHERE name = 'duel-probe'`);
if (!project) throw new Error('duel-probe project missing — run rebuild-windows.ts first');

const chunks = db.all<{ id: number; seq: number; locator: string; text: string; source_id: number }>(
  `SELECT c.id, c.seq, c.locator, c.text, c.source_id FROM canon_chunk c
   WHERE c.project_id = ? ORDER BY c.source_id, c.seq`,
  project.id,
);
const WINDOW = 8;
const windows: { index: number; locators: string[]; text: string; chars: number }[] = [];
for (let s = 0; s < chunks.length; s += WINDOW) {
  const slice = chunks.slice(s, s + WINDOW);
  const text = slice.map((c) => c.text).join('\n\n');
  windows.push({ index: windows.length, locators: slice.map((c) => c.locator), text, chars: text.length });
}
const freq = buildNameDocFreq(windows.map((w) => chunks.slice(w.index * WINDOW, w.index * WINDOW + WINDOW) as any));
const scored = windows.map((w, i) => ({ i, score: scoreWindow(chunks.slice(i * WINDOW, i * WINDOW + WINDOW) as any, freq).score }));
scored.sort((a, b) => b.score - a.score || a.i - b.i);

const TARKIN = windows.findIndex((w) => /Bor Gracus/i.test(w.text));
if (TARKIN < 0) throw new Error('Tarkin window not found — aborting, ground is wrong');
console.log('tarkin window index:', TARKIN, 'locators:', windows[TARKIN]!.locators.join(','));

const picked: number[] = [];
for (const s of scored) {
  if (picked.length >= 32) break;
  if (s.i === TARKIN) continue;
  picked.push(s.i);
}
picked.push(TARKIN);
picked.sort((a, b) => a - b);
console.log('duel set:', picked.length, 'windows');

const duel = picked.map((i) => windows[i]);
writeFileSync(dir + 'duel-windows.json', JSON.stringify({ count: duel.length, tarkin: TARKIN, indices: picked, windows: duel }, null, 1));
console.log('wrote duel-windows.json');
db.raw.close();
