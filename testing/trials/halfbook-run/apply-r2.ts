import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import * as lorebook from '/home/jacob/Documents/FanFable/fanfable/src/lorebook.ts';

const DB = '/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db';
// Relation ids approved BANK (round 2). SKIP ids are left parked, untouched.
const BANK = [12,13,15,19,22,24,33,37,38,40,41,44,47,55,56,57,58,61,78,79,80,81,82,83,84,85,91,96,97,207,216,217,218,220,224,235,247,248,257,263,266,273];
// User-ordered merges: [keep, drop] (keep-longer convention; user ruled the identity).
const MERGES: [string, string][] = [
  ['Sate Pestage', 'Pestage'],
  ['Qui-Gon Jinn', 'Qui-Gon'],
  ['Silvestri Trace Power (STP)', 'STP'],
  ['Senator Vidar Kim', 'Kim'],
  ['Darth Plagueis', 'Hego Damask'],
];

const db = new Db(DB);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name=?', 'halfbook')!;
const now = new Date().toISOString();
let banked = 0, already = 0;
for (const rid of BANK) {
  const r = db.get<{ id: number; review_status: string }>(
    'SELECT id, review_status FROM canon_relation WHERE id = ? AND project_id = ?', rid, proj.id);
  if (!r) { console.log(`relation ${rid}: missing`); continue; }
  if (r.review_status !== 'needs_review') { already++; continue; }
  db.run("UPDATE canon_relation SET review_status = 'user_confirmed' WHERE id = ?", rid);
  banked++;
}
console.log(JSON.stringify({ banked_new: banked, already_kept: already }));

const merged: string[] = [];
for (const [keepName, dropName] of MERGES) {
  const keep = lorebook.findEntity(db, proj.id, keepName);
  const drop = lorebook.findEntity(db, proj.id, dropName);
  if (!keep || !drop) { console.log(`merge ${dropName} -> ${keepName}: MISSING`, !!keep, !!drop); continue; }
  if (keep.id === drop.id) { console.log(`merge ${dropName} -> ${keepName}: same row`); continue; }
  lorebook.mergeEntityPair(db, proj.id, keep as never, drop as never);
  // Remap pending tie notes pointing at the dropped row so nothing dangles.
  db.run('UPDATE canon_tie_note SET from_entity = ? WHERE project_id = ? AND from_entity = ?', keep.id, proj.id, drop.id);
  db.run('UPDATE canon_tie_note SET to_entity = ? WHERE project_id = ? AND to_entity = ?', keep.id, proj.id, drop.id);
  merged.push(`${dropName} -> ${keepName}`);
  void now;
}
console.log(JSON.stringify({ merged }));
const ties = db.all('SELECT review_status, COUNT(*) AS n FROM canon_relation WHERE project_id = ? GROUP BY review_status', proj.id);
console.log(JSON.stringify(ties));
db.close();
