/**
 * Repair mentions that are linked to the wrong entity even though their surface
 * text names another one.
 *
 *   node --no-warnings testing/scripts/repair-explicit-name-links.ts --db <path> --project hp1 [--write]
 *
 * Coreference assigns a whole cluster to one entity, so an explicit name inside
 * a cluster can be swallowed by a neighbour: 104 mentions reading "Neville"
 * were linked to Ronald Weasley, 51 reading "Dumbledore" to McGonagall. The
 * text is explicit, so it outranks the inferred cluster: if the surface is a
 * proper form (capitalised) and names exactly one entity, the mention belongs
 * to that entity.
 *
 * Only proper forms count. A lowercase alias ("forest", "the school") is a
 * description, not a name, and would pull unrelated mentions across the bank.
 */
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const projectName = flag('project');
const write = args.includes('--write');
if (!dbPath || !projectName) {
  console.error('usage: repair-explicit-name-links.ts --db <path> --project <name> [--write]');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: !write });
const project = db.prepare('SELECT id FROM project WHERE name = ?').get(projectName) as { id: number } | undefined;
if (!project) throw new Error(`project not found: ${projectName}`);

const normalize = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const names = new Map<number, string>();
const forms = new Map<string, Set<number>>();
const entities = db.prepare(
  "SELECT id, name, aliases FROM canon_entity WHERE project_id = ? AND review_status <> 'quarantined'",
).all(project.id) as Array<{ id: number; name: string; aliases: string }>;
for (const entity of entities) {
  names.set(Number(entity.id), entity.name);
  let aliases: string[] = [];
  try { aliases = JSON.parse(entity.aliases || '[]'); } catch { /* none */ }
  for (const form of [entity.name, ...aliases]) {
    // A proper form starts with a capital letter; "forest" is a description.
    if (!/^\p{Lu}/u.test(form.trim())) continue;
    const key = normalize(form);
    if (key.length < 3) continue;
    if (!forms.has(key)) forms.set(key, new Set());
    forms.get(key)!.add(Number(entity.id));
  }
}

const mentions = db.prepare(
  'SELECT id, entity_id, surface FROM canon_mention WHERE project_id = ? AND entity_id IS NOT NULL',
).all(project.id) as Array<{ id: number; entity_id: number; surface: string }>;

const pairs = new Map<string, number>();
const ids: number[] = [];
for (const mention of mentions) {
  const surface = String(mention.surface).trim();
  if (!/^\p{Lu}/u.test(surface)) continue;
  const owners = forms.get(normalize(surface));
  if (!owners || owners.size !== 1) continue;
  const target = [...owners][0]!;
  if (target === Number(mention.entity_id)) continue;
  ids.push(Number(mention.id));
  const key = `${mention.entity_id}->${target}`;
  pairs.set(key, (pairs.get(key) ?? 0) + 1);
}

const label = (id: number): string => names.get(Number(id)) ?? `#${id}`;
console.log(`${ids.length} mentions name a different entity than the one they are linked to`);
for (const [key, count] of [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  const [from, to] = key.split('->').map(Number) as [number, number];
  console.log(`  ${count.toString().padStart(4)}  ${label(from)} -> ${label(to)}`);
}
if (write) {
  const update = db.prepare('UPDATE canon_mention SET entity_id = ?, method = ? WHERE id = ?');
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const mention of mentions) {
      if (!ids.includes(Number(mention.id))) continue;
      const surface = String(mention.surface).trim();
      const target = [...(forms.get(normalize(surface)) ?? [])][0]!;
      update.run(target, 'explicit-name-repair', Number(mention.id));
      changed++;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(`relinked ${changed} mentions`);
} else {
  console.log('(dry run — rerun with --write to relink)');
}
db.close();
