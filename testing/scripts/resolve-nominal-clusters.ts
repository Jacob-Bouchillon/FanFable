/**
 * Resolve nominal clusters (definite descriptions) with the model and the
 * scene roster.
 *
 *   node --no-warnings testing/scripts/resolve-nominal-clusters.ts --db <path> --project hp1 [--limit 20] [--write]
 *
 * Only clusters whose mentions are all NOM ("the snake", "the dark wizard")
 * are considered: pronouns are left for a later pass. The answer must be one of
 * the entities present in the scene, or "unknown".
 */
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const projectName = flag('project');
const baseUrl = flag('base-url') ?? 'http://127.0.0.1:11434';
const model = flag('model') ?? 'qwen3.5:9b';
const limit = Number(flag('limit') ?? 20) || 20;
const write = args.includes('--write');
const verify = args.includes('--verify');
if (!dbPath || !projectName) {
  console.error('usage: resolve-nominal-clusters.ts --db <path> --project <name> [--limit n] [--write]');
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: !write });
const project = db.prepare('SELECT id FROM project WHERE name = ?').get(projectName) as { id: number } | undefined;
if (!project) throw new Error(`project not found: ${projectName}`);

const clusters = db.prepare(
  `SELECT cluster_id, COUNT(*) n, SUM(CASE WHEN kind = 'NOM' THEN 1 ELSE 0 END) nominal
     FROM canon_mention
    WHERE project_id = ? AND entity_id IS NULL AND cluster_id IS NOT NULL
    GROUP BY cluster_id
   HAVING nominal = COUNT(*)
    ORDER BY n DESC
    LIMIT ?`,
).all(project.id, limit) as Array<{ cluster_id: number; n: number }>;

