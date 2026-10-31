import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import * as controller from '/home/jacob/Documents/FanFable/fanfable/src/plan/controller.ts';
import * as lorebook from '/home/jacob/Documents/FanFable/fanfable/src/lorebook.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';

/* Arm A: plain-order read, first N windows in seq order, 8-chunk windows,
 * incremental extraction after each window. Count-only output. */

const db = new Db('/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db');
const src = controller.getProjectByName(db, 'bench-hp')!;
const llm = baselineClient();
const WINDOW = 8;
const WINDOWS = Number(process.env.WINDOWS ?? 24);
const CONCURRENCY = 3;
const PROJECT = process.env.PROJECT ?? 'book-plain-24';

const chunks = db.all<{ id: number; seq: number }>(
  'SELECT id, seq FROM canon_chunk WHERE project_id = ? ORDER BY seq',
  src.id,
);
const project = controller.getProjectByName(db, PROJECT) ?? controller.createProject(db, PROJECT);
for (const t of ['canon_relation', 'canon_fact', 'canon_timeline', 'canon_entity', 'canon_chunk', 'canon_source']) {
  db.run(`DELETE FROM ${t} WHERE project_id = ?`, project.id);
}
const source = db.get<any>('SELECT * FROM canon_source WHERE project_id = ? LIMIT 1', src.id)!;
const res = db.run(
  `INSERT INTO canon_source (project_id, path, title, author, format, sha256, byte_size, page_count, imported_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  project.id,
  `${source.path}#${PROJECT}`,
  source.title,
  source.author,
  source.format,
  source.sha256,
  source.byte_size,
  source.page_count,
);
const sourceId = res.lastInsertRowid;
let seq = 0;
const started = Date.now();
let read = 0;
for (let w = 0; w < WINDOWS; w++) {
  const rows = chunks.slice(w * WINDOW, (w + 1) * WINDOW);
  if (!rows.length) break;
  const copy = db.raw.prepare(
    `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end, words, page_start, page_end)
     SELECT ?, ?, ?, locator, heading, text, char_start, char_end, words, page_start, page_end
     FROM canon_chunk WHERE id = ?`,
  );
  for (const c of rows) copy.run(sourceId, project.id, seq++, c.id);
  const t = Date.now();
  const st = await lorebook.extractLore(db, llm, project.id, { concurrency: CONCURRENCY, incremental: true });
  const counts = db.get<{ entities: number; relations: number; facts: number }>(
    `SELECT (SELECT COUNT(*) FROM canon_entity WHERE project_id = ?) AS entities,
            (SELECT COUNT(*) FROM canon_relation WHERE project_id = ?) AS relations,
            (SELECT COUNT(*) FROM canon_fact WHERE project_id = ?) AS facts`,
    project.id,
    project.id,
    project.id,
  )!;
  read++;
  console.log(
    `window ${w + 1}/${WINDOWS} seq ${rows[0]!.seq}-${rows[rows.length - 1]!.seq}: ` +
      `+${rows.length} chunks, windows mined ${st.windows}, claims ${st.verification.claimed}/${st.verification.verified}, ` +
      `entities ${counts.entities}, relations ${counts.relations}, facts ${counts.facts}, ` +
      `${((Date.now() - t) / 1000).toFixed(0)}s`,
  );
}
const total = db.get<{ entities: number; relations: number; facts: number }>(
  `SELECT (SELECT COUNT(*) FROM canon_entity WHERE project_id = ?) AS entities,
          (SELECT COUNT(*) FROM canon_relation WHERE project_id = ?) AS relations,
          (SELECT COUNT(*) FROM canon_fact WHERE project_id = ?) AS facts`,
  project.id,
  project.id,
  project.id,
)!;
console.log(
  `PLAIN DONE: ${read} windows, ${total.entities} entities, ${total.relations} relations, ${total.facts} facts, ` +
    `${((Date.now() - started) / 60000).toFixed(1)} min`,
);
db.close();
