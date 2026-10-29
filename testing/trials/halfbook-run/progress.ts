import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
const db = new Db('/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db');
const proj = db.get<{ id: number }>("SELECT id FROM project WHERE name='halfbook'");
const mined = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_chunk WHERE project_id=? AND lore_mined=1', proj.id);
const ties = db.all<{ review_status: string; n: number }>('SELECT review_status, COUNT(*) AS n FROM canon_relation WHERE project_id=? GROUP BY review_status', proj.id);
console.log('mined chunks: ' + mined.n + ' / 1448 | ties: ' + ties.map((t) => t.review_status + '=' + t.n).join(' '));
db.close();
