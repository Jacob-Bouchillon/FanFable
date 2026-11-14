/**
 * Resolve unlinked BookNLP clusters locally.
 *
 *   node --no-warnings testing/scripts/resolve-local-clusters.ts --db <path> --project hp1 [--write]
 *
 * A definite description ("the snake") has no proper name, so BookNLP leaves
 * its cluster unlinked. Within the chunks where it occurs, the local roster
 * usually contains exactly one entity of the right kind. If so, the mention is
 * that entity — the same logic a reader uses: only one snake is in the scene.
 */
import { Db } from '../../fanfable/src/core/db.ts';
import { linkMentions } from '../../fanfable/src/lorebook.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const projectName = flag('project');
const write = args.includes('--write');
if (!dbPath || !projectName) {
  console.error('usage: resolve-local-clusters.ts --db <path> --project <name> [--write]');
  process.exit(2);
}

const db = new Db(dbPath);
const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
if (!project) throw new Error(`project not found: ${projectName}`);

const clusters = db.all<{ cluster_id: number }>(
  `SELECT DISTINCT cluster_id FROM canon_mention
    WHERE project_id = ? AND entity_id IS NULL AND cluster_id IS NOT NULL
    ORDER BY cluster_id`,
  project.id,
);

let resolved = 0;
const examples: string[] = [];
for (const row of clusters) {
  const clusterId = Number(row.cluster_id);
  const mentions = db.all<{ chunk_id: number; surface: string }>(
    'SELECT chunk_id, surface FROM canon_mention WHERE project_id = ? AND cluster_id = ?',
    project.id,
    clusterId,
  );
  const chunkIds = [...new Set(mentions.map((mention) => Number(mention.chunk_id)))];
  if (!chunkIds.length) continue;
  const candidates = db.all<{ id: number; name: string; kind: string }>(
    `SELECT DISTINCT e.id, e.name, e.kind
       FROM canon_mention m JOIN canon_entity e ON e.id = m.entity_id
      WHERE m.project_id = ?
        AND m.chunk_id IN (${chunkIds.map(() => '?').join(', ')})
        AND e.kind IN ('creature', 'species')`,
    project.id,
    ...chunkIds,
  );
  if (candidates.length !== 1) continue;
  const candidate = candidates[0]!;
  resolved++;
  if (examples.length < 10) {
    examples.push(`cluster ${clusterId} (${[...new Set(mentions.map((mention) => mention.surface))].slice(0, 3).join(', ')}) -> ${candidate.name}`);
  }
  if (write) linkMentions(db, project.id, clusterId, Number(candidate.id));
}

console.log(`${clusters.length} unlinked clusters · ${resolved} resolved by local roster${write ? '' : ' (dry run)'}`);
for (const example of examples) console.log('  ' + example);
db.close();
