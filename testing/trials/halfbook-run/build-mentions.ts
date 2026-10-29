import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';

const DB = '/home/jacob/Documents/FanFable/testing/trials/halfbook-run/plagueis-half.db';
const KIND = 'appears with';

const db = new Db(DB);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name=?', 'halfbook')!;
const src = db.get<{ id: number; title: string }>('SELECT id, title FROM canon_source WHERE project_id=?', proj.id)!;
const people = db.all<{ id: number; name: string; aliases: string }>(
  "SELECT id, name, aliases FROM canon_entity WHERE project_id=? AND kind='character'", proj.id);
const chunks = db.all<{ id: number; seq: number; text: string; locator: string }>(
  'SELECT id, seq, text, locator FROM canon_chunk WHERE project_id=? ORDER BY seq', proj.id);

const norm = (s: string) => ' ' + (s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
const ctexts = chunks.map((c) => norm(c.text));
const varsOf = (e: { name: string; aliases: string }) => {
  const v = new Set([norm(e.name)]);
  try { for (const a of JSON.parse(e.aliases || '[]')) v.add(norm(a)); } catch { /* keep name */ }
  return [...v].filter((s) => s.trim().length > 3);
};
const seqsOf = (e: { name: string; aliases: string }) => {
  const vs = varsOf(e);
  const s = new Set<number>();
  ctexts.forEach((t, i) => { for (const v of vs) if (t.includes(v)) { s.add(i); break; } });
  return s;
};
const seqmap = new Map(people.map((e) => [e.id, seqsOf(e)]));
const touched = new Set<number>(db.all<{ e: number }>(
  'SELECT from_entity AS e FROM canon_relation WHERE project_id=? UNION SELECT to_entity AS e FROM canon_relation WHERE project_id=?',
  proj.id, proj.id).map((r) => r.e));
const existing = new Set(db.all<{ f: number; t: number; k: string }>(
  'SELECT from_entity AS f, to_entity AS t, kind AS k FROM canon_relation WHERE project_id=?', proj.id)
  .map((r) => `${Math.min(r.f, r.t)}|${Math.max(r.f, r.t)}|${r.k.toLowerCase()}`));

const ghosts = people.filter((e) => !touched.has(e.id));
const now = new Date().toISOString();
let inserted = 0, skipped = 0;
for (const g of ghosts) {
  const mine = seqsOf(g);
  for (const o of people) {
    if (o.id === g.id) continue;
    const os = seqmap.get(o.id)!;
    let shared = -1;
    for (const s of mine) if (os.has(s)) { shared = s; break; }
    if (shared < 0) continue;
    const key = `${Math.min(g.id, o.id)}|${Math.max(g.id, o.id)}|${KIND}`;
    // skip if these two already hold any tie in either direction
    const anyTie = [...existing].some((k) => {
      const [a, b] = k.split('|');
      return (Number(a) === Math.min(g.id, o.id) && Number(b) === Math.max(g.id, o.id));
    });
    if (anyTie || existing.has(key)) { skipped++; continue; }
    const ch = chunks[shared]!;
    const refs = JSON.stringify([{ source: src.title, locator: ch.locator, chunk: ch.id }]);
    const [f, t] = g.id < o.id ? [g.id, o.id] : [o.id, g.id];
    db.run(`INSERT INTO canon_relation (project_id, from_entity, to_entity, kind, evidence, source_refs, scope, review_status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, '', 'needs_review', ?)`,
      proj.id, f, t, KIND, ch.text.slice(0, 300), refs, now);
    existing.add(key);
    inserted++;
  }
}
const touchedNow = new Set<number>(db.all<{ e: number }>(
  'SELECT from_entity AS e FROM canon_relation WHERE project_id=? UNION SELECT to_entity AS e FROM canon_relation WHERE project_id=?',
  proj.id, proj.id).map((r) => r.e));
const peopleTouched = people.filter((e) => touchedNow.has(e.id)).length;
console.log(JSON.stringify({ ghosts, mention_edges_inserted: inserted, skipped_have_tie: skipped, people_touched_now: peopleTouched, of_people: people.length }));
db.close();
