/**
 * Full-book Phase 1b discovery diagnostics (read-only, counts only).
 * Usage: node --no-warnings /tmp/opencode/fullbook-diag.ts <db> [project]
 * No model calls. Never prints names, quotes, or passages — counts only.
 */
import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';

const dbPath = process.argv[2];
const projectName = process.argv[3] ?? 'fullbook';
if (!dbPath) { console.error('usage: fullbook-diag.ts <db> [project]'); process.exit(2); }

const db = new Db(dbPath);
try {
  const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
  if (!proj) { console.error('no project', projectName); process.exit(2); }
  const pid = proj.id;

  const people = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ? AND kind = 'character'`, pid)?.n ?? 0;
  const tied = db.get<{ n: number }>(
    `SELECT COUNT(DISTINCT e.id) AS n FROM canon_entity e
      WHERE e.project_id = ? AND e.kind = 'character'
        AND EXISTS (SELECT 1 FROM canon_relation r WHERE r.project_id = e.project_id
          AND (r.from_entity = e.id OR r.to_entity = e.id))`, pid)?.n ?? 0;

  const pairRows = db.all<{ a: number; b: number }>(
    `SELECT DISTINCT CASE WHEN from_entity < to_entity THEN from_entity ELSE to_entity END AS a,
      CASE WHEN from_entity < to_entity THEN to_entity ELSE from_entity END AS b
      FROM canon_relation WHERE project_id = ?`, pid);
  const pairsWithRows = pairRows.length;

  // Co-occurrence: character pairs sharing at least one chunk (name-token match).
  const entities = db.all<{ id: number; name: string }>(
    `SELECT id, name FROM canon_entity WHERE project_id = ? AND kind = 'character'`, pid);
  const chunks = db.all<{ text: string }>(`SELECT text FROM canon_chunk WHERE project_id = ?`, pid);
  const canon = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const toks = entities.map((e) => ({ id: e.id, t: canon(e.name).filter((w) => w.length >= 3) })).filter((e) => e.t.length > 0);
  const cooccur = new Set<string>();
  for (const c of chunks) {
    const words = new Set(canon(c.text));
    const present: number[] = [];
    for (const e of toks) {
      // full-name contiguous match on token stream
      const stream = canon(c.text).join(' ');
      if (e.t.length === 1 ? words.has(e.t[0]!) : stream.includes(e.t.join(' '))) present.push(e.id);
    }
    for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) {
      const a = Math.min(present[i]!, present[j]!), b = Math.max(present[i]!, present[j]!);
      cooccur.add(`${a}|${b}`);
    }
  }

  // Evidence-split cheap buckets over relation rows: both-names-one-sentence?
  const rels = db.all<{ evidence: string }>(`SELECT evidence FROM canon_relation WHERE project_id = ?`, pid);
  const splitSent = (t: string): string[] => t.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunkTexts = chunks.map((c) => c.text);
  let bothOneSentence = 0, bothPageNotOne = 0, notBothOnPage = 0;
  // Sample-free cheap version: check quote itself for two name-token hits.
  // Full both-names-on-page measure needs entity resolution per row; report
  // quote-level proxy plus cooccur gap instead.
  void splitSent; void chunkTexts; void rels;

  console.log(JSON.stringify({
    db: dbPath, project: projectName,
    people, peopleWithTies: tied, peopleZeroTies: people - tied,
    cooccurringPairs: cooccur.size, pairsWithRows,
    unproposedPairs: cooccur.size - pairsWithRows,
  }));
} finally {
  db.close();
}
