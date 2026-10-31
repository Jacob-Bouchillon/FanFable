/**
 * Handoff outcome run: enrich the same thin name with vs without handoff.
 *
 * Two temp copies of the order-only bank isolate the arms: A enriches in
 * today's order, B reads thin windows first via testing/trials/chain/handoff-test.json.
 * Same name, same 12-passage cap, sequential (one model job). Count-only
 * output: added relations/facts per arm. No passage prose, no gold keys.
 */
import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import * as controller from '/home/jacob/Documents/FanFable/fanfable/src/plan/controller.ts';
import * as loreDiag from '/home/jacob/Documents/FanFable/fanfable/src/answer/lore-diagnostics.ts';
import { readHandoff } from './chain-handoff.ts';
import { baselineClient } from '/home/jacob/Documents/FanFable/testing/scripts/benchmark/corpus.ts';

const DB = '/home/jacob/Documents/FanFable/testing/benchmarks/data/bench.db';
const SRC = 'book-coord-no-notes';
const HANDOFF = '/home/jacob/Documents/FanFable/testing/trials/chain/handoff-test.json';

function copyBank(db: Db, srcName: string, dstName: string): number {
  const src = controller.getProjectByName(db, srcName)!;
  let dst = controller.getProjectByName(db, dstName);
  if (dst) {
    for (const t of ['canon_relation', 'canon_fact', 'canon_entity', 'canon_chunk', 'canon_source']) {
      db.run(`DELETE FROM ${t} WHERE project_id = ?`, dst.id);
    }
  } else {
    dst = controller.createProject(db, dstName);
  }
  const srcMap = new Map<number, number>();
  for (const s of db.all<Record<string, unknown>>('SELECT * FROM canon_source WHERE project_id = ?', src.id)) {
    const r = db.run(
      'INSERT INTO canon_source (project_id, path, title, author, format, sha256, byte_size, page_count, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      dst.id, s.path, s.title, s.author, s.format, s.sha256, s.byte_size, s.page_count, s.imported_at,
    );
    srcMap.set(s.id as number, Number(r.lastInsertRowid));
  }
  const chunkMap = new Map<number, number>();
  for (const c of db.all<Record<string, unknown>>(
    'SELECT * FROM canon_chunk WHERE project_id = ? ORDER BY seq', src.id,
  )) {
    const r = db.run(
      `INSERT INTO canon_chunk (source_id, project_id, seq, locator, heading, text, char_start, char_end,
        words, page_start, page_end, lore_mined) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      srcMap.get(c.source_id as number), dst.id, c.seq, c.locator, c.heading, c.text,
      c.char_start, c.char_end, c.words, c.page_start, c.page_end, c.lore_mined,
    );
    chunkMap.set(c.id as number, Number(r.lastInsertRowid));
  }
  const entMap = new Map<number, number>();
  for (const e of db.all<Record<string, unknown>>('SELECT * FROM canon_entity WHERE project_id = ?', src.id)) {
    const r = db.run(
      `INSERT INTO canon_entity (project_id, kind, name, aliases, summary, attributes, role, status,
        first_chunk, evidence, source_refs, mentions, confidence, review_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      dst.id, e.kind, e.name, e.aliases, e.summary, e.attributes, e.role, e.status,
      e.first_chunk === null ? null : (chunkMap.get(e.first_chunk as number) ?? null),
      e.evidence, e.source_refs, e.mentions, e.confidence, e.review_status, e.created_at, e.updated_at,
    );
    entMap.set(e.id as number, Number(r.lastInsertRowid));
  }
  for (const t of ['canon_relation', 'canon_fact'] as const) {
    for (const row of db.all<Record<string, unknown>>(`SELECT * FROM ${t} WHERE project_id = ?`, src.id)) {
      if (t === 'canon_relation') {
        db.run(
          `INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, description, evidence,
            source_refs, confidence, review_status, valid_from_event_id, valid_to_event_id, created_at,
            modality, conflict_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          dst.id, entMap.get(row.from_entity as number), entMap.get(row.to_entity as number),
          row.kind, row.description, row.evidence, row.source_refs, row.confidence, row.review_status,
          row.valid_from_event_id, row.valid_to_event_id, row.created_at, row.modality, row.conflict_status,
        );
      } else {
        db.run(
          `INSERT INTO canon_fact (project_id, topic, statement, kind, certainty, subject, evidence,
            source_refs, subject_entity_id, confidence, review_status, valid_from_event_id,
            valid_to_event_id, created_at, modality, conflict_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          dst.id, row.topic, row.statement, row.kind, row.certainty, row.subject, row.evidence,
          row.source_refs,
          row.subject_entity_id === null ? null : (entMap.get(row.subject_entity_id as number) ?? null),
          row.confidence, row.review_status, row.valid_from_event_id, row.valid_to_event_id,
          row.created_at, row.modality, row.conflict_status,
        );
      }
    }
  }
  return dst.id;
}

const counts = (db: Db, pid: number): { rel: number; fact: number } => ({
  rel: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_relation WHERE project_id = ?', pid)!.n,
  fact: db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_fact WHERE project_id = ?', pid)!.n,
});

const db = new Db(DB);
const t0 = Date.now();
try {
  // Target: thin name with the most matching passages (cap must bind).
  const off = readHandoff(HANDOFF);
  const srcRow = controller.getProjectByName(db, SRC)!;
  const texts = db.all<{ text: string }>(
    'SELECT text FROM canon_chunk WHERE project_id = ? ORDER BY seq', srcRow.id,
  );
  let target = '';
  let targetMatched = 0;
  for (const t of off.thin) {
    const n = texts.filter((c) => c.text.toLowerCase().includes(t.name.toLowerCase())).length;
    if (n > targetMatched) {
      targetMatched = n;
      target = t.name;
    }
  }
  if (!target || targetMatched <= 12) throw new Error(`no thin name over cap (best ${targetMatched})`);
  console.log(`target matched passages: ${targetMatched} (name withheld, count-only)`);

  const llm = baselineClient();
  const aId = copyBank(db, SRC, 'book-enrich-a');
  const bId = copyBank(db, SRC, 'book-enrich-b');
  const beforeA = counts(db, aId);
  const beforeB = counts(db, bId);

  const ra = await loreDiag.enrichEntity(db, llm, aId, target, { maxPassages: 12 });
  console.log(`armA plain: +${counts(db, aId).rel - beforeA.rel} rel +${counts(db, aId).fact - beforeA.fact} fact from ${ra.passages} passages`);
  const rb = await loreDiag.enrichEntity(db, llm, bId, target, { maxPassages: 12, handoffPath: HANDOFF });
  console.log(`armB handoff: +${counts(db, bId).rel - beforeB.rel} rel +${counts(db, bId).fact - beforeB.fact} fact from ${rb.passages} passages`);
  console.log(`OUTCOME DONE in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
} finally {
  db.close();
}
