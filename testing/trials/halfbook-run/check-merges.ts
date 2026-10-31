import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/core/db.ts';

const DB = '/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db';
// Standing merges (user-ruled). Re-applied if the full extract re-created a dropped name.
const MERGES: [string, string][] = [
  ['Senator Vidar Kim', 'Kim'],
  ['Sate Pestage', 'Pestage'],
  ['Silvestri Trace Power (STP)', 'STP'],
  ['Qui-Gon Jinn', 'Qui-Gon'],
  ['Darth Plagueis', 'Hego Damask'],
];
const db = new Db(DB);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name=?', 'halfbook')!;
for (const [keep, drop] of MERGES) {
  const k = db.get<{ id: number; name: string }>('SELECT id, name FROM canon_entity WHERE project_id=? AND lower(name)=lower(?)', proj.id, keep);
  const d = db.get<{ id: number; name: string }>('SELECT id, name FROM canon_entity WHERE project_id=? AND lower(name)=lower(?)', proj.id, drop);
  console.log(`merge-check ${drop} -> ${keep}:`, k ? `keep#${k.id}` : 'KEEP-MISSING', d ? `drop#${d.id} STILL EXISTS` : 'drop-gone');
}
db.close();
