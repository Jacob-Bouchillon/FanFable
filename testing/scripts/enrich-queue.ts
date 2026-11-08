/**
 * Enrich a queue of names from a file, one at a time.
 *
 *   node --no-warnings testing/scripts/enrich-queue.ts --db <path> --project hp1 \
 *     --queue ~/fanfable-work/enrich-queue.txt [--limit 20] [--write]
 *
 * Without --write it only lists the queue. Each name goes through the same
 * owner path as `lore enrich`, so quotes and review status are unchanged.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Db } from '../../fanfable/src/core/db.ts';
import * as controller from '../../fanfable/src/plan/controller.ts';
import * as loreDiag from '../../fanfable/src/answer/lore-diagnostics.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = flag('db');
const projectName = flag('project');
const queuePath = flag('queue');
const limit = Number(flag('limit') ?? 0) || 0;
const passages = Number(flag('passages') ?? 8) || 8;
const model = flag('model');
const write = args.includes('--write');
if (!dbPath || !projectName || !queuePath) {
  console.error('usage: enrich-queue.ts --db <path> --project <name> --queue <file> [--limit n] [--write]');
  process.exit(2);
}
if (!existsSync(queuePath)) throw new Error(`queue not found: ${queuePath}`);

const names = readFileSync(queuePath, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, limit || undefined);
if (!write) {
  console.log(`${names.length} name(s) queued; nothing run (add --write)`);
  for (const name of names.slice(0, 20)) console.log('  ' + name);
  process.exit(0);
}

const db = new Db(dbPath);
const project = db.get<{ id: number; settings: unknown }>('SELECT id, settings FROM project WHERE name = ?', projectName);
if (!project) throw new Error(`project not found: ${projectName}`);
const settings = typeof project.settings === 'string' ? JSON.parse(project.settings) : project.settings;
const llm = controller.createClient({ ...(settings as object), ...(model ? { model } : {}) } as never);

const results: Array<{ name: string; relations: number; facts: number; passages: number; error?: string }> = [];
for (const name of names) {
  try {
    const result = await loreDiag.enrichEntity(db, llm, project.id, name, { maxPassages: passages });
    results.push({ name, relations: result.relations, facts: result.facts, passages: result.passages });
    console.log(`${name}: +${result.relations} ties, +${result.facts} facts from ${result.passages} passages`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ name, relations: 0, facts: 0, passages: 0, error: message });
    console.log(`${name}: failed (${message})`);
  }
}

const report = process.env.HOME + '/fanfable-work/enrich-report.json';
writeFileSync(report, JSON.stringify(results, null, 1));
console.log(`report: ${report}`);
db.close();
