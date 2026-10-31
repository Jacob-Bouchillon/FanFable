/**
 * Fresh small read for the lasting-only fix, temp project only.
 *
 * Copies WINDOWS×8 chunks from bench-hp (starting at OFFSET windows in)
 * into a temp bank and runs the real split extractor once. Small by design: 4 windows, concurrency 1
 * for the 8GB profile, one heavy GPU job at a time. Verifies the source
 * counts match before and after. Count-only output.
 *
 * Usage (needs Ollama up with the local model):
 *   WINDOWS=4 PROJECT=book-fix-check node --no-warnings testing/trials/reads/fresh-small-read.ts
 */
import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/core/db.ts';
import * as controller from '/home/jacob/Documents/FanFable/fanfable/src/plan/controller.ts';
import * as lorebook from '/home/jacob/Documents/FanFable/fanfable/src/lorebook.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';

const DB = '/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db';
const SRC = 'bench-hp';
const WINDOWS = Number(process.env.WINDOWS ?? 4);
const OFFSET = Number(process.env.OFFSET ?? 0);
const PROJECT = process.env.PROJECT ?? 'book-fix-check';

const srcCounts = (db: Db, id: number) => ({
  chunks: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id = ?', id)!.n,
  entities: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', id)!.n,
});

const db = new Db(DB);
const t0 = Date.now();
try {
  const src = controller.getProjectByName(db, SRC)!;
  const before = srcCounts(db, src.id);
  let dst = controller.getProjectByName(db, PROJECT);
  if (dst) {
    for (const t of ['canon_relation', 'canon_fact', 'canon_timeline', 'canon_entity', 'canon_chunk', 'canon_source']) {
      db.run(`DELETE FROM ${t} WHERE project_id = ?`, dst.id);
    }
  } else {
    dst = controller.createProject(db, PROJECT);
  }
  const srow = db.get<Record<string, unknown>>('SELECT * FROM canon_source WHERE project_id = ? LIMIT 1', src.id)!;
  const si = db.run(
    'INSERT INTO canon_source (project_id, path, title, author, format, sha256, byte_size, page_count, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    dst.id, `${String(srow.path)}#${PROJECT}`, srow.title, srow.author, srow.format, srow.sha256,
    srow.byte_size, srow.page_count, srow.imported_at,
  );
  const newSourceId = Number(si.lastInsertRowid);
  const chunks = db.all<{ seq: number; locator: string; heading: string; text: string }>(
    'SELECT seq, locator, heading, text FROM canon_chunk WHERE project_id = ? AND seq >= ? ORDER BY seq LIMIT ?',
    src.id, OFFSET * 8, WINDOWS * 8,
  );
  let seq = 0;
  for (const c of chunks) {
    db.run(
      'INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, lore_mined) VALUES (?, ?, ?, ?, ?, ?, 0)',
      newSourceId, dst.id, seq++, c.locator, c.heading, c.text,
    );
  }
  console.log(`copied ${chunks.length} chunks (${WINDOWS} windows) -> ${PROJECT}; source chunks ${before.chunks} entities ${before.entities}`);

  const llm = baselineClient();
  const stats = await lorebook.extractLore(db, llm, dst.id, {
    concurrency: Number(process.env.CONCURRENCY ?? 1),
  });
  const v = stats.verification;
  console.log(
    `FRESH-SMALL DONE in ${((Date.now() - t0) / 60000).toFixed(1)} min: ` +
      `${stats.entities} entities, ${stats.relations} relations, ${stats.facts} facts, windows ${stats.windows}, ` +
      `claimed ${v.claimed} verified ${v.verified} repointed ${v.repointed} dropped ${v.dropped} ` +
      `unresolved ${v.unresolved} unrelated ${v.unrelated}`,
  );

  const after = srcCounts(db, src.id);
  console.log(
    `SOURCE ${after.chunks === before.chunks && after.entities === before.entities ? 'UNCHANGED' : 'CHANGED!'}: ` +
      `chunks ${before.chunks}->${after.chunks}, entities ${before.entities}->${after.entities}`,
  );
  console.log(`NEXT: node --no-warnings testing/trials/checks/lasting-moment-check.ts ${PROJECT}`);
} finally {
  db.close();
}
