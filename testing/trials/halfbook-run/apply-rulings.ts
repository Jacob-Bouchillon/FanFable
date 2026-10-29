import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';

const DB = '/tmp/opencode/halfbook/plagueis-half.db';
// note id -> ruled kind (user's word; default = Gemini closed kind)
const APPROVED: Record<number, string> = {
  11: 'ally of', 12: 'ally of', 21: 'aide of', 41: 'master of', 42: 'master of',
  57: 'aide of', 85: 'apprentice of', 95: 'ally of', 96: 'ally of',
  97: 'master of', 44: 'lover of',
};
const SKIP = [106, 98];

const db = new Db(DB);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name=?', 'halfbook')!;
const now = new Date().toISOString();
let banked = 0, confirmed = 0, deduped = 0;
for (const [nid, kind] of Object.entries(APPROVED)) {
  const n = db.get<any>('SELECT * FROM canon_tie_note WHERE id=? AND project_id=?', Number(nid), proj.id);
  if (!n) { console.log(`note ${nid}: missing`); continue; }
  if ((n.ruling ?? '').startsWith('BANK (user)')) { deduped++; continue; }
  const twin = db.get<{ id: number }>(
    `SELECT id FROM canon_relation WHERE project_id=? AND from_entity=? AND to_entity=? AND lower(kind)=? AND scope='' AND review_status='needs_review'`,
    proj.id, n.from_entity, n.to_entity, kind.toLowerCase());
  if (twin) {
    db.run(`UPDATE canon_relation SET kind=?, evidence=?, source_refs=?, review_status='user_confirmed' WHERE id=?`,
      kind, n.evidence, n.source_refs ?? '[]', twin.id);
    banked++;
  } else {
    const kept = db.get<{ id: number }>(
      `SELECT id FROM canon_relation WHERE project_id=? AND ((from_entity=? AND to_entity=?) OR (from_entity=? AND to_entity=?)) AND lower(kind)=? AND scope='' AND review_status IN ('accepted','user_confirmed')`,
      proj.id, n.from_entity, n.to_entity, n.to_entity, n.from_entity, kind.toLowerCase());
    if (kept) { deduped++; }
    else {
      db.run(`INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, scope, review_status, created_at)
              VALUES (?, ?, ?, ?, ?, ?, '', 'user_confirmed', ?)`,
        proj.id, n.from_entity, n.to_entity, kind, n.evidence, n.source_refs ?? '[]', now);
      banked++;
    }
  }
  db.run("UPDATE canon_tie_note SET status='resolved', ruling=?, ruled_at=? WHERE id=?", `BANK ${kind} (user)`, now, Number(nid));
  confirmed++;
}
for (const nid of SKIP) {
  db.run("UPDATE canon_tie_note SET status='resolved', ruling=? WHERE id=? AND (ruling IS NULL OR ruling NOT LIKE 'SKIP (user%')", 'SKIP (user: not a tie)', nid);
}
const ties = db.all('SELECT review_status, COUNT(*) AS n FROM canon_relation WHERE project_id=? GROUP BY review_status', proj.id);
const pend = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM canon_tie_note WHERE project_id=? AND status='pending'", proj.id);
console.log(JSON.stringify({ ruled: confirmed, banked_new: banked, already_kept: deduped, ties, pending_notes: pend?.n }));
db.close();
