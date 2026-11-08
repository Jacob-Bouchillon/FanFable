/**
 * Import BookNLP mentions into the evidence index.
 *
 *   node --no-warnings testing/scripts/import-mentions.ts --db <path> --project hp1 [--dir <booknlp dir>]
 *
 * Each mention becomes one canon_mention row in chunk coordinates, with its
 * BookNLP cluster and, where the cluster's surface matches a bank entity, that
 * entity's id. Re-running replaces the project's mentions.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Db } from '../../fanfable/src/core/db.ts';
import { runMigrations } from '../../fanfable/src/core/migrations.ts';
import { insertMention } from '../../fanfable/src/lorebook.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const projectName = flag('project');
const dir = flag('dir') ?? join(homedir(), 'fanfable-work', 'booknlp-hp1');
if (!dbPath || !projectName) {
  console.error('usage: import-mentions.ts --db <path> --project <name> [--dir <dir>]');
  process.exit(2);
}
for (const file of ['hp1.txt', 'hp1.entities', 'hp1.tokens', 'hp1.offsets.json']) {
  if (!existsSync(join(dir, file))) throw new Error(`missing ${file} in ${dir}`);
}

const db = new Db(dbPath);
runMigrations(db.raw);
const project = db.get<{ id: number }>('SELECT id FROM project WHERE name = ?', projectName);
if (!project) throw new Error(`project not found: ${projectName}`);

const text = readFileSync(join(dir, 'hp1.txt'), 'utf8');
const buffer = Buffer.from(text, 'utf8');
const byteToChar = new Uint32Array(buffer.length + 1);
let chars = 0;
for (let index = 0; index < buffer.length; index++) {
  byteToChar[index] = chars;
  if ((buffer[index]! & 0xc0) !== 0x80) chars++;
}
byteToChar[buffer.length] = chars;

const tokenSpan = new Map<number, [number, number]>();
for (const line of readFileSync(join(dir, 'hp1.tokens'), 'utf8').split('\n').slice(1)) {
  const columns = line.split('\t');
  if (columns.length < 8) continue;
  const id = Number(columns[3]);
  const onset = Number(columns[6]);
  const offset = Number(columns[7]);
  if (Number.isFinite(id) && Number.isFinite(onset) && Number.isFinite(offset)) tokenSpan.set(id, [onset, offset]);
}

const offsets = (JSON.parse(readFileSync(join(dir, 'hp1.offsets.json'), 'utf8')) as Array<{
  chunkId: number; mergedStart: number; skip: number; length: number;
}>).sort((left, right) => left.mergedStart - right.mergedStart);
const starts = offsets.map((offset) => offset.mergedStart);

function chunkFor(position: number): { chunkId: number; mergedStart: number; skip: number; length: number } | null {
  let low = 0;
  let high = starts.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (starts[mid]! <= position) { found = mid; low = mid + 1; } else high = mid - 1;
  }
  if (found < 0) return null;
  const offset = offsets[found]!;
  return position < offset.mergedStart + offset.length ? offset : null;
}

// entity forms, for resolving a cluster by its strongest proper name
const entities = db.all<{ id: number; name: string; aliases: string }>(
  'SELECT id, name, aliases FROM canon_entity WHERE project_id = ?',
  project.id,
);
const norm = (value: string) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const formsByEntity = new Map<number, string[]>();
const entityByForm = new Map<string, number>();
for (const entity of entities) {
  let aliases: string[] = [];
  try { aliases = JSON.parse(entity.aliases || '[]'); } catch { /* none */ }
  const forms = [entity.name, ...aliases].map(norm).filter(Boolean);
  formsByEntity.set(Number(entity.id), forms);
  for (const form of forms) {
    const existing = entityByForm.get(form);
    if (existing === undefined) entityByForm.set(form, Number(entity.id));
    else if (existing !== Number(entity.id)) entityByForm.set(form, -1); // ambiguous
  }
}

interface MentionRow { cluster: number; startToken: number; endToken: number; prop: string; cat: string; surface: string }
const mentions: MentionRow[] = [];
const clusterForms = new Map<number, Map<string, number>>();
for (const line of readFileSync(join(dir, 'hp1.entities'), 'utf8').split('\n').slice(1)) {
  const columns = line.split('\t');
  if (columns.length < 6) continue;
  const cluster = Number(columns[0]);
  if (!Number.isFinite(cluster)) continue;
  const prop = String(columns[3] ?? '');
  const surface = columns.slice(5).join('\t').trim();
  mentions.push({ cluster, startToken: Number(columns[1]), endToken: Number(columns[2]), prop, cat: String(columns[4] ?? ''), surface });
  if (prop === 'PROP') {
    const counts = clusterForms.get(cluster) ?? new Map<string, number>();
    counts.set(surface, (counts.get(surface) ?? 0) + 1);
    clusterForms.set(cluster, counts);
  }
}

const clusterEntity = new Map<number, number | null>();
for (const [cluster, counts] of clusterForms) {
  const best = [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
  const entityId = best ? entityByForm.get(norm(best)) : undefined;
  clusterEntity.set(cluster, entityId && entityId > 0 ? entityId : null);
}

db.run('DELETE FROM canon_mention WHERE project_id = ?', project.id);

let inserted = 0;
let resolved = 0;
let skipped = 0;
for (const mention of mentions) {
  const startSpan = tokenSpan.get(mention.startToken);
  const endSpan = tokenSpan.get(mention.endToken);
  if (!startSpan || !endSpan) { skipped++; continue; }
  const start = byteToChar[startSpan[0]]!;
  const end = byteToChar[endSpan[1]]!;
  if (end <= start) { skipped++; continue; }
  const chunk = chunkFor(start);
  if (!chunk || end > chunk.mergedStart + chunk.length) { skipped++; continue; }
  const entityId = clusterEntity.get(mention.cluster) ?? null;
  insertMention(db, project.id, {
    entityId,
    clusterId: mention.cluster,
    chunkId: chunk.chunkId,
    start: start - chunk.mergedStart + chunk.skip,
    end: end - chunk.mergedStart + chunk.skip,
    surface: mention.surface || text.slice(start, end),
    kind: mention.prop || 'PROP',
    method: 'booknlp',
  });
  inserted++;
  if (entityId) resolved++;
}

console.log(`mentions: ${inserted} inserted · ${resolved} linked to an entity · ${skipped} skipped (cross-boundary)`);
db.close();
