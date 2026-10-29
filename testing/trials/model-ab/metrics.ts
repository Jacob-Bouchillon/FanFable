import { Db } from '/home/jacob/Documents/FanFable/fanfable/src/db.ts';
import * as names from '/home/jacob/Documents/FanFable/fanfable/src/names.ts';
import * as lb from '/home/jacob/Documents/FanFable/fanfable/src/lorebook.ts';

const dbPath = process.argv[2];
const projectName = process.argv[3] ?? 'ab';
if (!dbPath) {
  console.error('usage: metrics.ts <db> [project]');
  process.exit(2);
}

const db = new Db(dbPath);
const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
if (!proj) {
  console.error('no project', projectName);
  process.exit(2);
}

function vars(name: string, aliases: string): string[] {
  let out = [name];
  try {
    const a = JSON.parse(aliases || '[]');
    if (Array.isArray(a)) out = out.concat(a.map(String));
  } catch {}
  return out;
}

const rows = db.all<{
  id: number;
  kind: string;
  evidence: string;
  review_status: string;
  fn: string;
  fa: string;
  tn: string;
  ta: string;
}>(
  `SELECT r.id, r.kind, r.evidence, r.review_status,
          a.name AS fn, a.aliases AS fa, b.name AS tn, b.aliases AS ta
     FROM canon_relation r
     JOIN canon_entity a ON a.id = r.from_entity
     JOIN canon_entity b ON b.id = r.to_entity
    WHERE r.project_id = ?`,
  proj.id,
);

let closed = 0;
let bothNamed = 0;
let tieWord = 0;
let provable = 0;
const kinds = new Map<string, number>();
for (const r of rows) {
  const kind = String(r.kind || '').trim().toLowerCase();
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  const isClosed = lb.CLOSED_ROLE_KINDS.includes(kind);
  if (isClosed) closed++;
  const a = vars(r.fn, r.fa);
  const b = vars(r.tn, r.ta);
  const named = a.some((v) => names.nameMentionedExact(v, r.evidence)) && b.some((v) => names.nameMentionedExact(v, r.evidence));
  if (named) bothNamed++;
  const word = !lb.isUnsupportedKind(kind, r.evidence);
  if (word) tieWord++;
  if (isClosed && named && word) provable++;
}

const entities = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM canon_entity WHERE project_id = ?', proj.id)?.n ?? 0;
const top = [...kinds.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, v]) => `${k}:${v}`).join(', ');
console.log(JSON.stringify({
  project: projectName,
  relations: rows.length,
  entities,
  closedKind: closed,
  bothNamed,
  tieWord,
  provable,
  topKinds: top,
}));
db.close();
