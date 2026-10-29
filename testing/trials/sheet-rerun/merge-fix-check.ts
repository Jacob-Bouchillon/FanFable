// One-off functional check: run the identity sweep on a COPY of the sheet-rerun
// DB and report what flags. Never touches plagueis-sheet.db.
import { Db } from '../../../fanfable/src/db.ts';
import { checkEntities } from '../../../fanfable/src/rule-checker.ts';
import * as lorebook from '../../../fanfable/src/lorebook.ts';

const db = new Db(new URL('./merge-fix-check.db', import.meta.url).pathname);
const p = db.get<{ id: number }>(`SELECT id FROM project WHERE name = 'sheet-rerun'`)!.id;
const before = db.all<{ name: string; review_status: string }>(
  `SELECT name, review_status FROM canon_entity WHERE project_id = ? AND review_status != 'accepted'`, p);
console.log('flagged before:', JSON.stringify(before));
const hits = checkEntities(db, p);
console.log('hits:', JSON.stringify(hits));
for (const h of hits) {
  const r = db.get<{ name: string; review_status: string }>('SELECT name, review_status FROM canon_entity WHERE id = ?', h.id);
  console.log(`- ${r!.name}: ${r!.review_status} [${h.rule}] ${h.reason.slice(0, 90)}`);
}
const q = db.all<{ name: string; candidate: string; reason: string }>(
  `SELECT name, candidate, reason FROM quarantine_alias WHERE project_id = ? AND status = 'pending'`, p);
console.log('pending quarantine:', JSON.stringify(q.map((x) => `${x.name} ~ ${x.candidate} (${x.reason.slice(0, 60)})`)));
const idx = lorebook.searchLore(db, p, 'palpatine plagueis sidious', 10);
console.log('answer index entities:', JSON.stringify(idx.entities.map((e) => e.name)));
db.close();
