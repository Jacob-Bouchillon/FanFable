/**
 * Product accuracy test: product's own extractLore, top-24 scored windows.
 *
 * Copies the full bench source into a temp project, then runs the real
 * product path (score -> select top 24 -> split extract -> span gate ->
 * merge) with zero trial logic. Keeper counter afterwards decides:
 * near trial-ordered (5 unique) means the product path is accurate.
 * Count-only output. Temp project only.
 */
import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import * as controller from '/home/jacob/Documents/FanFable/fanfable/src/controller.ts';
import * as lorebook from '/home/jacob/Documents/FanFable/fanfable/src/lorebook.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';

const DB = '/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db';
const SRC = 'bench-hp';
const DST = 'book-product-24';

const db = new Db(DB);
const t0 = Date.now();
try {
  const src = controller.getProjectByName(db, SRC)!;
  let dst = controller.getProjectByName(db, DST);
  if (dst) {
    for (const t of ['canon_relation', 'canon_fact', 'canon_timeline', 'canon_entity', 'canon_chunk', 'canon_source']) {
      db.run(`DELETE FROM ${t} WHERE project_id = ?`, dst.id);
    }
  } else {
    dst = controller.createProject(db, DST);
  }
  const srow = db.get<Record<string, unknown>>('SELECT * FROM canon_source WHERE project_id = ? LIMIT 1', src.id)!;
  const si = db.run(
    'INSERT INTO canon_source (project_id, path, title, author, format, sha256, byte_size, page_count, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    dst.id, `${srow.path}#product-24`, srow.title, srow.author, srow.format, srow.sha256,
    srow.byte_size, srow.page_count, srow.imported_at,
  );
  const newSourceId = Number(si.lastInsertRowid);
  const chunks = db.all<Record<string, unknown>>(
    'SELECT seq, locator, heading, text, char_start, char_end, words, page_start, page_end FROM canon_chunk WHERE project_id = ? ORDER BY seq',
    src.id,
  );
  for (const c of chunks) {
    db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end,
        words, page_start, page_end, lore_mined) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      newSourceId, dst.id, c.seq, c.locator, c.heading, c.text, c.char_start, c.char_end,
      c.words, c.page_start, c.page_end,
    );
  }
  console.log(`copied ${chunks.length} chunks`);

  const llm = baselineClient();
  const stats = await lorebook.extractLore(db, llm, dst.id, {
    windowSize: 8,
    concurrency: 3,
    maxWindows: 24,
    priorityFirst: 24,
    randomFloor: 0,
    seed: 42,
    onProgress: (m) => console.log('  ' + m),
  });
  const v = stats.verification;
  console.log(
    `PRODUCT-24 DONE in ${((Date.now() - t0) / 60000).toFixed(1)} min: ` +
    `${stats.entities} entities, ${stats.relations} relations, ${stats.facts} facts, ` +
    `${stats.timeline} timeline, windows ${stats.windows}, ` +
    `quotes claimed ${v.claimed} verified ${v.verified} repointed ${v.repointed} dropped ${v.dropped} ` +
    `unresolved ${v.unresolved} unrelated ${v.unrelated}, empty ${stats.emptyWindows.length}`,
  );
} finally {
  db.close();
}
