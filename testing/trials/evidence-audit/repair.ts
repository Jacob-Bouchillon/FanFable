import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import { readFileSync, writeFileSync } from 'node:fs';

const DB = '/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db';
const AUDIT = '/home/jacob/Documents/FanFable/testing/trials/evidence-audit/audit.json';

const db = new Db(DB);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'halfbook')!;
const audit = JSON.parse(readFileSync(AUDIT, 'utf8')) as {
  counts: Record<string, number>;
  rows: { id: number; cls: string; refChunk?: number; foundChunk?: number; loc?: string }[];
};

const chunks = db.all<{ id: number; locator: string; heading: string }>(
  'SELECT id, locator, heading FROM canon_chunk WHERE project_id = ?',
  proj.id,
);
const byId = new Map(chunks.map((c) => [c.id, c]));
const source = db.get<{ title: string }>('SELECT title FROM canon_source WHERE project_id = ?', proj.id)?.title ?? '';

let repaired = 0;
const actions: { id: number; action: string; chunk?: number }[] = [];
for (const row of audit.rows) {
  if (row.cls === 'stale-ref' && row.foundChunk) {
    const chunk = byId.get(row.foundChunk);
    if (!chunk) continue;
    const refs = JSON.stringify([{ source, locator: chunk.locator, chunk: chunk.id }]);
    db.run('UPDATE canon_relation SET source_refs = ? WHERE id = ? AND project_id = ?', refs, row.id, proj.id);
    repaired++;
    actions.push({ id: row.id, action: 'ref-repaired', chunk: chunk.id });
  } else {
    actions.push({ id: row.id, action: `kept-parked:${row.cls}` });
  }
}

writeFileSync(
  '/home/jacob/Documents/FanFable/testing/trials/evidence-audit/repair.json',
  JSON.stringify({ repaired, actions }, null, 2),
);
console.log(JSON.stringify({ repaired, actions: actions.slice(0, 12) }, null, 2));
db.close();
