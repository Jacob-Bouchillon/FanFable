/**
 * Resolve an unnamed cluster with the model, constrained to the scene roster.
 *
 *   node --no-warnings testing/scripts/resolve-cluster.ts --db <path> --project hp1 --cluster 663 [--write]
 *
 * The model sees the passage and the entities present in it, and may answer
 * "unknown". A cluster is only linked when the answer is one of the candidates.
 */
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const projectName = flag('project');
const clusterId = Number(flag('cluster'));
const baseUrl = flag('base-url') ?? 'http://127.0.0.1:11434';
const model = flag('model') ?? 'qwen3.5:9b';
const write = args.includes('--write');
if (!dbPath || !projectName || !Number.isFinite(clusterId)) {
  console.error('usage: resolve-cluster.ts --db <path> --project <name> --cluster <id> [--write]');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: !write });
const project = db.prepare('SELECT id FROM project WHERE name = ?').get(projectName) as { id: number } | undefined;
if (!project) throw new Error(`project not found: ${projectName}`);

const mentions = db.prepare(
  `SELECT m.chunk_id, m.surface, c.text, c.locator
     FROM canon_mention m JOIN canon_chunk c ON c.id = m.chunk_id
    WHERE m.project_id = ? AND m.cluster_id = ?
    ORDER BY m.id`,
).all(project.id, clusterId) as Array<{ chunk_id: number; surface: string; text: string; locator: string }>;
if (!mentions.length) throw new Error(`cluster ${clusterId} has no mentions`);

const chunk = mentions[0]!;
// The roster is the scene, not the single chunk: the snake is named on the sign
// one page after the paragraph that says "the snake".
const seqRow = db.prepare('SELECT seq FROM canon_chunk WHERE id = ?').get(chunk.chunk_id) as { seq: number } | undefined;
const sceneChunks = db.prepare(
  `SELECT id, text FROM canon_chunk WHERE project_id = ? AND seq BETWEEN ? AND ? ORDER BY seq`,
).all(project.id, (seqRow?.seq ?? 0) - 2, (seqRow?.seq ?? 0) + 2) as Array<{ id: number; text: string }>;
const sceneIds = sceneChunks.map((row) => Number(row.id));
const roster = db.prepare(
  `SELECT DISTINCT e.id, e.name, e.kind
     FROM canon_mention m JOIN canon_entity e ON e.id = m.entity_id
    WHERE m.project_id = ? AND m.chunk_id IN (${sceneIds.map(() => '?').join(', ')})`,
).all(project.id, ...sceneIds) as Array<{ id: number; name: string; kind: string }>;

const surfaces = [...new Set(mentions.map((mention) => mention.surface))];
const system = 'You resolve what a description refers to in a novel passage. '
  + 'Use only the passage and the list of entities present. If the passage does not make it clear, answer "unknown". '
  + 'Reply JSON only: {"entity":"a name from the list or unknown","reason":"one short sentence"}';
const user = `DESCRIPTION: ${JSON.stringify(surfaces.join(' / '))}\n\n`
  + `ENTITIES PRESENT: ${roster.map((entity) => `${entity.name} (${entity.kind})`).join(', ')}\n\n`
  + `PASSAGE (${chunk.locator}):\n${sceneChunks.map((row) => row.text).join('\n\n')}`;

const response = await fetch(`${baseUrl}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model,
    stream: false,
    format: 'json',
    options: { temperature: 0, seed: 42 },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }),
});
const data = await response.json() as { message?: { content?: string }; error?: string };
if (data.error) throw new Error(data.error);
const parsed = JSON.parse(String(data.message?.content ?? '{}')) as { entity?: string; reason?: string };
const entity = roster.find((candidate) => candidate.name.toLowerCase() === String(parsed.entity ?? '').toLowerCase().trim());

console.log(`cluster ${clusterId}: ${JSON.stringify(surfaces)} in ${chunk.locator}`);
console.log(`  answer: ${JSON.stringify(parsed.entity)} (${parsed.reason ?? ''})`);
console.log(`  candidates: ${roster.map((candidate) => candidate.name).join(', ')}`);
if (!entity) {
  console.log('  not linked: answer is not in the roster');
  process.exit(0);
}
console.log(`  linked to entity ${entity.id} ${entity.name}`);
if (!write) process.exit(0);
db.prepare('UPDATE canon_mention SET entity_id = ? WHERE project_id = ? AND cluster_id = ? AND entity_id IS NULL')
  .run(entity.id, project.id, clusterId);
console.log('  written');
