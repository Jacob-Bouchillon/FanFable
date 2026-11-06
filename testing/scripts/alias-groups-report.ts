/**
 * Read-only alias-group report.
 *
 * Opens the database read-only, loads one project's entities, and prints the
 * deterministic alias proposals. Nothing is written.
 */
import { DatabaseSync } from 'node:sqlite';
import { fromJson } from '../../fanfable/src/core/db.ts';
import { proposeAliasGroups, type AliasEntityInput } from '../../fanfable/src/identity/alias-groups.ts';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dbPath = flag('db') ?? process.argv[2];
const projectName = flag('project') ?? process.argv[3] ?? 'hp1';
if (!dbPath) {
  console.error('usage: node --no-warnings testing/scripts/alias-groups-report.ts --db <path> --project <name>');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const project = db.prepare('SELECT id, name FROM project WHERE name = ?').get(projectName) as
    | { id: number; name: string }
    | undefined;
  if (!project) {
    console.error(`no project named "${projectName}" in ${dbPath}`);
    db.close();
    process.exit(1);
  }

  const rows = db.prepare(
    'SELECT id, name, aliases, kind FROM canon_entity WHERE project_id = ? ORDER BY id',
  ).all(project.id) as Array<{ id: number; name: string; aliases: string; kind: string }>;
  const entities: AliasEntityInput[] = rows.map((row) => ({
    id: Number(row.id),
    name: String(row.name ?? ''),
    aliases: fromJson<string[]>(row.aliases, []).map(String).filter(Boolean),
    kind: String(row.kind ?? ''),
  }));

  const relationRows = db.prepare(
    'SELECT from_entity, to_entity FROM canon_relation WHERE project_id = ?',
  ).all(project.id) as Array<{ from_entity: number; to_entity: number }>;
  const nameById = new Map(entities.map((entity) => [entity.id, entity.name]));

  const groups = proposeAliasGroups(entities).map((group) => {
    const members = new Set(group.memberIds);
    const relationCount = relationRows.filter((relation) =>
      members.has(Number(relation.from_entity)) || members.has(Number(relation.to_entity))).length;
    return {
      canonicalId: group.canonicalId,
      canonicalName: nameById.get(group.canonicalId) ?? '',
      memberIds: group.memberIds,
      names: group.memberIds.map((id) => nameById.get(id) ?? `#${id}`),
      reason: group.reason,
      forms: group.forms,
      relationCount,
    };
  });

  console.log(JSON.stringify({
    project,
    entityCount: entities.length,
    groupCount: groups.length,
    coveredEntities: groups.reduce((sum, group) => sum + group.memberIds.length, 0),
    groups,
  }, null, 2));
} finally {
  db.close();
}
