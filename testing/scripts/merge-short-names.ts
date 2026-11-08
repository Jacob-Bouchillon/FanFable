/**
 * Merge a short character name into the one full name it abbreviates.
 *
 *   node --no-warnings testing/scripts/merge-short-names.ts --db <path> --project hp1 [--write]
 *
 * Rule: if exactly one other character name starts with "<short> " and no other
 * character carries the short name, the short form is that person. No name list.
 */
import { Db } from '../../fanfable/src/core/db.ts';
import { mergeEntitiesWithRuling } from '../../fanfable/src/lorebook.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const projectName = flag('project');
const write = args.includes('--write');
if (!dbPath || !projectName) {
  console.error('usage: merge-short-names.ts --db <path> --project <name> [--write]');
  process.exit(2);
}

const db = new Db(dbPath);
const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
if (!project) throw new Error(`project not found: ${projectName}`);

const characters = db.all<{ id: number; name: string }>(
  "SELECT id, name FROM canon_entity WHERE project_id = ? AND kind = 'character' AND review_status <> 'quarantined' ORDER BY name",
  project.id,
);
const norm = (value: string) => value.toLowerCase().trim();

const merges: Array<{ keepId: number; keepName: string; dropId: number; dropName: string }> = [];
for (const short of characters) {
  const key = norm(short.name);
  if (!key) continue;
  const longer = characters.filter((other) =>
    other.id !== short.id && norm(other.name).startsWith(`${key} `));
  if (longer.length !== 1) continue;
  const sameShort = characters.filter((other) =>
    other.id !== short.id && norm(other.name) === key);
  if (sameShort.length) continue;
  merges.push({ keepId: longer[0]!.id, keepName: longer[0]!.name, dropId: short.id, dropName: short.name });
}

console.log(`${merges.length} short name(s) resolve to a single full name${write ? '' : ' (dry run)'}`);
for (const merge of merges) console.log(`  ${merge.dropName} -> ${merge.keepName}`);
if (write) {
  for (const merge of merges) {
    mergeEntitiesWithRuling(db, project.id, merge.keepId, merge.dropId, 'short name is a unique prefix of the full character name');
  }
  console.log(`merged ${merges.length}`);
}
db.close();
