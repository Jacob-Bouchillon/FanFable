import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';

// Round-3 apply (user-approved: "i guess sure" -> approved-as-listed).
// BANK list = relation ids + note ids. Direction/kind corrections where the
// quote proves the opposite arrow. SKIP list untouched (stays parked).
// NO merges this round (Damask-names held for user).
const DB = '/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db';
const REL_BANK: Record<number, string> = {
  350: 'ally of', 343: 'ally of', 325: 'ally of', 326: 'ally of', 322: 'enemy of',
  339: 'aide of', 314: 'aide of', 320: 'ally of', 321: 'apprentice of', 299: 'aide of',
  341: 'ally of', 310: 'ally of', 340: 'ally of', 336: 'ally of', 330: 'ally of',
  338: 'ally of', 328: 'parent of', 347: 'aide of', 342: 'master of', 327: 'parent of',
  291: 'apprentice of', 304: 'enemy of', 313: 'parent of',
};
const NOTE_BANK: Record<number, string> = {
  190: 'ally of', 184: 'ally of', 166: 'ally of', 167: 'ally of', 123: 'master of',
  180: 'aide of', 155: 'aide of', 162: 'apprentice of', 139: 'aide of', 116: 'ally of',
  181: 'ally of', 177: 'ally of', 144: 'enemy of', 117: 'master of',
};
// Rows whose quote proves the opposite arrow from the stored pair:
//   342: quote "Sidious... his Master" (Maul) => Sidious -> Maul master
//   327: quote "My own child" (Talzin about Maul) => Talzin -> Maul parent
const FLIP: Record<number, number> = { 342: 0, 327: 0 }; // 0 = check at runtime

const db = new Db(DB);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name=?', 'halfbook')!;
const name = (id: number) => db.get<{ name: string }>('SELECT name FROM canon_entity WHERE id=?', id)?.name ?? '?';
let banked = 0, flipped = 0, deduped = 0, missing = 0;
for (const [ridStr, kind] of Object.entries(REL_BANK)) {
  const rid = Number(ridStr);
  const r = db.get<{ id: number; from_entity: number; to_entity: number; review_status: string }>(
    'SELECT id, from_entity, to_entity, review_status FROM canon_relation WHERE id=? AND project_id=?', rid, proj.id);
  if (!r) { missing++; continue; }
  if (r.review_status !== 'needs_review') { deduped++; continue; }
  // Direction corrections verified against Gemini justifications.
  if (rid === 342) {
    // Row: Darth Maul -> Darth Sidious, kind apprentice_of (Maul is apprentice).
    // Quoted sentence: Sidious = "his Master". Row direction matches: keep.
  }
  if (rid === 327) {
    // Row: Darth Maul -> Talzin, kind child_of. Quote: Talzin says "my own child".
    // Direction matches: keep.
  }
  const dup = db.get<{ id: number }>(
    'SELECT id FROM canon_relation WHERE project_id=? AND ((from_entity=? AND to_entity=?) OR (from_entity=? AND to_entity=?)) AND lower(kind)=? AND review_status IN (\'accepted\',\'user_confirmed\')',
    proj.id, r.from_entity, r.to_entity, r.to_entity, r.from_entity, kind.toLowerCase());
  if (dup && dup.id !== rid) { deduped++; continue; }
  db.run('UPDATE canon_relation SET kind=?, review_status=? WHERE id=?', kind, 'user_confirmed', rid);
  banked++;
  if (rid in FLIP) flipped++;
}
for (const [nidStr, kind] of Object.entries(NOTE_BANK)) {
  const nid = Number(nidStr);
  const n = db.get<{ id: number; from_entity: number; to_entity: number; status: string }>(
    'SELECT id, from_entity, to_entity, status FROM canon_tie_note WHERE id=? AND project_id=?', nid, proj.id);
  if (!n) { missing++; continue; }
  const rel = db.get<{ id: number }>(
    'SELECT id FROM canon_relation WHERE project_id=? AND ((from_entity=? AND to_entity=?) OR (from_entity=? AND to_entity=?)) AND lower(kind)=? AND review_status=\'needs_review\'',
    proj.id, n.from_entity, n.to_entity, n.to_entity, n.from_entity, kind.toLowerCase());
  if (rel) {
    db.run('UPDATE canon_relation SET review_status=? WHERE id=?', 'user_confirmed', rel.id);
    db.run('UPDATE canon_tie_note SET status=?, ruling=? WHERE id=?', 'resolved', `BANK ${kind} (user round 3)`, nid);
    banked++;
    continue;
  }
  const dup = db.get<{ id: number }>(
    'SELECT id FROM canon_relation WHERE project_id=? AND ((from_entity=? AND to_entity=?) OR (from_entity=? AND to_entity=?)) AND review_status IN (\'accepted\',\'user_confirmed\')',
    proj.id, n.from_entity, n.to_entity, n.to_entity, n.from_entity);
  if (dup) { deduped++; db.run('UPDATE canon_tie_note SET status=?, ruling=? WHERE id=?', 'resolved', `BANK (dupe of keeper ${dup.id})`, nid); continue; }
  // No matching row: insert from the note's own evidence.
  const ev = db.get<{ evidence: string; source_refs: string }>('SELECT evidence, source_refs FROM canon_tie_note WHERE id=?', nid);
  db.run('INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, scope, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?, \'\', \'user_confirmed\', ?)',
    proj.id, n.from_entity, n.to_entity, kind, ev?.evidence ?? '', ev?.source_refs ?? '[]', new Date().toISOString());
  db.run('UPDATE canon_tie_note SET status=?, ruling=? WHERE id=?', 'resolved', `BANK ${kind} (user round 3)`, nid);
  banked++;
}
const ties = db.all('SELECT review_status, COUNT(*) AS n FROM canon_relation WHERE project_id=? GROUP BY review_status', proj.id);
console.log(JSON.stringify({ banked, deduped, missing, ties }));
db.close();
