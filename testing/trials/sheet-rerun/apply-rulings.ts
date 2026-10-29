// Applies the human's merge rulings on the disposable muzzle-check copy:
//   Damask -> Hego Damask, Palpatine -> Darth Sidious (keep-longer convention,
//   same as the model-judge path). Mirrors judgeQuarantine's settle().
// Never touches plagueis-sheet.db.
import { Db } from '../../../fanfable/src/db.ts';
import { listEntities, mergeEntityPair } from '../../../fanfable/src/lorebook.ts';

const db = new Db(new URL('./muzzle-check.db', import.meta.url).pathname);
const project = db.get<{ id: number }>(`SELECT id FROM project WHERE name = 'sheet-rerun'`)!;
const byName = new Map(listEntities(db, project.id).map((e) => [e.name, e]));
const now = new Date().toISOString();

for (const [dropName, keepName] of [['Damask', 'Hego Damask'], ['Palpatine', 'Darth Sidious']] as const) {
  const drop = byName.get(dropName);
  const keep = byName.get(keepName);
  if (!drop || !keep) {
    console.log(`SKIP ${dropName} -> ${keepName}: row missing (already merged?)`);
    continue;
  }
  mergeEntityPair(db, project.id, keep, drop);
  db.run(
    `UPDATE quarantine_alias SET status = 'merged', ruling = ?, ruled_at = ? WHERE project_id = ? AND ((name = ? AND candidate = ?) OR (name = ? AND candidate = ?))`,
    `human ruling: ${dropName} -> ${keepName}`, now, project.id, dropName, keepName, keepName, dropName,
  );
  console.log(`merged ${dropName} -> ${keepName}; aliases now: [${[...keep.aliases, dropName].join(', ')}]`);
}
// Verify: no dangling relations, losers gone, aliases carried.
const dangling = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM canon_relation r LEFT JOIN canon_entity e ON e.id IN (r.from_entity, r.to_entity) WHERE r.project_id = ? AND e.id IS NULL`, project.id)!.n;
console.log('dangling relations:', dangling);
for (const n of ['Hego Damask', 'Darth Sidious', 'Damask', 'Palpatine']) {
  const r = db.get<{ name: string; aliases: string }>('SELECT name, aliases FROM canon_entity WHERE project_id = ? AND name = ?', project.id, n);
  console.log(r ? `${r.name} aliases=${r.aliases}` : `${n}: row gone`);
}
db.close();
