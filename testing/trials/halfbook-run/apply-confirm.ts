import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';

// Confirmation-round application (Gemini blind + user final word).
// DEMOTE: keeper -> parked (quote doesn't prove the row as banked).
// REPOINT 44/47: quote proves Aks Moe -> Trade Federation ally, not Palpatine.
const DB = '/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db';
const DEMOTE = [33, 74, 85, 216, 218, 235, 263];
const REPOINT = [44, 47]; // -> Aks Moe -> Trade Federation(23), ally of

const db = new Db(DB);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name=?', 'halfbook')!;
const now = new Date().toISOString();
const log: string[] = [];

const aks = db.get<{ id: number }>("SELECT id FROM canon_entity WHERE project_id=? AND lower(name)='aks moe'", proj.id);
const tf = db.get<{ id: number }>("SELECT id FROM canon_entity WHERE project_id=? AND lower(name)='trade federation'", proj.id);
if (!aks || !tf) throw new Error('missing Aks Moe or Trade Federation entity');

for (const rid of REPOINT) {
  const r = db.get<any>('SELECT * FROM canon_relation WHERE id=? AND project_id=?', rid, proj.id);
  if (!r || r.review_status !== 'user_confirmed') { log.push(`${rid}: skip (not user_confirmed)`); continue; }
  const dup = db.get<{ id: number }>('SELECT id FROM canon_relation WHERE project_id=? AND from_entity=? AND to_entity=? AND lower(kind)=?', proj.id, aks.id, tf.id, String(r.kind).toLowerCase());
  if (dup && dup.id !== rid) {
    db.run('DELETE FROM canon_relation WHERE id=?', rid);
    log.push(`${rid}: repoint target exists as ${dup.id}; dropped duplicate`);
  } else {
    db.run('UPDATE canon_relation SET from_entity=?, to_entity=? WHERE id=?', aks.id, tf.id, rid);
    log.push(`${rid}: repointed to Aks Moe -> Trade Federation (${r.kind})`);
  }
}
for (const rid of DEMOTE) {
  const r = db.get<any>('SELECT * FROM canon_relation WHERE id=? AND project_id=?', rid, proj.id);
  if (!r) { log.push(`${rid}: missing`); continue; }
  if (r.review_status === 'needs_review') { log.push(`${rid}: already parked`); continue; }
  db.run("UPDATE canon_relation SET review_status='needs_review' WHERE id=?", rid);
  log.push(`${rid}: demoted to parked (${r.kind})`);
}
const k38 = db.get('SELECT review_status FROM canon_relation WHERE id=38 AND project_id=?', proj.id);
log.push(`38: kept user_confirmed (alias-resolved Hego=Plagueis): ${(k38 as { review_status: string } | undefined)?.review_status}`);
const ties = db.all('SELECT review_status, COUNT(*) AS n FROM canon_relation WHERE project_id=? GROUP BY review_status', proj.id);
console.log(JSON.stringify({ actions: log, ties }));
void now;
db.close();