let linked = 0;
let unknown = 0;
let rejected = 0;
const rows: string[] = [];
for (const cluster of clusters) {
  const clusterId = Number(cluster.cluster_id);
  const mentions = db.prepare(
    `SELECT m.chunk_id, m.surface, c.seq, c.locator, c.text
       FROM canon_mention m JOIN canon_chunk c ON c.id = m.chunk_id
      WHERE m.project_id = ? AND m.cluster_id = ? ORDER BY m.id`,
  ).all(project.id, clusterId) as Array<{ chunk_id: number; surface: string; seq: number; locator: string; text: string }>;
  if (!mentions.length) continue;
  const first = mentions[0]!;
  const scene = db.prepare(
    'SELECT id, text FROM canon_chunk WHERE project_id = ? AND seq BETWEEN ? AND ? ORDER BY seq',
  ).all(project.id, first.seq - 1, first.seq + 1) as Array<{ id: number; text: string }>;
  const sceneIds = scene.map((row) => Number(row.id));
  const linkedRoster = db.prepare(
    `SELECT DISTINCT e.id, e.name, e.kind
       FROM canon_mention m JOIN canon_entity e ON e.id = m.entity_id
      WHERE m.project_id = ? AND m.chunk_id IN (${sceneIds.map(() => '?').join(', ')})`,
  ).all(project.id, ...sceneIds) as Array<{ id: number; name: string; kind: string }>;

  // An entity named in the scene belongs in the roster even before any of its
  // mentions is linked ("Hogwarts" is in the text but not yet in canon_mention).
  const sceneText = scene.map((row) => String(row.text)).join('\n').toLowerCase();
  const known = new Set(linkedRoster.map((entity) => Number(entity.id)));
  const named = db.prepare(
    'SELECT id, name, aliases, kind FROM canon_entity WHERE project_id = ? AND review_status <> \'quarantined\'',
  ).all(project.id) as Array<{ id: number; name: string; aliases: string; kind: string }>;
  const roster = [...linkedRoster];
  for (const entity of named) {
    if (known.has(Number(entity.id))) continue;
    let aliases: string[] = [];
    try { aliases = JSON.parse(entity.aliases || '[]'); } catch { /* none */ }
    const forms = [entity.name, ...aliases].filter((form) => form.length > 2);
    if (forms.some((form) => sceneText.includes(form.toLowerCase()))) {
      roster.push({ id: Number(entity.id), name: entity.name, kind: entity.kind });
      if (roster.length >= 25) break;
    }
  }
  if (roster.length < 2) continue;

  const surfaces = [...new Set(mentions.map((mention) => mention.surface))];
  const system = 'You resolve what a description refers to in a novel passage. '
    + 'Use only the passage and the list of entities present. If the passage does not make it clear, answer "unknown". '
    + 'Reply JSON only: {"entity":"a name from the list or unknown","reason":"one short sentence"}';
  const user = `DESCRIPTION: ${JSON.stringify(surfaces.join(' / '))}\n\n`
    + `ENTITIES PRESENT: ${roster.map((entity) => `${entity.name} (${entity.kind})`).join(', ')}\n\n`
    + `PASSAGE (${first.locator}):\n${scene.map((row) => row.text).join('\n\n')}`;

  let answer = 'unknown';
  let reason = '';
  const ask = async (passage: string) => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        think: false,
        options: { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 512 },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user.replace(/PASSAGE \([^)]*\):\n[\s\S]*$/, `PASSAGE:\n${passage}`) },
        ],
      }),
    });
    const data = await response.json() as { message?: { content?: string }; error?: string };
    if (data.error) throw new Error(data.error);
    return JSON.parse(String(data.message?.content ?? '{}')) as { entity?: string; reason?: string };
  };
  try {
    let parsed: { entity?: string; reason?: string };
    try {
      parsed = await ask(scene.map((row) => row.text).join('\n\n'));
    } catch {
      // Retry with the single chunk that holds the mention.
      parsed = await ask(first.text);
    }
    answer = String(parsed.entity ?? 'unknown');
    reason = String(parsed.reason ?? '');
  } catch (error) {
    rows.push(`${clusterId}: failed (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  const entity = roster.find((candidate) => candidate.name.toLowerCase() === answer.toLowerCase().trim());
  if (!entity) {
    unknown++;
    rows.push(`${clusterId}: ${JSON.stringify(surfaces)} -> unknown (${reason})`);
    console.log(`${clusterId}: ${JSON.stringify(surfaces)} -> unknown`);
    continue;
  }
  // The entity must be named in the scene. Otherwise the model is guessing
  // between lookalikes ("the forest" -> Black Forest, which is never here).
  const sceneLower = scene.map((row) => String(row.text)).join('\n').toLowerCase();
  const entityForms = (() => {
    const row = db.prepare('SELECT name, aliases FROM canon_entity WHERE id = ?').get(entity.id) as { name: string; aliases: string } | undefined;
    let aliases: string[] = [];
    try { aliases = JSON.parse(row?.aliases || '[]'); } catch { /* none */ }
    // A lowercase single word ("forest") is not distinctive: it is the head
    // noun of a description, not a name. Keep the entity's own name and any
    // alias that is a proper form.
    const usable = aliases.filter((alias) => alias.length > 2 && /[A-Z]/.test(alias));
    return [entity.name, ...usable].filter((form) => form.length > 2);
  })();
  if (!entityForms.some((form) => sceneLower.includes(form.toLowerCase()))) {
    unknown++;
    rows.push(`${clusterId}: ${JSON.stringify(surfaces)} -> ${entity.name} rejected (not named in the scene)`);
    console.log(`${clusterId}: ${JSON.stringify(surfaces)} -> ${entity.name} rejected (not named in scene)`);
    continue;
  }
  // Verification: a second, reasoning answer. The same model that chose can be
  // wrong; asked directly, with the sentence in front of it, it corrects.
  if (verify) {
    // JSON mode and thinking conflict in this model: the reasoning consumes the
    // budget and no JSON is emitted. Ask for one word instead.
    const question = `Does the description ${JSON.stringify(surfaces.join(' / '))} refer to ${entity.name} in this passage? `
      + 'Answer only YES or NO, using the passage alone.';
    try {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: true,
          options: { temperature: 0, seed: 42, num_ctx: 4096, num_predict: 1024 },
          messages: [
            { role: 'system', content: 'You check a reference against one passage. Use only the passage.' },
            { role: 'user', content: `${question}\n\nPASSAGE:\n${scene.map((row) => row.text).join('\n\n')}` },
          ],
        }),
      });
      const data = await response.json() as { message?: { content?: string }; error?: string };
      const answerText = String(data.message?.content ?? '').trim().toUpperCase();
      if (!answerText.startsWith('YES')) {
        rejected++;
        rows.push(`${clusterId}: ${JSON.stringify(surfaces)} -> ${entity.name} rejected by verification (${answerText.slice(0, 40)})`);
        console.log(`${clusterId}: ${JSON.stringify(surfaces)} -> ${entity.name} rejected by verification`);
        continue;
      }
    } catch (error) {
      rejected++;
      rows.push(`${clusterId}: ${JSON.stringify(surfaces)} -> ${entity.name} unverified (${error instanceof Error ? error.message : String(error)})`);
      console.log(`${clusterId}: ${JSON.stringify(surfaces)} -> ${entity.name} unverified`);
      continue;
    }
  }
  linked++;
  rows.push(`${clusterId}: ${JSON.stringify(surfaces)} -> ${entity.name} (${reason})`);
  console.log(`${clusterId}: ${JSON.stringify(surfaces)} -> ${entity.name}`);
  if (write) {
    db.prepare('UPDATE canon_mention SET entity_id = ? WHERE project_id = ? AND cluster_id = ? AND entity_id IS NULL')
      .run(entity.id, project.id, clusterId);
  }
}

console.log(`${clusters.length} nominal clusters · ${linked} linked · ${unknown} unknown · ${rejected} rejected by verification${write ? '' : ' (dry run)'}`);
for (const row of rows) console.log('  ' + row);
