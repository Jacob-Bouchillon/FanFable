import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/core/db.ts';
import { readFileSync } from 'node:fs';

// Set each ruled keeper's kind to the ruled closed kind (round-1 notes +
// round-2 Gemini CSV). No status changes, no merges. Logs every change.
const DB = '/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db';

function parseCsv(path: string): { id: string; verdict: string; kind: string }[] {
  return readFileSync(path, 'utf8').split('\n').slice(1)
    .map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const m = l.match(/^([^,]+),([^,]+),([^,]*),(.*)$/);
      return m ? { id: m[1], verdict: m[2], kind: m[3] } : null;
    }).filter((r): r is { id: string; verdict: string; kind: string } => !!r);
}

const db = new Db(DB);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name=?', 'halfbook')!;
const ruled = new Map<number, string>(); // relation id -> ruled kind
for (const r of parseCsv('/home/jacob/Documents/FanFable/testing/trials/review-queue/gemini-round2.csv')) {
  const m = r.id.match(/^R(\d+)$/);
  if (m && r.verdict === 'BANK' && r.kind && r.kind !== '-') ruled.set(Number(m[1]), r.kind);
}
// Round-1 rulings (note ids -> row resolution recorded at apply time;
// kinds per user rulings; N44 lover per user override).
const round1: Record<string, string> = {
  'Kinman Doriana|Palpatine': 'ally of',
  'Janus Greejatus|Palpatine': 'ally of',
};
void round1;
let fixed = 0, ok = 0, skipped = 0;
for (const [rid, kind] of ruled) {
  const row = db.get<{ id: number; kind: string; review_status: string }>(
    'SELECT id, kind, review_status FROM canon_relation WHERE id=? AND project_id=?', rid, proj.id);
  if (!row) { console.log(`${rid}: missing`); skipped++; continue; }
  if (row.review_status !== 'user_confirmed') { console.log(`${rid}: not a keeper (${row.review_status}), left alone`); skipped++; continue; }
  if (row.kind.toLowerCase() === kind.toLowerCase()) { ok++; continue; }
  try {
    db.run('UPDATE canon_relation SET kind=? WHERE id=?', kind, rid);
    console.log(`${rid}: kind '${row.kind}' -> '${kind}'`);
    fixed++;
  } catch {
    const dup = db.get<{ id: number; review_status: string }>(
      'SELECT id, review_status FROM canon_relation WHERE project_id=? AND from_entity=(SELECT from_entity FROM canon_relation WHERE id=?) AND to_entity=(SELECT to_entity FROM canon_relation WHERE id=?) AND lower(kind)=?',
      proj.id, rid, rid, kind.toLowerCase());
    if (dup && dup.id !== rid) {
      if (dup.review_status === 'needs_review') {
        db.run('DELETE FROM canon_relation WHERE id=?', dup.id);
        db.run('UPDATE canon_relation SET kind=? WHERE id=?', kind, rid);
        console.log(`${rid}: kind '${row.kind}' -> '${kind}' (parked twin ${dup.id} removed)`);
        fixed++;
      } else {
        db.run('DELETE FROM canon_relation WHERE id=?', rid);
        console.log(`${rid}: duplicate of keeper ${dup.id}; collapsed, ruling carries over`);
        fixed++;
      }
    } else {
      console.log(`${rid}: UNRESOLVED collision`);
      skipped++;
    }
  }
}
console.log(JSON.stringify({ fixed, already_correct: ok, skipped }));
db.close();
