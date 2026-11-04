/**
 * Roster Stage A coverage audit (trials only; read-only, counts only).
 *
 * Reports how many entity rows exist, how many are persons, how many rows are
 * bare titles, and how many identity-collision groups the roster would flag.
 * Nothing is written: the database is opened read-only and no merge, rename,
 * re-kind or delete is executed or proposed.
 *
 * usage:
 *   node testing/trials/claim-confidence/roster-audit.ts --db <copy.db> [--project <name>]
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonicalName, isTitleToken, nameRelation } from '../../../fanfable/src/identity/names.ts';

const NAME_DF_CAP = 10;
const NAME_GROUP_CAP = 8;

interface EntityRow {
  id: number;
  name: string;
  aliases: string;
  kind: string;
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

function formsOf(row: EntityRow): string[] {
  let aliases: unknown = [];
  try {
    aliases = JSON.parse(row.aliases || '[]');
  } catch {
    aliases = [];
  }
  const forms = [row.name, ...(Array.isArray(aliases) ? aliases : [])]
    .map((form) => canonicalName(String(form ?? '')))
    .filter(Boolean);
  return [...new Set(forms)];
}

function isTitleOnlyForm(form: string): boolean {
  const tokens = form.split(' ').filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => isTitleToken(token));
}

function main(): void {
  const args = process.argv.slice(2);
  const dbPath = flag(args, 'db');
  if (!dbPath) {
    process.stderr.write('usage: roster-audit.ts --db <copy.db> [--project <name>]\n');
    process.exit(2);
  }
  if (!existsSync(dbPath)) {
    process.stderr.write(`database not found: ${dbPath}\n`);
    process.exit(2);
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const projects = db.prepare('SELECT id, name FROM project ORDER BY id').all() as { id: number; name: string }[];
    const wanted = flag(args, 'project');
    const project = wanted
      ? projects.find((row) => row.name === wanted)
      : projects.length === 1
        ? projects[0]
        : undefined;
    if (!project) {
      process.stderr.write('project not found or ambiguous; pass --project <name>\n');
      process.exit(2);
    }
    const entities = db
      .prepare('SELECT id, name, aliases, kind FROM canon_entity WHERE project_id = ? ORDER BY id')
      .all(project.id) as EntityRow[];

    const forms = new Map(entities.map((row) => [row.id, formsOf(row)]));
    const tokenFreq = new Map<string, number>();
    for (const row of entities) {
      const tokens = new Set(forms.get(row.id)!.flatMap((form) => form.split(' ').filter(Boolean)));
      for (const token of tokens) tokenFreq.set(token, (tokenFreq.get(token) ?? 0) + 1);
    }
    const contained = (short: string): number => {
      const shortTokens = short.split(' ').filter(Boolean);
      return entities.filter((row) => forms.get(row.id)!.some((form) => {
        const tokens = form.split(' ').filter(Boolean);
        return tokens.length > shortTokens.length && shortTokens.every((token) => tokens.includes(token));
      })).length;
    };
    const usableShort = (short: string): boolean => {
      const tokens = short.split(' ').filter(Boolean);
      if (!tokens.length) return false;
      if (!tokens.some((token) => token.length >= 3)) return false;
      if (tokens.some((token) => isTitleToken(token))) return false;
      if (tokens.some((token) => (tokenFreq.get(token) ?? 0) > NAME_DF_CAP)) return false;
      return contained(short) <= NAME_GROUP_CAP;
    };

    const parent = new Map<number, number>(entities.map((row) => [row.id, row.id]));
    const find = (id: number): number => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root)!;
      return root;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(rb, ra);
    };
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        let linked = false;
        for (const a of forms.get(entities[i]!.id)!) {
          for (const b of forms.get(entities[j]!.id)!) {
            const relation = nameRelation(a, b);
            if (relation === 'same') {
              linked = true;
              break;
            }
            if (relation !== 'containment') continue;
            const aTokens = a.split(' ').filter(Boolean);
            const bTokens = b.split(' ').filter(Boolean);
            const short = aTokens.length < bTokens.length ? a : b;
            if (usableShort(short)) {
              linked = true;
              break;
            }
          }
          if (linked) break;
        }
        if (linked) union(entities[i]!.id, entities[j]!.id);
      }
    }
    const sizes = new Map<number, number>();
    for (const row of entities) sizes.set(find(row.id), (sizes.get(find(row.id)) ?? 0) + 1);
    const collisionGroups = [...sizes.values()].filter((size) => size >= 2).length;
    const persons = entities.filter((row) => String(row.kind ?? '').trim().toLowerCase() === 'character').length;
    const titleOnlyRows = entities.filter((row) => {
      const tokens = canonicalName(row.name).split(' ').filter(Boolean);
      return tokens.length > 0 && tokens.every((token) => isTitleToken(token));
    }).length;

    console.log(JSON.stringify({
      entities: entities.length,
      persons,
      nonPersons: entities.length - persons,
      titleOnlyRows,
      collisionGroups,
    }));
  } finally {
    db.close();
  }
}

main();
