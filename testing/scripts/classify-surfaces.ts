/**
 * Apply the surface-shape rule to the bank. Dry run unless --write.
 *
 *   node --no-warnings testing/scripts/classify-surfaces.ts --db <path> --project hp1 [--write]
 */
import { Db } from '../../fanfable/src/core/db.ts';
import { reclassifyEntityKind } from '../../fanfable/src/lorebook.ts';
import { surfaceShape } from '../../fanfable/src/identity/surface-shape.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const projectName = flag('project');
const write = args.includes('--write');
if (!dbPath || !projectName) {
  console.error('usage: classify-surfaces.ts --db <path> --project <name> [--write]');
  process.exit(2);
}

const db = new Db(dbPath);
const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
if (!project) throw new Error(`project not found: ${projectName}`);

const entities = db.all<{ id: number; name: string; kind: string }>(
  "SELECT id, name, kind FROM canon_entity WHERE project_id = ? AND review_status <> 'quarantined' AND kind IN ('creature','species') ORDER BY name",
  project.id,
);

let changed = 0;
const rows: string[] = [];
for (const entity of entities) {
  const shape = surfaceShape(db, project.id, entity.name);
  if (shape.shape === 'kind-list' && entity.kind === 'creature') {
    rows.push(`${entity.name}: creature -> species (${shape.reason})`);
    if (write) reclassifyEntityKind(db, project.id, entity.id, 'species', shape.reason);
    changed++;
  }
}

console.log(`${entities.length} creatures/species checked, ${changed} reclassified${write ? '' : ' (dry run)'}`);
for (const row of rows.slice(0, 40)) console.log('  ' + row);
db.close();
