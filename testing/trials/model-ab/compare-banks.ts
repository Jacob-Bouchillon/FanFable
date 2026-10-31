/**
 * Compare two extraction banks from the same source (trials only).
 *
 * Prints counts and the marginal tie sets in both directions, keyed by
 * lowercased endpoint names plus kind, so the same pair written twice counts
 * once. Also reports how many endpoints each side failed to resolve into an
 * entity row of its own bank.
 *
 * usage: node compare-banks.ts <dbA> <dbB>
 */
import { Db } from '../../../fanfable/src/core/db.ts';
import { CLOSED_ROLE_KINDS } from '../../../fanfable/src/lorebook.ts';

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error('usage: compare-banks.ts <dbA> <dbB>');
  process.exit(2);
}

interface Row {
  kind: string;
  fn: string;
  tn: string;
  review_status: string;
}

function load(path: string): { rows: Row[]; entities: number; keys: Set<string> } {
  const db = new Db(path);
  const proj = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', 'ab');
  if (!proj) throw new Error(`no project ab in ${path}`);
  const rows = db.all<Row>(
    `SELECT r.kind, r.review_status, a.name AS fn, b.name AS tn
       FROM canon_relation r
       JOIN canon_entity a ON a.id = r.from_entity
       JOIN canon_entity b ON b.id = r.to_entity
      WHERE r.project_id = ?`,
    proj.id,
  );
  const entities = db.get<{ n: number }>('SELECT COUNT(*) n FROM canon_entity WHERE project_id = ?', proj.id)?.n ?? 0;
  db.close();
  const keys = new Set<string>();
  for (const r of rows) keys.add(key(r));
  return { rows, entities, keys };
}

const norm = (s: string) => s.trim().toLowerCase();
const key = (r: Row) => `${norm(r.fn)}|${norm(r.kind)}|${norm(r.tn)}`;

const A = load(aPath);
const B = load(bPath);
const onlyA = [...A.keys].filter((k) => !B.keys.has(k));
const onlyB = [...B.keys].filter((k) => !A.keys.has(k));
const shared = [...A.keys].filter((k) => B.keys.has(k));

console.log(
  JSON.stringify(
    {
      a: { path: aPath, relations: A.rows.length, entities: A.entities, distinct: A.keys.size },
      b: { path: bPath, relations: B.rows.length, entities: B.entities, distinct: B.keys.size },
      shared: shared.length,
      onlyA: onlyA.length,
      onlyB: onlyB.length,
      onlyASample: onlyA.slice(0, 15),
      onlyBSample: onlyB.slice(0, 15),
      onlyAClosed: onlyA.filter((k) => CLOSED_ROLE_KINDS.includes(k.split('|')[1] ?? '')).length,
      onlyBClosed: onlyB.filter((k) => CLOSED_ROLE_KINDS.includes(k.split('|')[1] ?? '')).length,
    },
    null,
    0,
  ),
);
