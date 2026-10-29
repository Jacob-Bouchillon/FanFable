// Rebuilds frozen duel ground from the real code path — no temp, no src changes.
// DB: testing/trials/nuextract-duel/plagueis-duel.db (gitignored via testing/)
// Output: testing/trials/nuextract-duel/windows.json
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Db } from '../../../fanfable/src/db.ts';
import * as controller from '../../../fanfable/src/controller.ts';
import * as lore from '../../../fanfable/src/lore.ts';

const DUEL_DB = fileURLToPath(new URL('./plagueis-duel.db', import.meta.url));
const PDF = fileURLToPath(new URL('../../../RESOURCES/Novels/Darth Plagueis - James Luceno.pdf', import.meta.url));
const OUT = fileURLToPath(new URL('./windows.json', import.meta.url));
const WINDOW = 8;

const db = new Db(DUEL_DB);
let project = controller.getProjectByName(db, 'duel-probe');
if (!project) project = controller.createProject(db, 'duel-probe', {});
console.log('project', project.id, 'db', DUEL_DB);

const chunksBefore = db.get<{ n: number }>(
  'SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?',
  project.id,
)?.n ?? 0;
console.log('chunks before import:', chunksBefore);

if (chunksBefore === 0) {
  const res = await lore.importSourceAsync(db, project.id, PDF, {});
  console.log('imported:', res.source.title, 'chunks:', res.chunks);
}

const chunks = db.all<{
  id: number; seq: number; locator: string; text: string; source_id: number;
}>(
  `SELECT c.id, c.seq, c.locator, c.text, c.source_id
   FROM canon_chunk c WHERE c.project_id = ? ORDER BY c.source_id, c.seq`,
  project.id,
);
console.log('total chunks:', chunks.length);

const windows: { index: number; locators: string[]; chars: number; text: string }[] = [];
for (let start = 0; start < chunks.length; start += WINDOW) {
  const slice = chunks.slice(start, start + WINDOW);
  const text = slice.map((c) => c.text).join('\n\n');
  windows.push({
    index: windows.length,
    locators: slice.map((c) => c.locator),
    chars: text.length,
    text,
  });
}
console.log('windows:', windows.length, 'window chars (first 3):', windows.slice(0, 3).map((w) => w.chars).join(','));

writeFileSync(OUT, JSON.stringify({ windowSize: WINDOW, count: windows.length, windows }, null, 1));
console.log('wrote', OUT);
db.raw.close();
